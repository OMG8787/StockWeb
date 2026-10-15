import type { OrderBook } from "@/lib/data/orderBook";
import type { Candle, Fundamentals, Earnings } from "@/lib/data/types";
import type { TwChipsDay } from "@/lib/data/chipsHistory";
import {
  computeBollingerSeries,
  computeKdSeries,
  computeMacdSeries,
  computeMaSeries,
  computeRsiSeries,
  type IndicatorPoint,
} from "@/lib/indicators";

/**
 * 「參考指標」的系統清單（2026-10-08 使用者要求：模擬倉／策略庫／參考指標）。
 * 使用者從這份清單挑一種、調參數，存成自己的參考指標；策略再組合多個參考指標。
 *
 * 計算一律用網站既有的唯一來源函式（lib/indicators.ts：RSI 券商 Wilder 版、KD 券商遞迴版、
 * MACD 12/26/9），跟個股頁圖表、AI 問答看到的數值相同，不另外重算一份。
 * 這個檔案只做純計算（不抓資料），資料由 strategyData.ts 準備好放進 EvalContext。
 */

export interface EvalContext {
  symbol: string;
  market: "TW" | "US";
  /** 日K，舊到新 */
  candles: Candle[];
  fundamentals?: Fundamentals | null;
  earnings?: Earnings | null;
  /** 近期每日三大法人（台股；舊到新） */
  chipsDays?: TwChipsDay[] | null;
  /** 本站綜合評等代碼（buy／buy-on-pullback／avoid） */
  ratingCode?: string | null;
  /** 本站綜合評等的組成（各面向、支持／不支持數、價位框架、持有中建議、把握程度）；「AI 策略」拆解條件用 */
  ratingDetail?: RatingDetail | null;
  /** 即時五檔（只有盤中即時判斷才有：策略疊圖最新一天、即時提醒） */
  orderBook?: OrderBook | null;
}

/** 本站綜合評等的組成（由 stockRating 的結果整理；見 runner.ts buildContext） */
export interface RatingDetail {
  /** 五個計分面向＋消息面：名稱（例「技術面」「基本面（估值）」）與結論 */
  facets: Array<{ name: string; verdict: "支持" | "中性" | "不支持" | "無資料" }>;
  supportCount: number;
  againstCount: number;
  /** 有算出價位框架、但現價下方已經沒有支撐（跌破所有均線與近期低點＝破底） */
  brokeDown: boolean;
  /** 支撐區（買點區間）；破底或資料不足是 null */
  zoneLow: number | null;
  zoneHigh: number | null;
  price: number;
  /** 持有中的建議：add 可分批加碼／hold 續抱／reduce 建議減碼／exit 建議出場 */
  holdingCode: "add" | "hold" | "reduce" | "exit";
  /** 本站把握程度（只有建議買進才有） */
  confidence: "高" | "中" | "低" | null;
}

export type ParamDef =
  | { key: string; label: string; type: "number"; default: number; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: "select"; default: string; options: Array<{ value: string; label: string }> };

export type IndicatorNeed = "candles" | "fundamentals" | "earnings" | "chips" | "rating" | "orderbook";

export interface EvalResult {
  /** 條件是否成立；資料不足時為 null（不當成立也不當不成立，策略會略過這檔） */
  pass: boolean | null;
  /** 一句話說明當下數值，例如「RSI(14)＝28.4」 */
  detail: string;
}

export interface IndicatorType {
  id: string;
  label: string;
  group: "技術面" | "籌碼面" | "基本面" | "本站" | "即時盤";
  description: string;
  params: ParamDef[];
  needs: IndicatorNeed[];
  /** 只適用台股（籌碼、月營收） */
  twOnly?: boolean;
  evaluate(ctx: EvalContext, p: Record<string, number | string>): EvalResult;
  /** 依參數組出好讀的名稱，例如「RSI(14) 低於 30」 */
  describe(p: Record<string, number | string>): string;
}

// ---------- 小工具 ----------
const OP_OPTIONS = [
  { value: "lt", label: "低於" },
  { value: "gt", label: "高於" },
];
const opText = (op: unknown) => (op === "gt" ? "高於" : "低於");
const cmp = (v: number, op: unknown, x: number) => (op === "gt" ? v > x : v < x);
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || d);
const fmt = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits).replace(/\.?0+$/, "") : "—");
const last = <T,>(a: T[]): T | undefined => a[a.length - 1];
const NO_DATA: EvalResult = { pass: null, detail: "資料不足" };

/** 最近 withinDays 根內，a 由下往上穿越 b（golden）或由上往下（dead）。兩條線依時間對齊。 */
function crossedWithin(a: IndicatorPoint[], b: IndicatorPoint[], dir: unknown, withinDays: number): boolean | null {
  const bMap = new Map(b.map((p) => [p.time, p.value]));
  const pairs = a.filter((p) => bMap.has(p.time)).map((p) => [p.value, bMap.get(p.time)!] as const);
  if (pairs.length < 2) return null;
  const start = Math.max(1, pairs.length - withinDays);
  for (let i = start; i < pairs.length; i++) {
    const [pa, pb] = pairs[i - 1];
    const [ca, cb] = pairs[i];
    if (dir === "dead" ? pa >= pb && ca < cb : pa <= pb && ca > cb) return true;
  }
  return false;
}

const DIR_OPTIONS = [
  { value: "golden", label: "黃金交叉（向上）" },
  { value: "dead", label: "死亡交叉（向下）" },
];
const dirText = (d: unknown) => (d === "dead" ? "死亡交叉" : "黃金交叉");

const WHO_OPTIONS = [
  { value: "foreign", label: "外資" },
  { value: "trust", label: "投信" },
  { value: "dealer", label: "自營商" },
  { value: "total", label: "三大法人合計" },
];
const whoText = (w: unknown) => WHO_OPTIONS.find((o) => o.value === w)?.label ?? "外資";
function netOf(d: TwChipsDay, who: unknown): number | undefined {
  if (who === "trust") return d.trustNet;
  if (who === "dealer") return d.dealerNet;
  if (who === "total") {
    if (d.foreignNet == null && d.trustNet == null && d.dealerNet == null) return undefined;
    return (d.foreignNet ?? 0) + (d.trustNet ?? 0) + (d.dealerNet ?? 0);
  }
  return d.foreignNet;
}

/** 本站評等的計分面向（value＝參數值、prefix＝facets 名稱開頭、label＝顯示） */
export const RATING_FACETS = [
  { value: "tech", prefix: "技術面", label: "技術面" },
  { value: "chips", prefix: "籌碼面", label: "籌碼面（三大法人）" },
  { value: "holding", prefix: "持股結構面", label: "持股結構面（大戶／外資／融資）" },
  { value: "value", prefix: "基本面", label: "估值面（本益比／淨值比／殖利率）" },
  { value: "earnings", prefix: "財報面", label: "財報面（月營收／EPS）" },
] as const;
const facetLabel = (v: unknown) => RATING_FACETS.find((f) => f.value === v)?.label ?? "技術面";
const verdictLabel = (v: unknown) => (v === "against" ? "不支持" : v === "notAgainst" ? "不是「不支持」" : "支持");
const HOLDING_TEXT: Record<string, string> = {
  add: "可分批加碼",
  hold: "續抱",
  reduce: "建議減碼",
  exit: "建議出場",
  exitOrReduce: "建議出場或減碼",
};

// ---------- 指標清單 ----------
export const INDICATOR_TYPES: IndicatorType[] = [
  {
    id: "rsi",
    label: "RSI 強弱指標",
    group: "技術面",
    description: "RSI 低於 30 常視為超賣（可能反彈），高於 70 常視為超買（可能回檔）。券商 Wilder 算法。",
    params: [
      { key: "period", label: "天數", type: "number", default: 14, min: 2, max: 60 },
      { key: "op", label: "條件", type: "select", default: "lt", options: OP_OPTIONS },
      { key: "value", label: "數值", type: "number", default: 30, min: 0, max: 100 },
    ],
    needs: ["candles"],
    describe: (p) => `RSI(${n(p.period, 14)}) ${opText(p.op)} ${n(p.value, 30)}`,
    evaluate(ctx, p) {
      const v = last(computeRsiSeries(ctx.candles, n(p.period, 14)))?.value;
      if (v == null) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 30)), detail: `RSI(${n(p.period, 14)})＝${fmt(v, 1)}` };
    },
  },
  {
    id: "rsi_cross",
    label: "RSI 穿越門檻（超賣反彈／超買回落）",
    group: "技術面",
    description:
      "RSI 由下往上穿越門檻（例如曾低於 30、最近重新站上 30＝超賣反彈），或由上往下跌破門檻（例如從 70 以上回落＝超買回落）。跟「RSI 強弱指標」不同：那個只看現在的數值，這個看「剛剛穿越」這件事。建議搭配止跌或趨勢條件，避免只因 RSI 穿越就進場。",
    params: [
      { key: "period", label: "RSI 天數", type: "number", default: 14, min: 2, max: 60 },
      { key: "dir", label: "方向", type: "select", default: "up", options: [{ value: "up", label: "由下往上穿越（超賣反彈）" }, { value: "down", label: "由上往下跌破（超買回落）" }] },
      { key: "level", label: "門檻", type: "number", default: 30, min: 1, max: 99 },
      { key: "within", label: "最近幾天內", type: "number", default: 5, min: 1, max: 20 },
    ],
    needs: ["candles"],
    describe: (p) =>
      p.dir === "down"
        ? `RSI(${n(p.period, 14)}) 由上往下跌破 ${n(p.level, 30)}（${n(p.within, 5)} 天內）`
        : `RSI(${n(p.period, 14)}) 曾低於 ${n(p.level, 30)} 後重新站上（${n(p.within, 5)} 天內）`,
    evaluate(ctx, p) {
      const series = computeRsiSeries(ctx.candles, n(p.period, 14));
      if (series.length < 2) return NO_DATA;
      const level = n(p.level, 30);
      const start = Math.max(1, series.length - n(p.within, 5));
      let crossed = false;
      for (let i = start; i < series.length; i++) {
        const prev = series[i - 1].value;
        const cur = series[i].value;
        if (p.dir === "down" ? prev >= level && cur < level : prev < level && cur >= level) crossed = true;
      }
      return { pass: crossed, detail: `RSI(${n(p.period, 14)})＝${fmt(series[series.length - 1].value, 1)}、前一日＝${fmt(series[series.length - 2].value, 1)}` };
    },
  },
  {
    id: "kd_cross",
    label: "KD 交叉",
    group: "技術面",
    description: "K 線穿越 D 線。黃金交叉常視為轉強、死亡交叉常視為轉弱。可限制只在低檔（K 低於某值）的黃金交叉才算。",
    params: [
      { key: "dir", label: "方向", type: "select", default: "golden", options: DIR_OPTIONS },
      { key: "within", label: "最近幾天內", type: "number", default: 3, min: 1, max: 20 },
      { key: "kLimit", label: "K 值限制（0＝不限；黃金交叉時 K 要低於、死亡交叉時 K 要高於）", type: "number", default: 0, min: 0, max: 100 },
    ],
    needs: ["candles"],
    describe: (p) =>
      `KD ${dirText(p.dir)}（${n(p.within, 3)} 天內${n(p.kLimit, 0) ? `，K ${p.dir === "dead" ? "高於" : "低於"} ${n(p.kLimit, 0)}` : ""}）`,
    evaluate(ctx, p) {
      const kd = computeKdSeries(ctx.candles);
      const crossed = crossedWithin(kd.k, kd.d, p.dir, n(p.within, 3));
      const k = last(kd.k)?.value;
      const d = last(kd.d)?.value;
      if (crossed == null || k == null || d == null) return NO_DATA;
      const limit = n(p.kLimit, 0);
      const zoneOk = !limit || (p.dir === "dead" ? k > limit : k < limit);
      return { pass: crossed && zoneOk, detail: `K＝${fmt(k, 1)}、D＝${fmt(d, 1)}` };
    },
  },
  {
    id: "macd_cross",
    label: "MACD 交叉",
    group: "技術面",
    description: "DIF（快線）穿越 DEA（訊號線）。黃金交叉常視為多方動能轉強。參數 12/26/9。",
    params: [
      { key: "dir", label: "方向", type: "select", default: "golden", options: DIR_OPTIONS },
      { key: "within", label: "最近幾天內", type: "number", default: 3, min: 1, max: 20 },
    ],
    needs: ["candles"],
    describe: (p) => `MACD ${dirText(p.dir)}（${n(p.within, 3)} 天內）`,
    evaluate(ctx, p) {
      const m = computeMacdSeries(ctx.candles);
      const crossed = crossedWithin(m.macd, m.signal, p.dir, n(p.within, 3));
      const dif = last(m.macd)?.value;
      const dea = last(m.signal)?.value;
      if (crossed == null || dif == null || dea == null) return NO_DATA;
      return { pass: crossed, detail: `DIF＝${fmt(dif)}、DEA＝${fmt(dea)}` };
    },
  },
  {
    id: "ma_cross",
    label: "均線交叉",
    group: "技術面",
    description: "短天期均線穿越長天期均線，例如 5 日線向上穿越 20 日線（黃金交叉）。",
    params: [
      { key: "short", label: "短天期", type: "number", default: 5, min: 2, max: 120 },
      { key: "long", label: "長天期", type: "number", default: 20, min: 3, max: 240 },
      { key: "dir", label: "方向", type: "select", default: "golden", options: DIR_OPTIONS },
      { key: "within", label: "最近幾天內", type: "number", default: 3, min: 1, max: 20 },
    ],
    needs: ["candles"],
    describe: (p) => `${n(p.short, 5)} 日線與 ${n(p.long, 20)} 日線${dirText(p.dir)}（${n(p.within, 3)} 天內）`,
    evaluate(ctx, p) {
      const s = computeMaSeries(ctx.candles, n(p.short, 5));
      const l = computeMaSeries(ctx.candles, n(p.long, 20));
      const crossed = crossedWithin(s, l, p.dir, n(p.within, 3));
      if (crossed == null) return NO_DATA;
      return { pass: crossed, detail: `MA${n(p.short, 5)}＝${fmt(last(s)!.value)}、MA${n(p.long, 20)}＝${fmt(last(l)!.value)}` };
    },
  },
  {
    id: "ma_alignment",
    label: "均線多頭排列",
    group: "技術面",
    description:
      "短、中、長三條均線由上到下依序排列（例如 5 日線 > 20 日線 > 60 日線）代表多頭排列，趨勢向上；可再要求中天期均線本身向上（跟幾天前比較）。均線有落後性，排列成形時股價可能已經漲了一段。",
    params: [
      { key: "short", label: "短天期", type: "number", default: 5, min: 2, max: 60 },
      { key: "mid", label: "中天期", type: "number", default: 20, min: 3, max: 120 },
      { key: "long", label: "長天期", type: "number", default: 60, min: 4, max: 240 },
      { key: "slopeDays", label: "中天期均線需向上（跟幾天前比，0＝不要求）", type: "number", default: 3, min: 0, max: 20 },
    ],
    needs: ["candles"],
    describe: (p) =>
      `均線多頭排列（${n(p.short, 5)} 日線 > ${n(p.mid, 20)} 日線 > ${n(p.long, 60)} 日線${n(p.slopeDays, 3) > 0 ? `，${n(p.mid, 20)} 日線向上` : ""}）`,
    evaluate(ctx, p) {
      const s = last(computeMaSeries(ctx.candles, n(p.short, 5)))?.value;
      const midSeries = computeMaSeries(ctx.candles, n(p.mid, 20));
      const m = last(midSeries)?.value;
      const l = last(computeMaSeries(ctx.candles, n(p.long, 60)))?.value;
      if (s == null || m == null || l == null) return NO_DATA;
      const slope = n(p.slopeDays, 3);
      let up = true;
      if (slope > 0) {
        const before = midSeries[midSeries.length - 1 - slope]?.value;
        if (before == null) return NO_DATA;
        up = m > before;
      }
      return {
        pass: s > m && m > l && up,
        detail: `MA${n(p.short, 5)}＝${fmt(s)}、MA${n(p.mid, 20)}＝${fmt(m)}、MA${n(p.long, 60)}＝${fmt(l)}${slope > 0 ? `（中天期線${up ? "向上" : "未向上"}）` : ""}`,
      };
    },
  },
  {
    id: "price_vs_ma",
    label: "股價與均線",
    group: "技術面",
    description: "收盤價在某條均線之上（偏多）或之下（偏空）。",
    params: [
      { key: "period", label: "均線天數", type: "number", default: 20, min: 2, max: 240 },
      { key: "op", label: "位置", type: "select", default: "gt", options: [{ value: "gt", label: "在均線之上" }, { value: "lt", label: "在均線之下" }] },
    ],
    needs: ["candles"],
    describe: (p) => `收盤價${p.op === "lt" ? "在" : "站上"} ${n(p.period, 20)} 日線${p.op === "lt" ? "之下" : ""}`,
    evaluate(ctx, p) {
      const ma = last(computeMaSeries(ctx.candles, n(p.period, 20)))?.value;
      const close = last(ctx.candles)?.close;
      if (ma == null || close == null) return NO_DATA;
      return { pass: cmp(close, p.op, ma), detail: `收盤 ${fmt(close)}、MA${n(p.period, 20)}＝${fmt(ma)}` };
    },
  },
  {
    id: "volume_surge",
    label: "成交量放大",
    group: "技術面",
    description: "今日成交量是過去 N 日平均量的幾倍以上（爆量）。",
    params: [
      { key: "period", label: "平均天數", type: "number", default: 20, min: 2, max: 120 },
      { key: "multiple", label: "倍數", type: "number", default: 2, min: 1, max: 20, step: 0.1 },
    ],
    needs: ["candles"],
    describe: (p) => `成交量 ≥ ${n(p.period, 20)} 日均量 ${n(p.multiple, 2)} 倍`,
    evaluate(ctx, p) {
      const period = n(p.period, 20);
      const c = ctx.candles;
      if (c.length < period + 1) return NO_DATA;
      const today = c[c.length - 1].volume ?? 0;
      const avg = c.slice(-period - 1, -1).reduce((a, x) => a + (x.volume ?? 0), 0) / period;
      if (!avg) return NO_DATA;
      return { pass: today >= avg * n(p.multiple, 2), detail: `今日量為均量 ${fmt(today / avg, 1)} 倍` };
    },
  },
  {
    id: "price_change",
    label: "N 日漲跌幅",
    group: "技術面",
    description: "最近 N 個交易日的漲跌幅高於或低於某個百分比。",
    params: [
      { key: "days", label: "天數", type: "number", default: 5, min: 1, max: 120 },
      { key: "op", label: "條件", type: "select", default: "gt", options: OP_OPTIONS },
      { key: "pct", label: "百分比", type: "number", default: 5, min: -100, max: 500, unit: "%" },
    ],
    needs: ["candles"],
    describe: (p) => `${n(p.days, 5)} 日漲跌幅 ${opText(p.op)} ${n(p.pct, 5)}%`,
    evaluate(ctx, p) {
      const days = n(p.days, 5);
      const c = ctx.candles;
      if (c.length < days + 1) return NO_DATA;
      const chg = (c[c.length - 1].close / c[c.length - 1 - days].close - 1) * 100;
      return { pass: cmp(chg, p.op, n(p.pct, 5)), detail: `${days} 日漲跌 ${fmt(chg, 1)}%` };
    },
  },
  {
    id: "breakout",
    label: "突破新高／跌破新低",
    group: "技術面",
    description: "收盤價創 N 日新高（突破）或跌破 N 日新低。",
    params: [
      { key: "days", label: "天數", type: "number", default: 20, min: 5, max: 240 },
      { key: "dir", label: "方向", type: "select", default: "high", options: [{ value: "high", label: "創新高" }, { value: "low", label: "創新低" }] },
    ],
    needs: ["candles"],
    describe: (p) => `收盤創 ${n(p.days, 20)} 日${p.dir === "low" ? "新低" : "新高"}`,
    evaluate(ctx, p) {
      const days = n(p.days, 20);
      const c = ctx.candles;
      if (c.length < days + 1) return NO_DATA;
      const prior = c.slice(-days - 1, -1).map((x) => x.close);
      const close = c[c.length - 1].close;
      const hit = p.dir === "low" ? close < Math.min(...prior) : close > Math.max(...prior);
      return { pass: hit, detail: `收盤 ${fmt(close)}，前 ${days} 日區間 ${fmt(Math.min(...prior))}～${fmt(Math.max(...prior))}` };
    },
  },
  {
    id: "bollinger",
    label: "布林通道",
    group: "技術面",
    description: "收盤價跌破下軌（超跌）或突破上軌（強勢／過熱）。參數 20 日、2 倍標準差。",
    params: [
      { key: "pos", label: "位置", type: "select", default: "below", options: [{ value: "below", label: "跌破下軌" }, { value: "above", label: "突破上軌" }] },
    ],
    needs: ["candles"],
    describe: (p) => `布林通道${p.pos === "above" ? "突破上軌" : "跌破下軌"}`,
    evaluate(ctx, p) {
      const b = computeBollingerSeries(ctx.candles);
      const up = last(b.upper)?.value;
      const lo = last(b.lower)?.value;
      const close = last(ctx.candles)?.close;
      if (up == null || lo == null || close == null) return NO_DATA;
      return { pass: p.pos === "above" ? close > up : close < lo, detail: `收盤 ${fmt(close)}，通道 ${fmt(lo)}～${fmt(up)}` };
    },
  },
  {
    id: "inst_streak",
    label: "法人連續買賣超",
    group: "籌碼面",
    description: "外資／投信／自營商（或合計）連續 N 個交易日買超或賣超。",
    params: [
      { key: "who", label: "法人", type: "select", default: "foreign", options: WHO_OPTIONS },
      { key: "dir", label: "方向", type: "select", default: "buy", options: [{ value: "buy", label: "買超" }, { value: "sell", label: "賣超" }] },
      { key: "days", label: "連續天數", type: "number", default: 3, min: 1, max: 20 },
    ],
    needs: ["chips"],
    twOnly: true,
    describe: (p) => `${whoText(p.who)}連續 ${n(p.days, 3)} 日${p.dir === "sell" ? "賣超" : "買超"}`,
    evaluate(ctx, p) {
      const days = n(p.days, 3);
      const recent = (ctx.chipsDays ?? []).slice(-days);
      if (recent.length < days) return NO_DATA;
      const nets = recent.map((d) => netOf(d, p.who));
      if (nets.some((x) => x == null)) return NO_DATA;
      const ok = nets.every((x) => (p.dir === "sell" ? x! < 0 : x! > 0));
      return { pass: ok, detail: `近 ${days} 日：${nets.map((x) => fmt(x! / 1000, 0)).join("、")} 張` };
    },
  },
  {
    id: "inst_sum",
    label: "法人累計買賣超",
    group: "籌碼面",
    description: "外資／投信／自營商（或合計）最近 N 日累計買賣超張數高於或低於某值（負數＝賣超）。",
    params: [
      { key: "who", label: "法人", type: "select", default: "foreign", options: WHO_OPTIONS },
      { key: "days", label: "天數", type: "number", default: 5, min: 1, max: 20 },
      { key: "op", label: "條件", type: "select", default: "gt", options: OP_OPTIONS },
      { key: "lots", label: "張數", type: "number", default: 1000, min: -1000000, max: 1000000, unit: "張" },
    ],
    needs: ["chips"],
    twOnly: true,
    describe: (p) => `${whoText(p.who)} ${n(p.days, 5)} 日累計買賣超 ${opText(p.op)} ${n(p.lots, 1000)} 張`,
    evaluate(ctx, p) {
      const days = n(p.days, 5);
      const recent = (ctx.chipsDays ?? []).slice(-days);
      if (recent.length < days) return NO_DATA;
      const nets = recent.map((d) => netOf(d, p.who));
      if (nets.some((x) => x == null)) return NO_DATA;
      const lots = (nets as number[]).reduce((a, x) => a + x, 0) / 1000;
      return { pass: cmp(lots, p.op, n(p.lots, 1000)), detail: `${days} 日累計 ${fmt(lots, 0)} 張` };
    },
  },
  {
    id: "pe",
    label: "本益比",
    group: "基本面",
    description: "本益比（P/E）低於或高於某值。",
    params: [
      { key: "op", label: "條件", type: "select", default: "lt", options: OP_OPTIONS },
      { key: "value", label: "數值", type: "number", default: 15, min: 0, max: 500 },
    ],
    needs: ["fundamentals"],
    describe: (p) => `本益比 ${opText(p.op)} ${n(p.value, 15)}`,
    evaluate(ctx, p) {
      const v = ctx.fundamentals?.peRatio;
      if (v == null || !(v > 0)) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 15)), detail: `本益比 ${fmt(v, 1)}` };
    },
  },
  {
    id: "dividend_yield",
    label: "殖利率",
    group: "基本面",
    description: "現金殖利率高於或低於某個百分比。",
    params: [
      { key: "op", label: "條件", type: "select", default: "gt", options: OP_OPTIONS },
      { key: "value", label: "百分比", type: "number", default: 4, min: 0, max: 50, unit: "%" },
    ],
    needs: ["fundamentals"],
    describe: (p) => `殖利率 ${opText(p.op)} ${n(p.value, 4)}%`,
    evaluate(ctx, p) {
      const v = ctx.fundamentals?.dividendYield;
      if (v == null) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 4)), detail: `殖利率 ${fmt(v)}%` };
    },
  },
  {
    id: "pb",
    label: "股價淨值比",
    group: "基本面",
    description: "股價淨值比（P/B）低於或高於某值。",
    params: [
      { key: "op", label: "條件", type: "select", default: "lt", options: OP_OPTIONS },
      { key: "value", label: "數值", type: "number", default: 1.5, min: 0, max: 100, step: 0.1 },
    ],
    needs: ["fundamentals"],
    describe: (p) => `股價淨值比 ${opText(p.op)} ${n(p.value, 1.5)}`,
    evaluate(ctx, p) {
      const v = ctx.fundamentals?.pbRatio;
      if (v == null || !(v > 0)) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 1.5)), detail: `股價淨值比 ${fmt(v)}` };
    },
  },
  {
    id: "revenue_yoy",
    label: "月營收年增率",
    group: "基本面",
    description: "最新月營收比去年同月成長（或衰退）超過某個百分比。",
    params: [
      { key: "op", label: "條件", type: "select", default: "gt", options: OP_OPTIONS },
      { key: "value", label: "百分比", type: "number", default: 20, min: -100, max: 1000, unit: "%" },
    ],
    needs: ["earnings"],
    twOnly: true,
    describe: (p) => `月營收年增率 ${opText(p.op)} ${n(p.value, 20)}%`,
    evaluate(ctx, p) {
      const v = ctx.earnings?.monthlyRevenueYoyPercent;
      if (v == null) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 20)), detail: `${ctx.earnings?.monthlyRevenuePeriod ?? "最新"}年增 ${fmt(v, 1)}%` };
    },
  },
  {
    id: "revenue_mom",
    label: "月營收月增率",
    group: "基本面",
    description: "最新月營收比上個月成長（或衰退）超過某個百分比。",
    params: [
      { key: "op", label: "條件", type: "select", default: "gt", options: OP_OPTIONS },
      { key: "value", label: "百分比", type: "number", default: 10, min: -100, max: 1000, unit: "%" },
    ],
    needs: ["earnings"],
    twOnly: true,
    describe: (p) => `月營收月增率 ${opText(p.op)} ${n(p.value, 10)}%`,
    evaluate(ctx, p) {
      const v = ctx.earnings?.monthlyRevenueMomPercent;
      if (v == null) return NO_DATA;
      return { pass: cmp(v, p.op, n(p.value, 10)), detail: `${ctx.earnings?.monthlyRevenuePeriod ?? "最新"}月增 ${fmt(v, 1)}%` };
    },
  },
  {
    id: "site_rating",
    label: "本站綜合評等",
    group: "本站",
    description: "本站綜合評等（技術、籌碼、基本、財報、消息五面向，程式計算、與個股頁相同）的結論。",
    params: [
      {
        key: "code",
        label: "結論",
        type: "select",
        default: "buy",
        options: [
          { value: "buy", label: "建議買進" },
          { value: "avoid", label: "建議先不要買" },
        ],
      },
    ],
    needs: ["rating"],
    describe: (p) => `本站評等為「${p.code === "avoid" ? "建議先不要買" : "建議買進"}」`,
    evaluate(ctx, p) {
      if (!ctx.ratingCode) return NO_DATA;
      // 「等回檔」已併入建議買進（siteRating.ts 二分結論）
      const isBuy = ctx.ratingCode === "buy" || ctx.ratingCode === "buy-on-pullback";
      return { pass: p.code === "avoid" ? !isBuy : isBuy, detail: `本站評等：${isBuy ? "建議買進" : "建議先不要買"}` };
    },
  },
  {
    id: "rating_facet",
    label: "本站評等・單一面向",
    group: "本站",
    description:
      "本站綜合評等五個計分面向（技術、籌碼、持股結構、估值、財報）其中一個的結論：支持／中性／不支持（程式依當天資料判斷，跟個股頁的評等同一份）。「AI 策略」買進門檻就是用這些面向組成的，可以單獨拿來加減。",
    params: [
      {
        key: "facet",
        label: "面向",
        type: "select",
        default: "tech",
        options: RATING_FACETS.map((f) => ({ value: f.value, label: f.label })),
      },
      {
        key: "verdict",
        label: "條件",
        type: "select",
        default: "support",
        options: [
          { value: "support", label: "支持" },
          { value: "notAgainst", label: "不是「不支持」（支持、中性或無資料都算）" },
          { value: "against", label: "不支持" },
        ],
      },
    ],
    needs: ["rating"],
    describe: (p) => `本站${facetLabel(p.facet)}${verdictLabel(p.verdict)}`,
    evaluate(ctx, p) {
      const d = ctx.ratingDetail;
      if (!d) return NO_DATA;
      const prefix = RATING_FACETS.find((f) => f.value === p.facet)?.prefix ?? "技術面";
      const f = d.facets.find((x) => x.name.startsWith(prefix));
      const v = f?.verdict ?? "無資料";
      const pass = p.verdict === "against" ? v === "不支持" : p.verdict === "notAgainst" ? v !== "不支持" : v === "支持";
      return { pass, detail: `${facetLabel(p.facet)}：${v}` };
    },
  },
  {
    id: "rating_facet_count",
    label: "本站評等・支持／不支持面向數",
    group: "本站",
    description:
      "五個計分面向（技術、籌碼、持股結構、估值、財報）裡「支持」或「不支持」的個數。本站「建議買進」的體質門檻是支持至少 2 個、不支持最多 1 個；持有中不支持達 2 個以上會建議減碼。",
    params: [
      {
        key: "kind",
        label: "數哪一種",
        type: "select",
        default: "support",
        options: [
          { value: "support", label: "支持的面向數" },
          { value: "against", label: "不支持的面向數" },
        ],
      },
      {
        key: "op",
        label: "條件",
        type: "select",
        default: "gte",
        options: [
          { value: "gte", label: "至少" },
          { value: "lte", label: "最多" },
        ],
      },
      { key: "n", label: "個數", type: "number", default: 2, min: 0, max: 5 },
    ],
    needs: ["rating"],
    describe: (p) => `本站評等${p.kind === "against" ? "不支持" : "支持"}的面向${p.op === "lte" ? "最多" : "至少"} ${n(p.n, 2)} 個（共 5 個）`,
    evaluate(ctx, p) {
      const d = ctx.ratingDetail;
      if (!d) return NO_DATA;
      const v = p.kind === "against" ? d.againstCount : d.supportCount;
      const pass = p.op === "lte" ? v <= n(p.n, 2) : v >= n(p.n, 2);
      return { pass, detail: `支持 ${d.supportCount} 個、不支持 ${d.againstCount} 個（共 5 個面向）` };
    },
  },
  {
    id: "rating_price_frame",
    label: "本站價位框架（支撐／破底）",
    group: "本站",
    description:
      "本站用均線與近期高低點算出的支撐區（買點區間）。「破底」＝現價已跌破所有均線與近期低點、下方沒有支撐，本站這時一律不建議買進、持有中建議出場；「貼近支撐區」＝現價不高於支撐區上緣 N%（不追高）。",
    params: [
      {
        key: "cond",
        label: "條件",
        type: "select",
        default: "notBroken",
        options: [
          { value: "notBroken", label: "未破底（現價下方還有支撐）" },
          { value: "broken", label: "已破底（跌破所有均線與近期低點）" },
          { value: "nearZone", label: "現價貼近支撐區（不高於支撐區上緣 N%）" },
        ],
      },
      { key: "pct", label: "貼近的範圍（只對「貼近支撐區」有效）", type: "number", default: 3, min: 0, max: 30, step: 0.5, unit: "%" },
    ],
    needs: ["rating"],
    describe: (p) =>
      p.cond === "broken" ? "本站價位框架：已破底" : p.cond === "nearZone" ? `現價不高於本站支撐區上緣 ${n(p.pct, 3)}%` : "本站價位框架：未破底（下方還有支撐）",
    evaluate(ctx, p) {
      const d = ctx.ratingDetail;
      if (!d) return NO_DATA;
      const zone = d.zoneLow != null && d.zoneHigh != null ? `支撐區 ${fmt(d.zoneLow)}～${fmt(d.zoneHigh)}` : d.brokeDown ? "已破底、沒有支撐區" : "日K不足、沒有算出支撐區";
      if (p.cond === "broken") return { pass: d.brokeDown, detail: `現價 ${fmt(d.price)}，${zone}` };
      if (p.cond === "nearZone") {
        if (d.zoneHigh == null) return { pass: false, detail: `現價 ${fmt(d.price)}，${zone}` };
        const above = ((d.price - d.zoneHigh) / d.zoneHigh) * 100;
        return { pass: above <= n(p.pct, 3), detail: `現價 ${fmt(d.price)}，${zone}（高於上緣 ${fmt(above, 1)}%）` };
      }
      return { pass: !d.brokeDown, detail: `現價 ${fmt(d.price)}，${zone}` };
    },
  },
  {
    id: "rating_holding",
    label: "本站持有中建議",
    group: "本站",
    description:
      "本站對「已經持有」的人的建議：可分批加碼、續抱、建議減碼（不支持面向 ≥ 2）、建議出場（破底）。適合當賣出條件。",
    params: [
      {
        key: "code",
        label: "建議",
        type: "select",
        default: "exitOrReduce",
        options: [
          { value: "exitOrReduce", label: "建議出場或減碼" },
          { value: "exit", label: "建議出場" },
          { value: "reduce", label: "建議減碼" },
          { value: "hold", label: "續抱" },
          { value: "add", label: "可分批加碼" },
        ],
      },
    ],
    needs: ["rating"],
    describe: (p) => `本站持有中建議為「${HOLDING_TEXT[String(p.code)] ?? "建議出場或減碼"}」`,
    evaluate(ctx, p) {
      const d = ctx.ratingDetail;
      if (!d) return NO_DATA;
      const pass = p.code === "exitOrReduce" ? d.holdingCode === "exit" || d.holdingCode === "reduce" : d.holdingCode === p.code;
      return { pass, detail: `持有中建議：${HOLDING_TEXT[d.holdingCode]}` };
    },
  },
  {
    id: "rating_confidence",
    label: "本站把握程度",
    group: "本站",
    description:
      "本站對「建議買進」的把握程度：高＝大盤不偏弱且已連續 3 個交易日以上建議買進；低＝大盤偏弱且剛轉為建議買進（2 天內）；其餘為中。今日建議名單就是依這個排序（高的排前面）。不是建議買進的股票沒有把握程度（條件不成立）。",
    params: [
      {
        key: "min",
        label: "至少",
        type: "select",
        default: "mid",
        options: [
          { value: "high", label: "高" },
          { value: "mid", label: "中以上" },
          { value: "low", label: "低以上（只要是建議買進）" },
        ],
      },
    ],
    needs: ["rating"],
    describe: (p) => `本站把握程度${p.min === "high" ? "為高" : p.min === "low" ? "低以上（建議買進）" : "中以上"}`,
    evaluate(ctx, p) {
      const d = ctx.ratingDetail;
      if (!d) return NO_DATA;
      if (!d.confidence) return { pass: false, detail: "不是建議買進，沒有把握程度" };
      const rank = { 高: 0, 中: 1, 低: 2 }[d.confidence];
      const need = p.min === "high" ? 0 : p.min === "low" ? 2 : 1;
      return { pass: rank <= need, detail: `本站把握程度：${d.confidence}` };
    },
  },
  {
    id: "order_book",
    label: "即時五檔（委買委賣力道）",
    group: "即時盤",
    description:
      "盤中最佳五檔的委買量合計與委賣量合計相比，看買盤或賣壓哪邊強（當沖參考）。只有盤中即時判斷才有資料：即時提醒（可每 5 秒檢查）與策略疊圖的最新一天；模擬倉收盤後判斷與歷史日子沒有五檔，這個條件會視為資料不足。",
    params: [
      {
        key: "side",
        label: "條件",
        type: "select",
        default: "bid",
        options: [
          { value: "bid", label: "買盤強：委買量 ÷ 委賣量 ≥ 倍數" },
          { value: "ask", label: "賣壓重：委賣量 ÷ 委買量 ≥ 倍數" },
        ],
      },
      { key: "ratio", label: "倍數", type: "number", default: 1.5, min: 1, max: 10, step: 0.1, unit: "倍" },
    ],
    needs: ["orderbook"],
    twOnly: true,
    describe: (p) => `五檔${p.side === "ask" ? "委賣量是委買量" : "委買量是委賣量"}的 ${fmt(n(p.ratio, 1.5), 1)} 倍以上`,
    evaluate(ctx, p) {
      const b = ctx.orderBook;
      if (!b || (b.bidTotal === 0 && b.askTotal === 0)) return { pass: null, detail: "沒有即時五檔（只在盤中即時判斷時有）" };
      const ratio = n(p.ratio, 1.5);
      const detail = `五檔委買 ${b.bidTotal} 張／委賣 ${b.askTotal} 張`;
      // 一邊是 0（漲停鎖住沒人賣、跌停鎖住沒人買）：該邊視為無限強
      const v = p.side === "ask" ? (b.bidTotal ? b.askTotal / b.bidTotal : Infinity) : b.askTotal ? b.bidTotal / b.askTotal : Infinity;
      return { pass: v >= ratio, detail };
    },
  },
];

export const INDICATOR_TYPE_MAP = new Map(INDICATOR_TYPES.map((t) => [t.id, t]));

/** 依型別定義把使用者送來的參數整理成合法值（缺的用預設、超出範圍夾回去、選項不對用預設）。 */
export function normalizeParams(typeId: string, raw: Record<string, unknown> | null | undefined): Record<string, number | string> {
  const t = INDICATOR_TYPE_MAP.get(typeId);
  if (!t) throw new Error("未知的指標類型：" + typeId);
  const out: Record<string, number | string> = {};
  for (const def of t.params) {
    const v = raw?.[def.key];
    if (def.type === "number") {
      const x = typeof v === "number" ? v : Number(v);
      out[def.key] = Number.isFinite(x) ? Math.min(def.max, Math.max(def.min, x)) : def.default;
    } else {
      out[def.key] = def.options.some((o) => o.value === v) ? (v as string) : def.default;
    }
  }
  return out;
}

/** 評估一個使用者的參考指標。美股遇到只限台股的指標回「不適用」（pass＝null）。 */
export function evaluateIndicator(typeId: string, params: Record<string, number | string>, ctx: EvalContext): EvalResult {
  const t = INDICATOR_TYPE_MAP.get(typeId);
  if (!t) return { pass: null, detail: "未知的指標類型" };
  if (t.twOnly && ctx.market !== "TW") return { pass: null, detail: "只適用台股" };
  try {
    return t.evaluate(ctx, params);
  } catch {
    return NO_DATA;
  }
}
