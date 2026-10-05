import type { Candle } from "@/lib/data/types";
import { computeIndicatorState } from "@/lib/signals";

/**
 * 追高防護（純邏輯、無 I/O，有測試）：本站綜合評等在「體質達標」之後，再擋掉「已經急漲／過熱」
 * 的進場點，不讓「建議買進」出現在漲停或連續急漲之後。
 *
 * 由來（2026-10-05 檢討回測）：使用者依本站推薦買進的 8 檔多數虧損，其中 6 檔是追在急漲／漲停後。
 * 回測工具在 scripts/backtest/（7/31 成交金額前 60 檔上市股、8/3～9/22 每週一二共 16 天、
 * 收盤出訊號、隔日開盤進場、超額＝減同日 60 檔平均）——每次調整這裡的門檻都要先跑
 * `npx tsx scripts/backtest/run.ts`，數字寫在各常數旁。
 *
 * 只有 ACTIVE_CHASE_GUARDS 裡的規則會真的影響評等；其他規則留著讓回測工具逐條比較。
 *
 * 2026-10-05 檢討回測結果（960 筆；基準＝當時 siteRating「建議買進」33 筆，5日超額 -1.47%、跑贏 30%）：
 *  - ① RSI≥75：全樣本最一致的負向訊號（61 筆 -2.58%／跑贏 34%，未觸發 +0.18%），但「建議買進」組裡
 *    0 筆觸發（RSI≥70 的「超買」訊號本來就會讓評等變成等回檔）；在「等回檔」組裡 RSI≥75 也沒有比較差
 *    （-0.87% vs -1.02%），改成技術面封頂沒有增量效果 → 不採用（留作比較）。
 *  - ② 急漲：全樣本 90 筆 -1.15%／跑贏 34%（未觸發 +0.12%）；推薦組 33→32 筆、平均 -1.47%→-1.41%、
 *    跑贏 30%→31%，移出的那筆 -3.46% → 採用。
 *  - ③ 乖離：全樣本 158 筆 -0.63%，但「觸發③未觸發②」的 79 筆是 +0.13%（沒有鑑別力），推薦組移出的
 *    就是②那同一筆 → 不採用（使用者 2351 只能靠 MA60 擋，但不為單一案例過度擬合）。
 *  - ④ 外資賣超：全樣本觸發 380 筆 +0.16% vs 未觸發 -0.11%（完全沒有鑑別力）；推薦組雖移出 2 筆
 *    （-4.02%），樣本太小、像巧合 → 不採用。
 *  - 誠實結論：加了②之後推薦組仍是負超額（-1.41%），「先不要買」組反而 +0.35%——現有技術面評分在這段
 *    樣本是負向選股，追高防護只能避開最差的一小群，不是讓推薦變成會賺。
 */

/** RSI 達這個值以上視為過熱（signals.ts 的「超買」標籤是 70）。 */
export const CHASE_RSI_MAX = 75;
/** 近 5 個交易日漲幅（%）超過這個值視為急漲。 */
export const CHASE_RET5_MAX_PCT = 15;
/** 近 10 個交易日漲幅（%）超過這個值視為急漲。 */
export const CHASE_RET10_MAX_PCT = 25;
/** 近 3 個交易日內有漲停（單日 ≥ 這個漲幅，台股漲停 10% 取 9.5% 容許跳檔誤差）… */
export const LIMIT_UP_PCT = 9.5;
/** …而且近 20 個交易日漲幅（%）超過這個值，視為漲停追價。 */
export const CHASE_LIMITUP_RET20_PCT = 25;
/** 現價高於 20 日均線超過這個百分比視為乖離過大。 */
export const CHASE_MA20_BIAS_PCT = 10;
/** 現價高於 60 日均線超過這個百分比視為乖離過大。 */
export const CHASE_MA60_BIAS_PCT = 25;
/** 外資單日賣超股數 ≥ 前 20 日平均成交量的這個百分比，視為外資明顯出貨。 */
export const FOREIGN_SELL_AVG_VOL_PCT = 3;

export interface ChaseMetrics {
  rsi: number | null;
  /** 近 5／10／20 個交易日漲幅（%）；日K不足時是 null */
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  /** 近 3 個交易日（含今天）內有沒有漲停 */
  limitUpWithin3: boolean;
  /** 現價相對 20／60 日均線的乖離（%）；日K不足時是 null */
  ma20BiasPct: number | null;
  ma60BiasPct: number | null;
  /** 外資賣超占前 20 日平均成交量的百分比（買超或沒資料是 null） */
  foreignSellPctOfAvgVol: number | null;
}

/**
 * 從日K算追高指標。`asOfDay`（YYYY-MM-DD）之前的K棒當成「過去」，現價當成今天的收盤；
 * 日K裡如果已經有今天這根（盤中／收盤後），一律用現價取代它，跟有沒有更新到今天無關。
 */
export function computeChaseMetrics(
  candles: Candle[],
  price: number,
  asOfDay: string,
  foreignNetShares?: number | null
): ChaseMetrics {
  const prior = candles.filter((c) => c.time.slice(0, 10) < asOfDay);
  const closes = prior.map((c) => c.close);
  const n = closes.length;
  const ret = (k: number) => (n >= k && closes[n - k] > 0 ? (price / closes[n - k] - 1) * 100 : null);
  const ma = (k: number) => (n >= k - 1 ? (price + closes.slice(n - (k - 1)).reduce((a, b) => a + b, 0)) / k : null);
  const bias = (m: number | null) => (m != null && m > 0 ? (price / m - 1) * 100 : null);
  const dayChanges = [n >= 1 ? price / closes[n - 1] : null, n >= 2 ? closes[n - 1] / closes[n - 2] : null, n >= 3 ? closes[n - 2] / closes[n - 3] : null];
  const limitUpWithin3 = dayChanges.some((r) => r != null && (r - 1) * 100 >= LIMIT_UP_PCT);
  const vols = prior.slice(-20).map((c) => c.volume);
  const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const foreignSellPctOfAvgVol =
    foreignNetShares != null && foreignNetShares < 0 && avgVol > 0 ? (-foreignNetShares / avgVol) * 100 : null;
  const today: Candle = { time: asOfDay, open: price, high: price, low: price, close: price, volume: 0 };
  const rsi = computeIndicatorState([...prior.slice(-62), today], price)?.rsi ?? null;
  return {
    rsi,
    ret5: ret(5),
    ret10: ret(10),
    ret20: ret(20),
    limitUpWithin3,
    ma20BiasPct: bias(ma(20)),
    ma60BiasPct: bias(ma(60)),
    foreignSellPctOfAvgVol,
  };
}

export type ChaseGuardId = "rsi" | "surge" | "bias" | "foreignSell";

export interface ChaseGuardHit {
  id: ChaseGuardId;
  /** 給評等理由用的一句話，例如「RSI 82 過熱（≥75）」 */
  message: string;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

const CHECKS: Record<ChaseGuardId, (m: ChaseMetrics) => string | null> = {
  rsi: (m) => (m.rsi != null && m.rsi >= CHASE_RSI_MAX ? `RSI ${Math.round(m.rsi)} 過熱（≥${CHASE_RSI_MAX}）` : null),
  surge: (m) => {
    if (m.ret5 != null && m.ret5 > CHASE_RET5_MAX_PCT) return `近5日已漲 ${f1(m.ret5)}%（>${CHASE_RET5_MAX_PCT}%）`;
    if (m.ret10 != null && m.ret10 > CHASE_RET10_MAX_PCT) return `近10日已漲 ${f1(m.ret10)}%（>${CHASE_RET10_MAX_PCT}%）`;
    if (m.limitUpWithin3 && m.ret20 != null && m.ret20 > CHASE_LIMITUP_RET20_PCT)
      return `近3日內有漲停且近20日已漲 ${f1(m.ret20)}%（>${CHASE_LIMITUP_RET20_PCT}%）`;
    return null;
  },
  bias: (m) => {
    if (m.ma20BiasPct != null && m.ma20BiasPct > CHASE_MA20_BIAS_PCT) return `高於20日均線 ${f1(m.ma20BiasPct)}%（>${CHASE_MA20_BIAS_PCT}%）`;
    if (m.ma60BiasPct != null && m.ma60BiasPct > CHASE_MA60_BIAS_PCT) return `高於60日均線 ${f1(m.ma60BiasPct)}%（>${CHASE_MA60_BIAS_PCT}%）`;
    return null;
  },
  foreignSell: (m) =>
    m.foreignSellPctOfAvgVol != null && m.foreignSellPctOfAvgVol >= FOREIGN_SELL_AVG_VOL_PCT
      ? `外資單日賣超達前20日均量 ${f1(m.foreignSellPctOfAvgVol)}%（≥${FOREIGN_SELL_AVG_VOL_PCT}%）`
      : null,
};

export const ALL_CHASE_GUARDS: ChaseGuardId[] = ["rsi", "surge", "bias", "foreignSell"];

/** 正式採用的規則（依回測結果決定，見 scripts/backtest/run.ts 的輸出）。 */
export const ACTIVE_CHASE_GUARDS: ChaseGuardId[] = ["surge"];

export function evaluateChaseGuards(m: ChaseMetrics, enabled: readonly ChaseGuardId[] = ACTIVE_CHASE_GUARDS): ChaseGuardHit[] {
  const hits: ChaseGuardHit[] = [];
  for (const id of enabled) {
    const message = CHECKS[id](m);
    if (message) hits.push({ id, message });
  }
  return hits;
}
