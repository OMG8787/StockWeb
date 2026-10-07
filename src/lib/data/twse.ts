import { twQuarterlyEpsPeriodLabel } from "./earningsLabel";
import { chunk, fetchWithTimeout, mapWithConcurrency } from "./cache";
import { sanitizeCandles } from "./candleSanity";
import { parseMonthlyRevenueRow, type MonthlyRevenueRow } from "./monthlyRevenue";
import { NO_TRADE_MID_ESTIMATE_NOTE } from "./types";
import type { Candle, ChartRange, Chips, Earnings, Fundamentals, MaterialAnnouncement, Quote, TwDailyBar } from "./types";
import { findInUniverse, type UniverseEntry } from "./universe";
import { isTwQuoteWindow } from "@/lib/pollingSchedule";

// TWSE (Taiwan Stock Exchange) public data endpoints. No API key required.
// - Real-time-ish quote (delayed): mis.twse.com.tw "getStockInfo"
// - Daily OHLC history: www.twse.com.tw "STOCK_DAY"
// Both are unofficial-but-widely-used public JSON endpoints. They may be
// unreachable from sandboxed/offline environments; callers treat any
// failure as "data unavailable" (see lib/data/index.ts) rather than
// fabricating a substitute value.

interface MisRow {
  c: string; // code
  n: string; // name
  z: string; // current price, "-" if no trade yet today
  y: string; // previous close
  o: string; // open
  h: string; // high
  l: string; // low
  v: string; // 累積成交量，單位是「張」（1 張 = 1000 股），需乘 1000 才能跟 STOCK_DAY 的股數對齊
  b?: string; // 揭示買價，最多 5 檔、以 "_" 分隔，第一檔是目前最佳買價
  a?: string; // 揭示賣價，最多 5 檔、以 "_" 分隔，第一檔是目前最佳賣價
  // 最近一筆實際成交（時間+價格），漲跌停鎖住時最可靠的「目前價格」來源——
  // 見下方 rowToQuote 內的說明。
  trade?: { z?: string };
  // 這筆資料所屬的交易日（YYYYMMDD）。非交易時段判斷 MIS 資料可不可信靠它，
  // 見 pollingSchedule.ts 的 classifyTwQuoteTradeDate()。
  d?: string;
  // 最近一筆成交的時間：t＝台北時間 "HH:MM:SS"，tlong＝epoch 毫秒（字串）。
  t?: string;
  tlong?: string;
}

/**
 * MIS 一列的「上游資料時間」（ISO）：優先用 tlong（epoch 毫秒），沒有才用 `d`＋`t`（台北時間）組。
 * 兩者都沒有或不合理（非有限數、早於 2020 年、晚於現在 5 分鐘以上）就回 undefined——寧可不顯示，
 * 也不顯示錯的資料時間。twse.ts／tpex.ts 共用。
 */
export function misTradeTimeIso(row: { d?: string; t?: string; tlong?: string }, now: number = Date.now()): string | undefined {
  let ms = row.tlong && /^\d{10,}$/.test(row.tlong) ? Number(row.tlong) : NaN;
  if (!Number.isFinite(ms) && row.d && /^\d{8}$/.test(row.d) && row.t && /^\d{1,2}:\d{2}:\d{2}$/.test(row.t)) {
    const [h, m, s] = row.t.split(":");
    ms = Date.parse(`${row.d.slice(0, 4)}-${row.d.slice(4, 6)}-${row.d.slice(6, 8)}T${h.padStart(2, "0")}:${m}:${s}+08:00`);
  }
  if (!Number.isFinite(ms) || ms < Date.parse("2020-01-01T00:00:00Z") || ms > now + 5 * 60_000) return undefined;
  return new Date(ms).toISOString();
}

/**
 * MIS getStockInfo 的請求網址（上市／上櫃／指數共用，tpex.ts 也用這個）。`exCh` 是 "tse_2330.tw|otc_6488.tw" 這種
 * 管線分隔清單。帶 `_=<現在毫秒>` 跟 MIS 官方網頁一致（2026-10-06 在正式站實測：有無這個參數、
 * 瀏覽器 UA、session cookie 回的資料完全相同，**落後不是快取造成的**，見 fetchMisRows）。
 */
export function misQuoteUrl(exCh: string, now: number = Date.now()): string {
  return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${now}`;
}

/**
 * MIS 回應裡「這份快照是幾點的」（queryTime.sysDate＋sysTime，台北時間）→ epoch 毫秒；缺值回 undefined。
 */
export function misSnapshotMs(data: { queryTime?: { sysDate?: string; sysTime?: string } }): number | undefined {
  const { sysDate, sysTime } = data.queryTime ?? {};
  if (!sysDate || !sysTime || !/^\d{8}$/.test(sysDate) || !/^\d{1,2}:\d{2}:\d{2}$/.test(sysTime)) return undefined;
  const [h, m, s] = sysTime.split(":");
  const ms = Date.parse(`${sysDate.slice(0, 4)}-${sysDate.slice(4, 6)}-${sysDate.slice(6, 8)}T${h.padStart(2, "0")}:${m}:${s}+08:00`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 2026-10-06 使用者「盤中報價不夠即時」追查的第二層根因：MIS 後端有多台節點，**資料新舊不一**。
 * 在正式站函式內直接連打 MIS（2317，每次 `_` 都不同）：同一支股票，09:57:24 回 sysTime 09:57:18，
 * 09:57:54 卻回 sysTime 09:56:02（比上一次還舊、落後 112 秒）；有無 `_`、瀏覽器 UA、session cookie 結果相同，
 * 所以不是我們或 CDN 的快取，是打到落後的節點。對策：只在盤中、只對「指定幾檔」的請求（單檔、關注清單批次，
 * 不含全市場 40 塊）——回應快照時間比「這個 instance 看過最新的 MIS 快照」落後超過 STALE_TOLERANCE_MS 時，
 * 立刻再打（最多 MIS_STALE_RETRIES 次、間隔 MIS_STALE_RETRY_GAP_MS），挑快照最新的那份回傳。
 * 不會因此無限重打：重試次數有上限，且只有「確定落後」才重試。
 */
const MIS_STALE_TOLERANCE_MS = 15_000;
const MIS_STALE_RETRIES = 2;
const MIS_STALE_RETRY_GAP_MS = 250;
/**
 * 連續撮合時段（開盤後 1 分鐘～收盤前 5 分鐘）內，快照比現在落後超過這麼久就視為落後節點
 * （不需要參考任何歷史：冷啟動的 instance 第一次請求就打到落後節點時也能擋）。健康節點實測
 * 落後現在 0~20 秒；13:25 之後與 09:01 之前快照可能暫停更新，不套用這條。
 */
const MIS_WALL_CLOCK_STALE_MS = 35_000;
function inContinuousTrading(ms: number): boolean {
  if (!isTwQuoteWindow(new Date(ms))) return false;
  const taipei = new Date(ms + 8 * 3_600_000);
  const minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
  return minutes >= 9 * 60 + 1 && minutes <= 13 * 60 + 25;
}
/**
 * 2026-10-07 盤中實驗（正式站 Vercel 函式內 12 種請求變體 × 多輪）的根因：MIS 後端**依 ex_ch 字串各自快取一份快照**，
 * 同一字串重打回同一份舊快照（快照年齡中位 46 秒、最大 100+ 秒）；`_` 時間戳、UA、Referer、session cookie、
 * delay、no-cache header、http 皆無影響。在 ex_ch 末端加一個隨機的不存在代號（rows 不會回傳該代號）＝
 * 唯一快取鍵，每次都拿到剛產生的快照（快照年齡≈0，成交資料年齡中位 46→約 14 秒）。
 * 只用在「指定幾檔」的請求（useGuard）；全市場表維持穩定字串，避免 40 塊全部繞過後端快取。
 */
export function withUniqueMisKey(exCh: string): string {
  return `${exCh}|tse_9${Math.floor(1000 + Math.random() * 9000)}.tw`;
}

/** 這個 instance 看過最新的 MIS 快照時間（跨請求共用）。 */
let freshestMisSnapshotMs = 0;

/** 測試用：重置模組內的「最新快照」記憶。 */
export function resetMisSnapshotMemory(): void {
  freshestMisSnapshotMs = 0;
}

/**
 * 抓 MIS 一個 ex_ch 清單的列。`retryStale` 為 true 且在盤中時，遇到落後的節點會重打並挑最新快照。
 * 失敗（逾時、HTTP 錯誤）照舊往外丟，由呼叫端處理。
 */
export async function fetchMisRows<T = MisRow>(
  exCh: string,
  timeoutMs: number,
  opts: { retryStale?: boolean } = {}
): Promise<T[]> {
  const startedAt = Date.now();
  const useGuard = opts.retryStale === true && isTwQuoteWindow(new Date(startedAt));
  let best: { rows: T[]; snapshot: number } | undefined;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(misQuoteUrl(useGuard ? withUniqueMisKey(exCh) : exCh), timeoutMs, {
      headers: { Referer: "https://mis.twse.com.tw/stock/index.jsp" },
    });
    const data = (await res.json()) as { msgArray?: T[]; queryTime?: { sysDate?: string; sysTime?: string } };
    const rows = data.msgArray ?? [];
    const snapshot = misSnapshotMs(data);
    if (snapshot === undefined) return rows; // 沒有快照時間：沒辦法判斷新舊，照用
    if (!best || snapshot > best.snapshot) best = { rows, snapshot };
    freshestMisSnapshotMs = Math.max(freshestMisSnapshotMs, snapshot);
    const behind =
      freshestMisSnapshotMs - best.snapshot > MIS_STALE_TOLERANCE_MS ||
      (inContinuousTrading(Date.now()) && Date.now() - best.snapshot > MIS_WALL_CLOCK_STALE_MS);
    // 已經耗掉大半逾時額度就不再重打（輪詢請求最多等 6 秒）。
    const tooSlow = Date.now() - startedAt > timeoutMs / 2;
    if (!useGuard || !behind || attempt >= MIS_STALE_RETRIES || tooSlow) return best.rows;
    await new Promise((r) => setTimeout(r, MIS_STALE_RETRY_GAP_MS));
  }
}

/** MIS 的 `d`（YYYYMMDD）→ ISO 日期；格式不對就 undefined。twse.ts/tpex.ts 共用。 */
export function misDateToIso(d: string | undefined): string | undefined {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : undefined;
}

/** First (best) price out of MIS's "_"-separated bid/ask depth string. */
function bestDepthPrice(depth: string | undefined): number | undefined {
  if (!depth) return undefined;
  const value = parseFloat(depth.split("_")[0]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function rowToQuote(row: MisRow): Quote | null {
  const prevClose = parseFloat(row.y);
  if (!Number.isFinite(prevClose)) return null; // no real data at all for this code — not a real listed stock

  // `z` (last trade) sits at "-" for most stocks most of the time — TWSE
  // only updates it when a trade actually prints, which for anything but
  // the most liquid names can mean long stretches with no update even
  // while the bid/ask book keeps moving. Falling back straight to
  // yesterday's close (as this used to) made ~90% of stocks read a flat
  // 0.00% all session and let the displayed price sit outside the
  // (correctly live-updating) high/low range. The midpoint of the current
  // best bid/ask is a live, TWSE-sourced approximation of where the stock
  // actually is trading right now.
  //
  // Confirmed live: a stock locked at its 漲停/跌停 (limit up/down) price can
  // hit BOTH fallbacks at once — top-level `z` blanks to "-" right in the
  // gap between prints, AND the opposite side of the book is empty (e.g.
  // limit-up: no one is willing to sell, so `a` reads "-") while the
  // remaining side's best entry can itself be a "0.0000" sentinel that
  // `bestDepthPrice` correctly rejects (`value > 0`) — so `bid`/`ask` are
  // BOTH undefined too, and this used to fall all the way through to
  // `prevClose`, misreporting a stock genuinely locked +10% as a flat 0%
  // change (caught live on 驊宏資/6148 while it was limit-up-locked).
  // `trade.z` — the last actually-executed trade — stays populated through
  // exactly this gap, so it's tried before resorting to the bid/ask
  // midpoint, which is only a live *approximation* anyway.
  let last = parseFloat(row.z);
  if (!Number.isFinite(last) || row.z === "-" || row.z === "") {
    const tradeLast = row.trade?.z ? parseFloat(row.trade.z) : NaN;
    if (Number.isFinite(tradeLast) && tradeLast > 0) {
      last = tradeLast;
    } else {
      const bid = bestDepthPrice(row.b);
      const ask = bestDepthPrice(row.a);
      last = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? prevClose;
    }
  }
  const change = last - prevClose;
  const known = findInUniverse(row.c, "TW");
  // MIS's v is in 張 (board lots); STOCK_DAY's 成交股數 (used for chart
  // volume) is in raw shares. Normalize to shares here so a stock's
  // headline volume and its chart's volume bars are the same unit and
  // don't disagree by 1000x.
  const volumeShares = (parseInt(row.v, 10) || 0) * 1000;

  return {
    symbol: row.c,
    market: "TW",
    name: row.n || known?.name || row.c,
    price: round2(last),
    change: round2(change),
    changePercent: prevClose ? round2((change / prevClose) * 100) : 0,
    open: round2(parseFloat(row.o) || last),
    high: round2(parseFloat(row.h) || last),
    low: round2(parseFloat(row.l) || last),
    prevClose: round2(prevClose),
    volume: volumeShares,
    currency: "TWD",
    updatedAt: new Date().toISOString(),
    // 今天一張都沒成交的冷門股，上面算出來的 last/change 其實是委買賣中價
    // 估算，不是真的成交價變動——沒有這個註記，畫面/AI會把估算值講成好像
    // 真的漲跌過。見 NO_TRADE_MID_ESTIMATE_NOTE 定義處的說明。
    priceNote: volumeShares === 0 ? NO_TRADE_MID_ESTIMATE_NOTE : undefined,
    tradeDate: misDateToIso(row.d),
    tradeTime: misTradeTimeIso(row),
  };
}

export async function fetchTwseQuote(stockNo: string): Promise<Quote> {
  const rows = await fetchMisRows<MisRow>(`tse_${stockNo}.tw`, 4000, { retryStale: true });
  const row = rows[0];
  const quote = row && rowToQuote(row);
  if (!quote) throw new Error(`No TWSE quote for ${stockNo}`);
  return quote;
}

/**
 * MIS supports querying many stocks in one request via a pipe-separated
 * ex_ch list. Listing pages (search/highlights/homepage movers) were each
 * calling fetchTwseQuote() per stock — 20+ concurrent requests to an
 * endpoint meant for single-stock lookups, which tends to get rate-limited
 * or time out under that load and silently fall back to mock data for the
 * whole list. One batched request is far more likely to actually succeed.
 *
 * Now that the universe can run into the low hundreds of stocks (see
 * getTwUniverse in ./universe), a single request would build an
 * enormous query string, so the symbol list is chunked into a handful of
 * parallel requests instead of one unbounded one. Kept well under what
 * MIS has been observed to accept in one request — better to fire a few
 * more small parallel chunks than risk one oversized request getting
 * truncated or rejected outright.
 */
const QUOTE_BATCH_CHUNK_SIZE = 50;

/**
 * 同時最多幾塊在飛。原本是無上限的 `Promise.all(chunks.map(...))`，也就是一次
 * 全市場報價更新就對 `mis.twse.com.tw` 開約 22 個同時連線；`tpex.ts` 的
 * `fetchTpexQuotesBatch()` 打的是**同一台主機**、又同時開約 18 個
 * （兩者在 `marketQuoteMap.ts` 裡是並行的），合計約 40 個。
 *
 * 2026-09-21 追查「`/api/indices` 間歇性獨缺 TAIEX」時實測確認：MIS 被併發量
 * 惹到時不會回 429，而是靜默關掉連線（Node 端 `fetch failed / other side
 * closed`）或直接卡到逾時，而且會把來源 IP 短暫封鎖數分鐘——夾在同一波併發裡
 * 送出的單檔 t00 查詢因此常常是被丟掉的那一個。完整根因見
 * `marketIndices.ts` 的 `getIndices()` 說明。
 *
 * 這個上限套用在**每一個呼叫端**，所以 TWSE+TPEx 同時跑時真正的天花板是
 * 兩倍（16 個），不是 8 個——刻意用兩個獨立的 `mapWithConcurrency` 而不是一個
 * 跨檔案的共用號誌，是為了不讓全市場批次把「使用者正在看的那一檔個股報價」
 * 也一起排隊卡住。16 相對於原本的 40 已經是 2.5 倍的收斂，而分波送出對這個
 * 端點的實測總耗時影響很小（每塊本來就是幾百毫秒等級）。
 *
 * 這也跟這個檔案裡 `MONTH_FETCH_CONCURRENCY`、以及 `cache.ts` 的
 * `mapWithConcurrency()` 說明所寫的同一個原則一致：對單一上游無上限扇出，
 * 正是會把整站連坐拖進限流的那種行為。
 */
export const MIS_BATCH_CONCURRENCY = 8;

/** `retryStale`：只有「指定幾檔」的呼叫端（關注清單）開，全市場表不開（40 塊重打會變成請求風暴），見 fetchMisRows。 */
export async function fetchTwseQuotesBatch(stockNos: string[], opts: { retryStale?: boolean } = {}): Promise<Map<string, Quote>> {
  const map = new Map<string, Quote>();
  if (stockNos.length === 0) return map;

  const chunks = chunk(stockNos, QUOTE_BATCH_CHUNK_SIZE);
  const results = await mapWithConcurrency(chunks, MIS_BATCH_CONCURRENCY, async (group) => {
    const chExpr = group.map((s) => `tse_${s}.tw`).join("|");
    try {
      return await fetchMisRows<MisRow>(chExpr, 6000, opts);
    } catch {
      return [];
    }
  });
  for (const row of results.flat()) {
    const quote = rowToQuote(row);
    if (quote) map.set(row.c, quote);
  }
  return map;
}

interface StockDayAllRow {
  Date: string; // ROC compact, e.g. "1151002"
  Code: string;
  TradeVolume: string; // 股
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
}

/**
 * 上市全市場「最近一個交易日」盤後日行情（openapi STOCK_DAY_ALL，一次約 1,400 檔、
 * 約 320KB）。數字跟 STOCK_DAY 日K逐值相同（2026-10-04 實測 2330：開 2505／高 2515／
 * 低 2495／收 2500／量 15,792,206 股）。只在非交易時段 MIS 資料不可信時才會用到，
 * 見 twOffHoursQuote.ts。沒有成交（收盤價空白）的列略過。
 */
export async function fetchTwseDailyBarsAll(): Promise<Map<string, TwDailyBar>> {
  const res = await fetchWithTimeout("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", 8000);
  const rows = (await res.json()) as StockDayAllRow[];
  const map = new Map<string, TwDailyBar>();
  for (const row of rows) {
    const close = parseTwseNumber(row.ClosingPrice);
    const open = parseTwseNumber(row.OpeningPrice);
    const high = parseTwseNumber(row.HighestPrice);
    const low = parseTwseNumber(row.LowestPrice);
    const change = parseTwseNumber(row.Change);
    if (!row.Code || !row.Date || close == null || close <= 0 || open == null || high == null || low == null || change == null) continue;
    map.set(row.Code.trim(), {
      date: rocCompactToIso(row.Date),
      open,
      high,
      low,
      close,
      prevClose: round2(close - change),
      volume: parseInt(row.TradeVolume.replace(/,/g, ""), 10) || 0,
    });
  }
  return map;
}

interface FmtqikRow {
  Date: string; // ROC compact, e.g. "1151002"
  TAIEX: string;
  Change: string;
}

/**
 * 加權指數「最近一個交易日」官方收盤（openapi FMTQIK，本月每日市場成交資訊，一次幾十列、
 * 幾 KB）。只在非交易時段 MIS t00 不可信時用到，見 twOffHoursQuote.ts 的
 * reconcileTaiexQuote()。取最後一列（最新交易日）；格式不對就 throw。
 */
export async function fetchTaiexLatestClose(): Promise<{ date: string; close: number; prevClose: number }> {
  const res = await fetchWithTimeout("https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK", 8000);
  const rows = (await res.json()) as FmtqikRow[];
  const last = rows
    .filter((r) => r.Date && parseTwseNumber(r.TAIEX) != null && parseTwseNumber(r.Change) != null)
    .sort((a, b) => a.Date.localeCompare(b.Date))
    .at(-1);
  if (!last) throw new Error("FMTQIK returned no usable rows");
  const close = parseTwseNumber(last.TAIEX)!;
  return { date: rocCompactToIso(last.Date), close, prevClose: round2(close - parseTwseNumber(last.Change)!) };
}

const RANGE_MONTHS: Partial<Record<ChartRange, number>> = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24, "5y": 60, "10y": 120 };
// 5d/10d are day-COUNT ranges, not month ranges — trimmed by candle count
// after fetching, not by a date cutoff (see fetchTwseCandles below).
const RANGE_DAYS: Partial<Record<ChartRange, number>> = { "5d": 5, "10d": 10 };
// A 10-year chart means 120 monthly requests to TWSE's STOCK_DAY endpoint
// for one stock — firing all of those at once (the previous unbounded
// Promise.all, fine for the old max of 12 months/1y) would hit TWSE with
// 120 simultaneous connections from a single page load. Bounded instead,
// the same mapWithConcurrency pattern already used for momentum screening's
// per-candidate chart fetch (see index.ts's MOMENTUM_CHART_CONCURRENCY) — a
// long-range chart is a deliberate, infrequent user action, so it taking a
// few extra seconds is an acceptable trade for not hammering the upstream.
const MONTH_FETCH_CONCURRENCY = 10;
// 5y/10y 一次要打 61~121 個月份請求，只要其中任何一個失敗整張圖就是 null——正式站
// （Vercel 出口 IP）實測 2330 5y 連續好幾分鐘回 503，但同時間本機直連 TWSE 61 個月
// 全部成功，代表是個別月份請求被限流/逾時、不是資料問題。兩層補強：
// ①單月請求失敗自動重試（最多3次、帶隨機退避），長區間並行數也降到 6，降低被限流機率；
// ②已經收盤的歷史月份資料不會再變，成功抓到的月份存進同一個實例的記憶體（30分鐘），
//   下一次請求（含失敗後重試）只需要補沒抓到的月份，進度會累積、越試越容易成功。
const LONG_RANGE_MONTH_CONCURRENCY = 6;
const MONTH_RETRY_ATTEMPTS = 3;
const CLOSED_MONTH_CACHE_TTL_MS = 30 * 60_000;
const CLOSED_MONTH_CACHE_MAX = 900;
const closedMonthCache = new Map<string, { candles: Candle[]; expiresAt: number }>();

interface StockDayResponse {
  stat: string;
  data?: string[][];
}

/**
 * "Today" in Taipei, which is the calendar TWSE dates its data by. The
 * server runs in UTC, so between 00:00 and 08:00 Taipei time a plain
 * `new Date()` is still on the previous day — and on the 1st of a month
 * that means the current month is never even requested, silently dropping
 * the newest trading day from every TW chart during those hours.
 */
function taipeiToday(): { year: number; month: number; day: number } {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" })
    .format(new Date())
    .split("-")
    .map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}

/** `months` before the given day, clamped so e.g. 3/31 minus one month is
 *  2/28 rather than rolling forward into March the way setMonth() would. */
function monthsBefore(year: number, month: number, day: number, months: number): string {
  const lastDayOfTarget = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 - months, Math.min(day, lastDayOfTarget)))
    .toISOString()
    .slice(0, 10);
}

export async function fetchTwseCandles(stockNo: string, range: ChartRange): Promise<Candle[]> {
  const { year, month, day } = taipeiToday();

  const days = RANGE_DAYS[range];
  if (days != null) {
    // Day-count ranges just need "enough recent months to be sure we have
    // `days` trading days", then trimmed by count — TWSE has no trading-
    // calendar endpoint to compute an exact date cutoff from, but 2 months
    // comfortably covers 10 trading days even across a run of holidays.
    const cursor = new Date(Date.UTC(year, month - 1, 1));
    const monthParams = Array.from({ length: 2 }, () => {
      const p = `${cursor.getUTCFullYear()}${pad(cursor.getUTCMonth() + 1)}01`;
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
      return p;
    });
    const monthly = await mapWithConcurrency(monthParams, MONTH_FETCH_CONCURRENCY, (p) => fetchMonthResilient(stockNo, p));
    const merged = monthly.flat().sort((a, b) => a.time.localeCompare(b.time));
    if (merged.length === 0) throw new Error(`No TWSE candles for ${stockNo}`);
    return merged.slice(-days);
  }

  const months = RANGE_MONTHS[range] ?? 3;

  // STOCK_DAY only serves whole calendar months, so asking for exactly
  // `months` of them yields a window that is short by however far into the
  // current month we are: on the 3rd of a month the "1個月" chart was
  // 2 trading days long (and computeSignals needs 5 bars, so the technical
  // signals silently vanished too). Fetch one extra month back and trim to
  // the real trailing window, so "1個月" is always about a month of data
  // regardless of what day it is.
  const cursor = new Date(Date.UTC(year, month - 1, 1));
  const monthParams = Array.from({ length: months + 1 }, () => {
    const p = `${cursor.getUTCFullYear()}${pad(cursor.getUTCMonth() + 1)}01`;
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    return p;
  });

  const cutoffIso = monthsBefore(year, month, day, months);

  const monthly = await mapWithConcurrency(
    monthParams,
    months > 24 ? LONG_RANGE_MONTH_CONCURRENCY : MONTH_FETCH_CONCURRENCY,
    (p) => fetchMonthResilient(stockNo, p)
  );
  const merged = monthly
    .flat()
    .filter((c) => c.time >= cutoffIso)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (merged.length === 0) throw new Error(`No TWSE candles for ${stockNo}`);
  return merged;
}

/** dateParam 是 YYYYMM01；比台北時間「本月」更早的月份才算已收盤、資料不會再變。 */
function isClosedMonth(dateParam: string): boolean {
  const { year, month } = taipeiToday();
  return dateParam.slice(0, 6) < `${year}${pad(month)}`;
}

async function fetchMonthResilient(stockNo: string, dateParam: string): Promise<Candle[]> {
  const closed = isClosedMonth(dateParam);
  const key = `${stockNo}:${dateParam}`;
  if (closed) {
    const hit = closedMonthCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.candles;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < MONTH_RETRY_ATTEMPTS; attempt++) {
    try {
      const candles = await fetchMonth(stockNo, dateParam);
      if (closed) {
        if (closedMonthCache.size >= CLOSED_MONTH_CACHE_MAX) {
          const oldest = closedMonthCache.keys().next().value;
          if (oldest !== undefined) closedMonthCache.delete(oldest);
        }
        closedMonthCache.set(key, { candles, expiresAt: Date.now() + CLOSED_MONTH_CACHE_TTL_MS });
      }
      return candles;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1) + Math.random() * 250));
    }
  }
  throw lastErr;
}

async function fetchMonth(stockNo: string, dateParam: string): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${stockNo}`;
  const res = await fetchWithTimeout(url, 5000);
  const data = (await res.json()) as StockDayResponse;
  if (data.stat !== "OK" || !data.data) return [];
  // 只有零星/鉅額成交、沒有一般交易開高低收的日子，STOCK_DAY 回 "--" → NaN；
  // sanitizeCandles 整根略過（不編造價格），見 candleSanity.ts 說明。
  return sanitizeCandles(
    data.data.map((row) => {
      const [rocDate, , , open, high, low, close] = row;
      return {
        time: rocToIso(rocDate),
        open: parseFloat(open.replace(/,/g, "")),
        high: parseFloat(high.replace(/,/g, "")),
        low: parseFloat(low.replace(/,/g, "")),
        close: parseFloat(close.replace(/,/g, "")),
        volume: parseInt(row[1].replace(/,/g, ""), 10) || 0,
      };
    })
  );
}

interface BwibbuRow {
  Code: string;
  Name: string;
  PEratio: string;
  DividendYield: string;
  PBratio: string;
}

/**
 * TWSE's official (not the unofficial MIS one) open-data endpoint for
 * 本益比/殖利率/股價淨值比 — one request covers every listed stock, so
 * this is fetched and cached once rather than per symbol. No market cap
 * in this dataset (would need shares-outstanding data TWSE doesn't expose
 * this simply); the fundamentals card just omits it for TW.
 */
export async function fetchTwseFundamentalsAll(): Promise<Map<string, Fundamentals>> {
  const url = "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL";
  const res = await fetchWithTimeout(url, 8000);
  const rows = (await res.json()) as BwibbuRow[];
  const map = new Map<string, Fundamentals>();
  for (const row of rows) {
    const peRatio = parseFloat(row.PEratio);
    const dividendYield = parseFloat(row.DividendYield);
    const pbRatio = parseFloat(row.PBratio);
    map.set(row.Code, {
      peRatio: Number.isFinite(peRatio) && peRatio > 0 ? peRatio : undefined,
      dividendYield: Number.isFinite(dividendYield) && dividendYield > 0 ? dividendYield : undefined,
      pbRatio: Number.isFinite(pbRatio) && pbRatio > 0 ? pbRatio : undefined,
    });
  }
  return map;
}

interface InstitutionalTradingResponse {
  stat: string;
  date?: string; // "20260911", already western calendar (not ROC)
  fields?: string[];
  data?: string[][];
}

function parseTwseNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 三大法人（外資、投信、自營商）買賣超日報 — TWSE 官方網站本身查價頁面在用的
 * 端點（不在 v1 OpenAPI 清單裡，但一樣是免費、不需金鑰、公開的 JSON），單位是
 * 股（hints 欄位標明「單位：股」，不是「張」，跟下面融資融券的張數不同單位，
 * 使用時要分開標示避免混淆）。一次回傳全市場，所以整包快取一次、依代號查表，
 * 不對每檔股票各打一次。
 */
export async function fetchTwseInstitutionalTradingAll(
  queryDate?: string,
  selectType: "ALL" | "ALLBUT0999" = "ALL"
): Promise<Map<string, Chips>> {
  // queryDate：YYYYMMDD，查指定交易日（個股歷史脈絡用，見 chipsHistory.ts）；不帶＝最新一天。
  // selectType：ALL 含權證（實測約 2.4MB）；ALLBUT0999 不含權證（約 190KB），只需要股票/ETF 時用它。
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${queryDate ?? ""}&selectType=${selectType}`;
  const res = await fetchWithTimeout(url, 8000);
  const payload = (await res.json()) as InstitutionalTradingResponse;
  const map = new Map<string, Chips>();
  if (payload.stat !== "OK" || !payload.data || !payload.fields) return map;

  const fields = payload.fields;
  const idx = (name: string) => fields.indexOf(name);
  const iCode = idx("證券代號");
  const iForeignExclDealer = idx("外陸資買賣超股數(不含外資自營商)");
  const iForeignDealer = idx("外資自營商買賣超股數");
  const iTrust = idx("投信買賣超股數");
  const iDealer = idx("自營商買賣超股數");
  const iTotal = idx("三大法人買賣超股數");
  const date = payload.date && payload.date.length === 8
    ? `${payload.date.slice(0, 4)}-${payload.date.slice(4, 6)}-${payload.date.slice(6, 8)}`
    : undefined;
  if (iCode === -1) return map;

  for (const row of payload.data) {
    const code = row[iCode]?.trim();
    if (!code) continue;
    const foreignExclDealer = parseTwseNumber(row[iForeignExclDealer]);
    const foreignDealer = parseTwseNumber(row[iForeignDealer]);
    const foreignNetShares =
      foreignExclDealer != null || foreignDealer != null ? (foreignExclDealer ?? 0) + (foreignDealer ?? 0) : undefined;
    map.set(code, {
      date,
      foreignNetShares,
      trustNetShares: parseTwseNumber(row[iTrust]),
      dealerNetShares: parseTwseNumber(row[iDealer]),
      institutionalNetShares: parseTwseNumber(row[iTotal]),
    });
  }
  return map;
}

interface MarginTradingResponse {
  stat?: string;
  date?: string;
  tables?: Array<{ fields?: string[]; data?: string[][] }>;
}

/**
 * 融資融券餘額 — 單位是「張」（TWSE 原始資料本來就是張數，不是股數，跟上面三大
 * 法人的股數單位不同）。同樣一次回傳全市場，整包快取後依代號查表。
 *
 * 2026-09-30 從 openapi.twse.com.tw/v1/exchangeReport/MI_MARGN 改成官網 rwd 版：
 * openapi 版沒有資料日期，而且實測晚上 22:37 還停在前一個交易日（rwd 版已經是
 * 當天），跟 TPEx 那邊（當天）日期對不齊；rwd 版有 `date`、也有算「融資使用率」
 * 需要的「次一營業日限額」（融資、融券各一個，分別算融資／融券使用率）。rwd 表格的欄位名稱融資/融券兩組重複（前日餘額、
 * 今日餘額、次一營業日限額各出現兩次），所以融資取第一次出現、融券取最後一次。
 */
export async function fetchTwseMarginTradingAll(queryDate?: string): Promise<Map<string, Chips>> {
  // queryDate：YYYYMMDD，查指定交易日（個股歷史脈絡用，見 chipsHistory.ts）；不帶＝最新一天。
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${queryDate ?? ""}&selectType=ALL`;
  const res = await fetchWithTimeout(url, 10_000);
  const payload = (await res.json()) as MarginTradingResponse;
  const map = new Map<string, Chips>();
  if (payload.stat !== "OK" || !payload.tables) return map;
  const table = payload.tables.find((t) => t.fields?.[0] === "代號" && Array.isArray(t.data));
  if (!table?.fields || !table.data) return map;
  const f = table.fields;
  const iCode = 0;
  const iMarginPrev = f.indexOf("前日餘額");
  const iMargin = f.indexOf("今日餘額");
  const iMarginQuota = f.indexOf("次一營業日限額");
  const iShortPrev = f.lastIndexOf("前日餘額");
  const iShort = f.lastIndexOf("今日餘額");
  // 融券限額＝第二次出現的「次一營業日限額」；只出現一次（欄位缺）時不能拿融資限額頂替。
  const iShortQuota = f.lastIndexOf("次一營業日限額");
  if ([iMarginPrev, iMargin, iShortPrev, iShort].includes(-1) || iShort === iMargin) return map;
  const marginDate =
    payload.date && payload.date.length === 8
      ? `${payload.date.slice(0, 4)}-${payload.date.slice(4, 6)}-${payload.date.slice(6, 8)}`
      : undefined;

  for (const row of table.data) {
    const code = row[iCode]?.trim();
    if (!code) continue;
    const marginBalance = parseTwseNumber(row[iMargin]);
    const marginPrev = parseTwseNumber(row[iMarginPrev]);
    const shortBalance = parseTwseNumber(row[iShort]);
    const shortPrev = parseTwseNumber(row[iShortPrev]);
    map.set(code, {
      marginBalance,
      marginBalanceChange: marginBalance != null && marginPrev != null ? marginBalance - marginPrev : undefined,
      shortBalance,
      shortBalanceChange: shortBalance != null && shortPrev != null ? shortBalance - shortPrev : undefined,
      marginQuota: iMarginQuota === -1 ? undefined : parseTwseNumber(row[iMarginQuota]),
      shortQuota: iShortQuota === -1 || iShortQuota === iMarginQuota ? undefined : parseTwseNumber(row[iShortQuota]),
      marginDate,
    });
  }
  return map;
}

interface MaterialAnnouncementRow {
  公司代號: string;
  發言日期: string; // ROC compact date, e.g. "1150910"
  // TWSE's actual JSON key has a trailing space ("主旨 ", confirmed by
  // fetching the live endpoint) — without accounting for that, row["主旨"]
  // is always undefined and every single announcement gets silently
  // filtered out below as "no subject", making this feature look like it
  // works (no errors, valid Map) while actually returning nothing for
  // every stock, every day.
  "主旨 ": string;
}

/**
 * 上市公司每日重大訊息公告（併購、增資、法說會、股務異動等）— TWSE OpenAPI。
 * 每天只收錄最近一個交易日全市場的公告（通常一兩百筆），大多數股票當天完全
 * 沒有公告是正常現象，不代表資料抓取失敗。
 */
export async function fetchTwseMaterialAnnouncementsAll(): Promise<Map<string, MaterialAnnouncement[]>> {
  const url = "https://openapi.twse.com.tw/v1/opendata/t187ap04_L";
  const res = await fetchWithTimeout(url, 8000);
  const rows = (await res.json()) as MaterialAnnouncementRow[];
  const map = new Map<string, MaterialAnnouncement[]>();
  for (const row of rows) {
    const code = row.公司代號?.trim();
    if (!code || !row.發言日期) continue;
    const subject = row["主旨 "]?.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!subject) continue;
    const list = map.get(code) ?? [];
    list.push({ date: rocCompactToIso(row.發言日期), subject });
    map.set(code, list);
  }
  return map;
}

/** ROC compact date ("1150910") -> ISO ("2026-09-10"). Distinct from rocToIso
 *  below, which parses the "/"-separated ROC date STOCK_DAY uses. */
function rocCompactToIso(roc: string): string {
  if (roc.length < 5) return roc;
  const year = parseInt(roc.slice(0, -4), 10) + 1911;
  const month = roc.slice(-4, -2);
  const day = roc.slice(-2);
  return `${year}-${month}-${day}`;
}

/**
 * TWSE's official monthly revenue open-data endpoint — the single most
 * commonly watched "財報" figure for TW retail investors (公布得比季報快
 * 很多), specifically the year-over-year growth rate. One request covers
 * every listed company for the latest reported month.
 */
export async function fetchTwseMonthlyRevenueAll(): Promise<Map<string, Earnings>> {
  const url = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
  const res = await fetchWithTimeout(url, 8000);
  const rows = (await res.json()) as MonthlyRevenueRow[];
  const map = new Map<string, Earnings>();
  for (const row of rows) {
    const parsed = parseMonthlyRevenueRow(row);
    if (parsed && row.公司代號) map.set(row.公司代號, parsed);
  }
  return map;
}

interface QuarterlyIncomeRow {
  公司代號: string;
  年度: string;
  季別: string;
  "基本每股盈餘（元）": string;
}

/**
 * TWSE's official quarterly comprehensive-income-statement open-data
 * endpoint — covers general/manufacturing industry companies (`_ci`
 * suffix); TWSE publishes separate report codes for banks/insurers with a
 * different statement shape, not covered here. A company missing from this
 * dataset (financial-sector or otherwise) simply has no quarterly-EPS entry
 * merged in — never a fabricated number.
 */
export async function fetchTwseQuarterlyEpsAll(): Promise<Map<string, Earnings>> {
  const url = "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci";
  const res = await fetchWithTimeout(url, 8000);
  const rows = (await res.json()) as QuarterlyIncomeRow[];
  const map = new Map<string, Earnings>();
  for (const row of rows) {
    const eps = parseFloat(row["基本每股盈餘（元）"]);
    if (!row.公司代號 || !Number.isFinite(eps)) continue;
    map.set(row.公司代號, {
      quarterlyEps: round2(eps),
      quarterlyEpsPeriod: twQuarterlyEpsPeriodLabel(row.年度, row.季別),
    });
  }
  return map;
}

interface CompanyRow {
  公司代號: string;
  公司簡稱: string;
  產業別: string;
}

/**
 * t187ap03_L's 產業別 field is TWSE's own two-digit industry classification
 * *code* (e.g. "01"), not the category name, even though it comes back as a
 * string that looks like it could be either — confirmed by cross-checking
 * real symbols against this table (e.g. 1101 台泥/1102 亞泥/1103 嘉泥, all
 * cement companies, all coded "01"). Maps to the official category names
 * per TWSE's 上市公司產業類別劃分暨調整要點. An unrecognized code (a new
 * category TWSE adds later) falls back to "未分類" rather than showing the
 * raw code.
 */
// Exported (and named market-neutrally) because tpex.ts reuses this same
// table for TPEx's company listing — Taiwan's official industry
// classification is shared across TWSE/TPEx per the 上市上櫃公司產業類別劃分
// 及調整要點, confirmed live by cross-checking real TPEx symbols (e.g. 6488
// 環球晶 codes as "24", matching this table's 半導體業).
export const TW_INDUSTRY_NAMES: Record<string, string> = {
  "01": "水泥工業",
  "02": "食品工業",
  "03": "塑膠工業",
  "04": "紡織纖維",
  "05": "電機機械",
  "06": "電器電纜",
  "08": "玻璃陶瓷",
  "09": "造紙工業",
  "10": "鋼鐵工業",
  "11": "橡膠工業",
  "12": "汽車工業",
  "13": "電子工業",
  "14": "建材營造業",
  "15": "航運業",
  "16": "觀光事業",
  "17": "金融保險業",
  "18": "貿易百貨業",
  "19": "綜合",
  "20": "其他業",
  "21": "化學工業",
  "22": "生技醫療業",
  "23": "油電燃氣業",
  "24": "半導體業",
  "25": "電腦及週邊設備業",
  "26": "光電業",
  "27": "通信網路業",
  "28": "電子零組件業",
  "29": "電子通路業",
  "30": "資訊服務業",
  "31": "其他電子業",
  "32": "文化創意業",
  "33": "農業科技業",
  "34": "電子商務業",
  "35": "綠能環保業",
  "36": "數位雲端業",
  "37": "運動休閒業",
  "38": "居家生活業",
  "80": "存託憑證",
};

/**
 * TWSE's official open-data endpoint for every listed (上市) company's
 * basic profile — code, short name, industry category. Used to build the
 * full TW stock universe instead of a small hand-curated list (see
 * getTwUniverse in ./universe). Real official metadata; a company missing
 * here just won't appear in search/rankings, it never gets a made-up entry.
 */
export async function fetchTwseListedCompanies(): Promise<UniverseEntry[]> {
  const url = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
  const res = await fetchWithTimeout(url, 8000);
  const rows = (await res.json()) as CompanyRow[];
  return rows
    .filter((r) => r.公司代號 && r.公司簡稱)
    .map((r) => {
      const code = r.產業別?.trim() ?? "";
      return {
        symbol: r.公司代號.trim(),
        market: "TW" as const,
        name: r.公司簡稱.trim(),
        sector: TW_INDUSTRY_NAMES[code] ?? "未分類",
        currency: "TWD",
        exchange: "TWSE" as const,
      };
    });
}

function rocToIso(roc: string): string {
  const [y, m, d] = roc.split("/").map((n) => parseInt(n, 10));
  return `${y + 1911}-${pad(m)}-${pad(d)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
