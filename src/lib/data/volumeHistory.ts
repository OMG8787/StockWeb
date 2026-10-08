import { peekCached, writeCached } from "./cache";
import { getMarketStatus } from "@/lib/marketStatus";
import type { Candle, Market, Quote, VolumeTrend } from "./types";

/**
 * 近期每日成交量歷史——用來算「今日量 vs 這檔股票自己近期均量」的價量關係推論
 * （見 types.ts 的 SearchItem.volumeTrend 完整說明：這是傳統技術分析的價量關係
 * 經驗法則，不是真實委買委賣單成交量統計）。
 *
 * 刻意不對搜尋清單裡每一檔股票（TW 約 800 檔、US 約 150 檔）各打一次歷史K線
 * API——那樣在這個規模下會是明顯的額外上游負擔，等同重現 PROGRESS.md 記錄過的
 * TPEx 炸開問題。改成完全「零額外上游請求」的作法：每次批次報價快取
 * （fetchMarketQuoteMap，見 index.ts）重新計算時，piggyback 記錄一次「今天收盤
 * 後」的成交量快照，長期累積出自己的近20個交易日成交量歷史，不需要另外呼叫任何
 * 歷史資料 API，也不需要另外的 cron 排程——warm-cache 既有的 5 分鐘排程本來就會
 * 讓 fetchMarketQuoteMap 在收盤後被重新計算到，順便就記錄了。
 */

// 跟 lib/signals.ts 的「爆量/量縮」訊號用同一個 20 個交易日窗口，維持全站對
// 「近期均量」只有一套定義。
const HISTORY_DAYS = 20;

// 這個歷史至少要累積幾天才夠拿來當比較基準，跟 signals.ts 的爆量訊號要求
// `priorVolumes.length >= 5` 完全一致——資料不足就不下判斷，不用假設值湊數。
export const MIN_HISTORY_DAYS_FOR_AVERAGE = 5;

// 跟 lib/signals.ts 「爆量」訊號用同一個門檻（今日量 ≥ 均量的 2 倍），維持全站
// 對「成交量明顯高於自身均量」只有一套認定標準，不另外發明一個不一致的數字。
const VOLUME_SPIKE_RATIO = 2;

interface VolumeHistoryBlob {
  /** 最後一次記錄的交易日期（該市場當地時區的 YYYY-MM-DD），防止同一天被
   *  warm-cache cron 的多次觸發重複記錄。 */
  lastRecordedDate: string;
  bySymbol: Record<string, number[]>;
}

// 遠長於 20 個交易日的視窗，避免正常使用情境下歷史被 TTL 意外沖掉；真的超過
// 這麼久沒有任何請求觸發過 fetchMarketQuoteMap，資料本來也已經沒有意義。
const HISTORY_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function historyKey(market: Market): string {
  return `volume-history:${market}:v1`;
}

const TIME_ZONE: Record<Market, string> = { TW: "Asia/Taipei", US: "America/New_York" };

function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function localWeekday(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return WEEKDAYS.indexOf(wd);
}

/**
 * 收盤後（且是平日）才記錄——避免把盤中還在累積、尚未收盤定案的成交量誤記成
 * 「當天最終量」污染歷史。只過濾週末，不是完整的國定假日行事曆（TWSE/TPEx公休日
 * 沒有免費公開的行事曆可查，跟 marketStatus.ts 記載的既有限制一樣）：真正遇到平日
 * 國定假日時，上游資料本來就會「維持上一個交易日的收盤價量不變」，最多只是把同一
 * 個真實數字重複記一次，不是假資料，只是精度上的已知小瑕疵（會讓那一天的均量略微
 * 失真），已誠實記錄在 PROGRESS.md，沒有用來源不明的假日表硬湊。
 */
export async function maybeRecordDailyVolumeSnapshot(market: Market, quoteMap: Map<string, Quote>): Promise<void> {
  try {
    if (quoteMap.size === 0) return;
    if (getMarketStatus(market) !== "closed") return;
    const tz = TIME_ZONE[market];
    const now = new Date();
    const weekday = localWeekday(now, tz);
    if (weekday === 0 || weekday === 6) return;
    const today = localDateKey(now, tz);

    const key = historyKey(market);
    const existing = (await peekCached<VolumeHistoryBlob>(key)) ?? { lastRecordedDate: "", bySymbol: {} };
    if (existing.lastRecordedDate === today) return;

    const bySymbol: Record<string, number[]> = { ...existing.bySymbol };
    for (const [symbol, quote] of quoteMap) {
      const prior = bySymbol[symbol] ?? [];
      bySymbol[symbol] = [...prior, quote.volume].slice(-HISTORY_DAYS);
    }
    await writeCached(key, { lastRecordedDate: today, bySymbol } satisfies VolumeHistoryBlob, HISTORY_TTL_MS);
  } catch (err) {
    // 記錄歷史失敗絕不能拖垮搜尋/報價本身——沿用全站「快取層永遠 fail open」的原則。
    console.error(`[volumeHistory] failed to record snapshot for ${market}:`, err);
  }
}

/**
 * 一次性回填：直接用每檔股票「自己的」歷史K線（本站個股頁本來就查得到、涵蓋好幾個月）
 * 的每日成交量，取代「等 warm-cache 每天收盤後 piggyback 記一筆、要等
 * MIN_HISTORY_DAYS_FOR_AVERAGE 個真實交易日才有均量可用」這個冷啟動等待期。
 * 使用者反映「現在也能查到前幾筆資料，為什麼還要等5天」——這個回填就是直接把
 * 這些「現在就查得到」的資料拿來用，不用再乾等。
 *
 * 只在一次性回填端點（/api/cron/backfill-volume-history）被觸發，不是常態排程；
 * 回填完成後，既有的 `maybeRecordDailyVolumeSnapshot` 收盤後 piggyback 機制會
 * 自然接續往後每天累積，兩者不衝突。
 *
 * 刻意排除「今天」這個交易日的K線（如果剛好抓到）：避免跟 piggyback 機制今天
 * 收盤後要記錄的那一筆重複算兩次，把同一天的量灌水進均量。
 */
export async function backfillVolumeHistoryFromCandles(
  market: Market,
  candlesBySymbol: Map<string, Candle[]>
): Promise<{ seeded: number }> {
  const tz = TIME_ZONE[market];
  const today = localDateKey(new Date(), tz);
  const key = historyKey(market);
  const existing = (await peekCached<VolumeHistoryBlob>(key)) ?? { lastRecordedDate: "", bySymbol: {} };
  const bySymbol: Record<string, number[]> = { ...existing.bySymbol };

  let seeded = 0;
  for (const [symbol, candles] of candlesBySymbol) {
    const volumes = candles
      .filter((c) => c.time !== today && c.volume > 0)
      .slice(-HISTORY_DAYS)
      .map((c) => c.volume);
    if (volumes.length === 0) continue;
    // 已經有夠長真實歷史的股票（表示 piggyback 機制已經正常運作一段時間了）
    // 不覆蓋，避免用K線資料的些微精度差異（例如零股撮合方式不同）取代掉已經
    // 累積的真實每日快照。
    if ((bySymbol[symbol]?.length ?? 0) >= HISTORY_DAYS) continue;
    bySymbol[symbol] = volumes;
    seeded++;
  }

  await writeCached(key, { lastRecordedDate: existing.lastRecordedDate, bySymbol } satisfies VolumeHistoryBlob, HISTORY_TTL_MS);
  return { seeded };
}

/**
 * 讀取近期平均成交量 map（唯讀，peekCached：沒有快取就回空 map，不會觸發任何
 * 計算或上游請求——比對照的批次報價 fetch 便宜得多）。少於 MIN_HISTORY_DAYS_FOR_AVERAGE
 * 天歷史的股票不會出現在回傳的 map 裡。
 */
export async function getTrailingAverageVolumeMap(market: Market): Promise<Map<string, number>> {
  const blob = await peekCached<VolumeHistoryBlob>(historyKey(market));
  const result = new Map<string, number>();
  if (!blob) return result;
  for (const [symbol, history] of Object.entries(blob.bySymbol)) {
    if (history.length < MIN_HISTORY_DAYS_FOR_AVERAGE) continue;
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    if (avg > 0) result.set(symbol, avg);
  }
  return result;
}

/**
 * 價量關係推論——見 types.ts 的 SearchItem.volumeTrend 完整說明：傳統技術分析的
 * 「價漲量增／價跌量增」經驗法則，不是真實委買委賣單成交量分類。
 */
export function computeVolumeTrend(changePercent: number, volumeRatio: number | undefined): VolumeTrend {
  if (volumeRatio === undefined || volumeRatio < VOLUME_SPIKE_RATIO) return "neutral";
  if (changePercent > 0) return "buy-leaning";
  if (changePercent < 0) return "sell-leaning";
  return "neutral";
}

/** 由「今日量/均量比」+「今日漲跌方向」一次算出 SearchItem 需要的兩個欄位，
 *  給 searchStocks()/getMultiSignalStocks() 共用，避免兩處各自重寫一次。 */
export function computeVolumeMetrics(
  changePercent: number,
  volume: number,
  avgVolume: number | undefined
): { volumeRatio?: number; volumeTrend: VolumeTrend } {
  const volumeRatio = avgVolume !== undefined && avgVolume > 0 ? volume / avgVolume : undefined;
  return { volumeRatio, volumeTrend: computeVolumeTrend(changePercent, volumeRatio) };
}

/**
 * 完整的每日成交量歷史（股票篩選用：5 日均量、當週、當月）。
 * days 是舊到新、最後一筆是 lastRecordedDate 那天；沒有日期，週／月用「最近幾個交易日」估算。
 */
export async function getVolumeHistory(market: Market): Promise<{ lastRecordedDate: string; bySymbol: Record<string, number[]> } | null> {
  return (await peekCached<VolumeHistoryBlob>(historyKey(market))) ?? null;
}

