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
}

export type ParamDef =
  | { key: string; label: string; type: "number"; default: number; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: "select"; default: string; options: Array<{ value: string; label: string }> };

export type IndicatorNeed = "candles" | "fundamentals" | "earnings" | "chips" | "rating";

export interface EvalResult {
  /** 條件是否成立；資料不足時為 null（不當成立也不當不成立，策略會略過這檔） */
  pass: boolean | null;
  /** 一句話說明當下數值，例如「RSI(14)＝28.4」 */
  detail: string;
}

export interface IndicatorType {
  id: string;
  label: string;
  group: "技術面" | "籌碼面" | "基本面" | "本站";
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
