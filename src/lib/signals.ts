import type { Candle, ChartRange } from "@/lib/data/types";
import { computeMacdLines, MACD_MIN_BARS } from "@/lib/ema";
import {
  detectNearCross,
  KD_NEAR_CROSS_CONVERGING_DAYS,
  KD_NEAR_CROSS_MAX_EST_DAYS,
  KD_NEAR_CROSS_MAX_GAP,
  MACD_NEAR_CROSS_CONVERGING_DAYS,
  MACD_NEAR_CROSS_MAX_EST_DAYS,
  type NearCrossReading,
} from "@/lib/nearCross";
import { currentKdMethod, kdFromRsv, type KdMethod } from "@/lib/kdFormula";

export interface Signal {
  label: string;
  tone: "up" | "down" | "neutral";
}

const RANGE_LABEL: Record<ChartRange, string> = {
  // Never actually reached — StockChart.tsx skips calling computeSignals()
  // entirely for "today" (see its own comment for why: every signal here is
  // defined in terms of daily bars). Present only so this Record stays
  // exhaustive over ChartRange.
  today: "當日",
  "5d": "5日",
  "10d": "10日",
  "1m": "1個月",
  "3m": "3個月",
  "6m": "6個月",
  "1y": "1年",
  "2y": "2年",
  "5y": "5年",
  "10y": "10年",
};

function trailingAverage(closes: number[], period: number): number {
  const window = closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** 5/10/20-day moving averages stacked in trend order — "bullish" when
 *  5-day > 10-day > 20-day, "bearish" when the order is fully reversed. */
function computeMaAlignment(candles: Candle[]): "bullish" | "bearish" | null {
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const ma5 = trailingAverage(closes, 5);
  const ma10 = trailingAverage(closes, 10);
  const ma20 = trailingAverage(closes, 20);
  if (ma5 > ma10 && ma10 > ma20) return "bullish";
  if (ma5 < ma10 && ma10 < ma20) return "bearish";
  return null;
}

/**
 * 從最新一根K棒往回數，連續同方向（上漲或下跌）的天數——回傳「任何長度」
 * （包含0、1、2天），不像 computeSignals 裡的「連漲/跌」訊號只在 >=3 天才
 * 顯示。獨立匯出這個函式是因為 AI 問答需要誠實回答「剛漲一天」「連漲兩天」
 * 這類問法，如果只能拿到 computeSignals 篩選過、門檻 3 天以上才會出現的
 * 訊號，天生就沒辦法回答門檻以下的天數，會被誤判成「沒有資料」。
 */
export function computeStreak(candles: Candle[]): { days: number; direction: "up" | "down" | null } {
  let days = 0;
  let direction: "up" | "down" | null = null;
  for (let i = candles.length - 1; i > 0; i--) {
    const change = candles[i].close - candles[i - 1].close;
    const dir = change > 0 ? "up" : change < 0 ? "down" : null;
    if (dir === null) break;
    if (direction === null) direction = dir;
    if (dir !== direction) break;
    days++;
  }
  return { days, direction };
}

/**
 * Purely descriptive, objective technical signals computed from OHLCV data
 * already on the page — no recommendation, no "buy/sell" language. Each
 * signal states an observable fact (volume vs its own average, price vs its
 * own recent range) so the reader draws their own conclusion.
 */
export function computeSignals(candles: Candle[], currentPrice: number, range: ChartRange): Signal[] {
  if (candles.length < 5) return [];
  const signals: Signal[] = [];
  const rangeLabel = RANGE_LABEL[range];

  // Volume vs its own trailing average (excludes the latest bar).
  const latest = candles[candles.length - 1];
  const priorVolumes = candles.slice(Math.max(0, candles.length - 21), candles.length - 1).map((c) => c.volume);
  if (priorVolumes.length >= 5) {
    const avgVolume = priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length;
    if (avgVolume > 0) {
      const ratio = latest.volume / avgVolume;
      if (ratio >= 2) signals.push({ label: `爆量（${ratio.toFixed(1)}倍均量）`, tone: "up" });
      else if (ratio <= 0.5) signals.push({ label: "量縮", tone: "neutral" });
    }
  }

  // Price vs the high/low of the currently-loaded window.
  const windowHigh = Math.max(...candles.map((c) => c.high));
  const windowLow = Math.min(...candles.map((c) => c.low));
  if (currentPrice >= windowHigh) signals.push({ label: `創${rangeLabel}新高`, tone: "up" });
  else if (currentPrice <= windowLow) signals.push({ label: `創${rangeLabel}新低`, tone: "down" });

  // Price vs 20-day moving average.
  const ma20Window = candles.slice(-20);
  if (ma20Window.length >= 10) {
    const ma20 = ma20Window.reduce((a, c) => a + c.close, 0) / ma20Window.length;
    if (currentPrice > ma20) signals.push({ label: "站上20日均線", tone: "up" });
    else if (currentPrice < ma20) signals.push({ label: "跌破20日均線", tone: "down" });
  }

  // Moving-average alignment (多頭/空頭排列) — a different question from the
  // single "price vs MA20" signal above: whether the short/mid/longer
  // averages are THEMSELVES stacked in trend order (5-day above 10-day
  // above 20-day, or the reverse), which is the standard way to read
  // "is the trend structure itself aligned across timeframes" rather than
  // just "where does today's price sit relative to one average."
  const maAlignment = computeMaAlignment(candles);
  if (maAlignment === "bullish") signals.push({ label: "均線多頭排列（5日線在10日線、10日線在20日線之上）", tone: "up" });
  else if (maAlignment === "bearish") signals.push({ label: "均線空頭排列（5日線在10日線、10日線在20日線之下）", tone: "down" });

  // Consecutive up/down days (from the most recent bar backwards).
  const { days: streak, direction } = computeStreak(candles);
  if (streak >= 3 && direction) {
    signals.push({ label: `連${direction === "up" ? "漲" : "跌"} ${streak} 天`, tone: direction });
  }

  // RSI (14-period, simple average of gains/losses — not Wilder-smoothed,
  // consistent with the simple-average MA20 above rather than mixing
  // smoothing methods within the same signal set).
  const rsi = computeRSI(candles, 14);
  if (rsi != null) {
    if (rsi >= 70) signals.push({ label: `RSI ${rsi.toFixed(0)}（超買區）`, tone: "up" });
    else if (rsi <= 30) signals.push({ label: `RSI ${rsi.toFixed(0)}（超賣區）`, tone: "down" });
  }

  // MACD golden/death cross: only fires the day the 12/26-EMA MACD line
  // actually crosses its 9-EMA signal line, not every day it happens to sit
  // above/below it (which would just restate "上漲/下跌" already covered by
  // the MA20 and streak signals above). Also reports whether the cross
  // happened above or below the zero line — standard MACD reading (a golden
  // cross above zero, where the MACD line is already net-positive, reads as
  // a stronger confirmation than one below zero/"低檔"; symmetrically for a
  // death cross) that a flat golden/death label was previously discarding.
  const macd = computeMacdCross(candles);
  if (macd?.type === "golden") {
    signals.push({
      label: macd.aboveZero ? "MACD黃金交叉（0軸上方，訊號較明確）" : "MACD黃金交叉（0軸下方，屬低檔訊號，力道較弱）",
      tone: "up",
    });
  } else if (macd?.type === "death") {
    signals.push({
      label: macd.aboveZero ? "MACD死亡交叉（0軸上方，訊號較明確）" : "MACD死亡交叉（0軸下方，屬續跌訊號，力道較弱）",
      tone: "down",
    });
  }

  // Bollinger Bands (20-period SMA ± 2 standard deviations of that same
  // window) — price touching its own trailing band is self-referential
  // (compares the stock to its own recent volatility, not a fixed threshold
  // that would mean different things for a quiet blue-chip vs a volatile
  // small-cap), so this stays consistent with the rest of this file's
  // "compare to itself" approach. Deliberately not adding a "band squeeze"
  // (narrow-width) signal: what counts as "narrow" only makes sense relative
  // to a stock's own historical band width, which needs a longer lookback
  // than what's reliably available here — a single cross-stock width
  // threshold would be exactly the kind of false-precision this codebase
  // avoids elsewhere.
  const bollinger = computeBollingerSignal(candles, currentPrice);
  if (bollinger) signals.push(bollinger);

  // KD (stochastic oscillator, 9,3,3) — like MACD above, only fires on the
  // day %K actually crosses %D, never on the days it merely sits above/below
  // it (which would be true most days and say nothing).
  //
  // 2026-09-16：原本這裡還多加了一層「只有在超賣(K<=30)/超買(K>=70)極端區
  // 發生的交叉才算數」的限制，中間區間的交叉被整個丟掉。實測發現這造成一個
  // 真實問題：使用者問「有沒有MACD與KD都黃金交叉的股票」，市場上明明有（例如
  // 當天的嘉基6715：K從44.2上穿D 47.8，同時MACD也黃金交叉），本站卻因為
  // K=51.4 落在中間區間而完全不產生任何 KD 訊號，AI 只好回答「沒有」——
  // 對使用者而言「KD黃金交叉」就是 K 上穿 D，低檔與否是強弱的形容詞、不是
  // 這個訊號存不存在的門檻。改成比照上面 MACD 的做法：交叉一律標示出來，
  // 用括號說明它發生在哪個區間、力道強弱如何，把判讀資訊交給讀者，而不是
  // 先幫讀者把訊號整個丟掉。
  const kd = computeKd(candles);
  if (kd?.cross === "golden") signals.push({ label: KD_CROSS_LABEL.golden[kd.zone], tone: "up" });
  else if (kd?.cross === "death") signals.push({ label: KD_CROSS_LABEL.death[kd.zone], tone: "down" });

  return signals;
}

/** KD 交叉的文字標籤：交叉方向 × 發生區間。低檔黃金/高檔死亡是教科書上最
 *  標準的兩種讀法，其餘四種組合照實描述它實際的意義與風險，不含糊帶過。 */
const KD_CROSS_LABEL: Record<"golden" | "death", Record<KdZone, string>> = {
  golden: {
    low: "KD低檔黃金交叉（超賣區轉強，訊號較明確）",
    mid: "KD黃金交叉（K值上穿D值，發生在中間區間，力道一般）",
    high: "KD高檔黃金交叉（K值上穿D值，但已在超買區，追高風險較高）",
  },
  death: {
    low: "KD低檔死亡交叉（K值下穿D值，已在超賣區，屬弱勢續跌）",
    mid: "KD死亡交叉（K值下穿D值，發生在中間區間，力道一般）",
    high: "KD高檔死亡交叉（超買區轉弱，訊號較明確）",
  },
};

function computeBollingerSignal(candles: Candle[], currentPrice: number): Signal | null {
  const PERIOD = 20;
  if (candles.length < PERIOD) return null;
  const window = candles.slice(-PERIOD).map((c) => c.close);
  const mean = window.reduce((a, b) => a + b, 0) / PERIOD;
  const variance = window.reduce((a, c) => a + (c - mean) ** 2, 0) / PERIOD;
  const stdDev = Math.sqrt(variance);
  const upper = mean + 2 * stdDev;
  const lower = mean - 2 * stdDev;
  if (currentPrice >= upper) return { label: "觸及布林通道上緣（波動放大）", tone: "up" };
  if (currentPrice <= lower) return { label: "觸及布林通道下緣（波動放大）", tone: "down" };
  return null;
}

/**
 * RSV = (close − trailing-9 low) / (trailing-9 high − trailing-9 low) × 100，
 * 再平滑成 K、D。**預設算法＝台灣券商／看盤軟體慣用的遞迴版（K＝2/3×前K＋1/3×RSV、D 同理，初值 50）**，
 * 舊的「3 日簡單平均兩次」版保留為 method="sma"。算法與預設的唯一來源見 lib/kdFormula.ts。
 */
export type KdZone = "low" | "mid" | "high";

export interface KdReading {
  /** 今日 %K */
  k: number;
  /** 今日 %D */
  d: number;
  prevK: number;
  prevD: number;
  /** 只有在「今天」發生交叉才不是 null（K 上穿 D＝golden，下穿＝death）。 */
  cross: "golden" | "death" | null;
  /** 今日 %K 落在哪一區：<=30 超賣、>=70 超買、其餘中間。 */
  zone: KdZone;
}

const KD_PERIOD = 9;
const KD_SMOOTH = 3;

/**
 * KD 的完整 %K／%D 序列（只含有效值）。兩個序列的**最後一個元素都是最新交易日**，
 * dSeries 只是前面比 kSeries 短（需要多 SMOOTH-1 天暖機），從尾端對齊即可同日配對。
 * 根數不足時回 null。computeKd（今日交叉）與「即將交叉」判斷共用這一份計算。
 */
function computeKdSeries(
  candles: Candle[],
  method: KdMethod = currentKdMethod()
): { kSeries: number[]; dSeries: number[] } | null {
  const PERIOD = KD_PERIOD;
  const SMOOTH = KD_SMOOTH;
  if (candles.length < PERIOD + SMOOTH * 2) return null;

  const rawK = candles.map((c, i) => {
    if (i < PERIOD - 1) return null;
    const window = candles.slice(i - PERIOD + 1, i + 1);
    const highestHigh = Math.max(...window.map((w) => w.high));
    const lowestLow = Math.min(...window.map((w) => w.low));
    const range = highestHigh - lowestLow;
    return range > 0 ? ((c.close - lowestLow) / range) * 100 : 50;
  });
  const validRawK = rawK.filter((v): v is number => v !== null);
  const { k: kSeries, d: dSeries } = kdFromRsv(validRawK, method);
  return { kSeries, dSeries };
}

export function computeKd(candles: Candle[], method: KdMethod = currentKdMethod()): KdReading | null {
  const series = computeKdSeries(candles, method);
  if (!series) return null;
  const { kSeries, dSeries } = series;

  if (kSeries.length < 2 || dSeries.length < 2) return null;
  // Both series' *last* entries land on the same (most recent) trading day —
  // dSeries is derived from kSeries but is only shorter at the front (it
  // needs an extra SMOOTH-1 days of kSeries before it can start), so
  // indexing from the end keeps same-day values paired without extra offset
  // math: kSeries[len-1]/dSeries[len-1] is "today", [len-2] is "yesterday".
  const lastK = kSeries[kSeries.length - 1];
  const prevK = kSeries[kSeries.length - 2];
  const lastD = dSeries[dSeries.length - 1];
  const prevD = dSeries[dSeries.length - 2];
  if (lastK === undefined || prevK === undefined || lastD === undefined || prevD === undefined) return null;

  const cross = prevK <= prevD && lastK > lastD ? "golden" : prevK >= prevD && lastK < lastD ? "death" : null;
  const zone: KdZone = lastK <= 30 ? "low" : lastK >= 70 ? "high" : "mid";
  return { k: lastK, d: lastD, prevK, prevD, cross, zone };
}

/** Simple (non-Wilder-smoothed) RSI over the trailing `period` closes. */
function computeRSI(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (gains === 0 && losses === 0) return null;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/**
 * Detects whether the MACD line (EMA12 − EMA26) crossed its EMA9 signal
 * line on the most recent bar. Needs enough bars for EMA26 to have actually
 * converged before treating the signal line as meaningful — with too few
 * bars this is just comparing early warm-up noise.
 */
function computeMacdCross(candles: Candle[]): { type: "golden" | "death" | null; aboveZero: boolean } | null {
  if (candles.length < MACD_MIN_BARS) return null;
  const { macdLine, signalLine } = computeMacdLines(candles.map((c) => c.close));
  const last = macdLine.length - 1;
  const prevMacd = macdLine[last - 1];
  const prevSignal = signalLine[last - 1];
  const macd = macdLine[last];
  const signal = signalLine[last];
  // SMA 種子下前面幾根本來就沒有有效值；根數不足時老實回 null，不要拿
  // undefined/NaN 去比大小（那會靜默地變成「沒有交叉」）。
  if (macd == null || signal == null || prevMacd == null || prevSignal == null) return null;
  // Whether the MACD line itself (not just the cross) sits above or below
  // zero — the conventional reading treats a cross above zero as a stronger
  // confirmation than the same cross happening below it (see the signals.ts
  // call site for the full explanation).
  const aboveZero = macd >= 0;
  if (prevMacd <= prevSignal && macd > signal) return { type: "golden", aboveZero };
  if (prevMacd >= prevSignal && macd < signal) return { type: "death", aboveZero };
  // 沒有交叉時仍然回傳 aboveZero（type 為 null）——「MACD 線在 0 軸上方/下方」
  // 本身就是一個獨立、每天都成立的多空狀態，多重指標篩選會用到；只有在 K 線
  // 根數不足、整個 MACD 都算不出來時才回傳 null。
  return { type: null, aboveZero };
}

/**
 * 同一組 K 線算出來的「原始指標狀態」，跟 computeSignals() 的差別在於：
 * computeSignals 回傳的是**已經篩選過、只留下有觸發的**中文標籤陣列，適合
 * 直接顯示在畫面上；這個函式回傳的是**每個指標當下的實際狀態值**（有沒有
 * 交叉、K/D 各是多少、RSI 幾點、均線是什麼排列），讓呼叫端可以用程式邏輯
 * 做「多重條件同時成立」的篩選。
 *
 * 會需要這個函式，是因為使用者要求「AI 問答被問到『MACD 與 KD 都黃金交叉』
 * 這類多重技術指標組合的篩選問題時，要真的去資料裡查證」——靠比對中文標籤
 * 字串來做交集既脆弱又不精確（標籤文字隨時會改、也無法表達「RSI 小於 70」
 * 這種數值條件），必須有結構化的原始數值才做得到任意組合的篩選。
 */
export interface IndicatorState {
  macdCross: "golden" | "death" | null;
  /** MACD 線（DIF）本身在 0 軸上方還是下方；沒算得出 MACD 時為 null。 */
  macdAboveZero: boolean | null;
  kd: KdReading | null;
  rsi: number | null;
  maAlignment: "bullish" | "bearish" | null;
  /** 現價相對 20 日均線；資料不足時 null。 */
  aboveMa20: boolean | null;
  /** 現價觸及布林通道上緣/下緣。 */
  bollinger: "upper" | "lower" | null;
  streakDays: number;
  streakDirection: "up" | "down" | null;
  /** 最新一根量 ÷ 前 20 日均量（不含最新一根）；算不出來時 null。 */
  volumeRatio: number | null;
  /** KD「即將交叉」（K 未穿 D 但差距小且連續收斂），見 lib/nearCross.ts；不符合時 null。 */
  kdNearCross: NearCrossReading | null;
  /** MACD「即將交叉」（DIF 未穿訊號線但柱狀體連續縮小、接近 0），見 lib/nearCross.ts；不符合時 null。 */
  macdNearCross: NearCrossReading | null;
}

/** KD 即將交叉：快線＝K、慢線＝D，門檻見 lib/nearCross.ts（本站自訂經驗值）。 */
export function computeKdNearCross(candles: Candle[]): NearCrossReading | null {
  const series = computeKdSeries(candles);
  if (!series) return null;
  return detectNearCross(series.kSeries, series.dSeries, {
    convergingDays: KD_NEAR_CROSS_CONVERGING_DAYS,
    maxEstDays: KD_NEAR_CROSS_MAX_EST_DAYS,
    maxGap: KD_NEAR_CROSS_MAX_GAP,
    requireFastMoving: true,
  });
}

/** MACD 即將交叉：快線＝DIF、慢線＝訊號線，門檻見 lib/nearCross.ts（本站自訂經驗值）。 */
export function computeMacdNearCross(candles: Candle[]): NearCrossReading | null {
  if (candles.length < MACD_MIN_BARS) return null;
  const { macdLine, signalLine } = computeMacdLines(candles.map((c) => c.close));
  return detectNearCross(macdLine, signalLine, {
    convergingDays: MACD_NEAR_CROSS_CONVERGING_DAYS,
    maxEstDays: MACD_NEAR_CROSS_MAX_EST_DAYS,
  });
}

export function computeIndicatorState(candles: Candle[], currentPrice: number): IndicatorState | null {
  if (candles.length < 5) return null;
  const macd = computeMacdCross(candles);
  const kd = computeKd(candles);
  const streak = computeStreak(candles);

  const latest = candles[candles.length - 1];
  const priorVolumes = candles.slice(Math.max(0, candles.length - 21), candles.length - 1).map((c) => c.volume);
  const avgVolume =
    priorVolumes.length >= 5 ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : 0;

  const ma20Window = candles.slice(-20);
  const ma20 =
    ma20Window.length >= 10 ? ma20Window.reduce((a, c) => a + c.close, 0) / ma20Window.length : null;

  const bollingerSignal = computeBollingerSignal(candles, currentPrice);

  return {
    macdCross: macd?.type ?? null,
    macdAboveZero: macd?.aboveZero ?? null,
    kd,
    rsi: computeRSI(candles, 14),
    maAlignment: computeMaAlignment(candles),
    aboveMa20: ma20 === null ? null : currentPrice > ma20,
    bollinger: bollingerSignal ? (bollingerSignal.tone === "up" ? "upper" : "lower") : null,
    streakDays: streak.days,
    streakDirection: streak.direction,
    volumeRatio: avgVolume > 0 ? latest.volume / avgVolume : null,
    kdNearCross: computeKdNearCross(candles),
    macdNearCross: computeMacdNearCross(candles),
  };
}
