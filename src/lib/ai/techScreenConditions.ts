/**
 * 技術篩選的「數值條件」與「兩種指標同時即將交叉」（純函式、無 I/O，有測試 src/__tests__/techScreenConditions.test.ts）。
 *
 * 起因（2026-10-07 使用者回報）：
 * - 問「那有rsi70以下建議買進的股票嗎」→ 技術篩選只有預先列好的幾種組合（沒有「RSI<70」單獨或「RSI<70＋評等」），
 *   模型沒有名單就自己編：上一則說台表科 RSI 83（當時的簡單平均版、日K到 10/6；2026-10-07 起全站改 Wilder 版）、這一則寫 65（資料裡沒有這個數字）。
 *   數值條件與評等的組合一律由程式從掃描範圍逐檔算出名單，AI 只解說。
 * - 問「有兩種線快線都快超過慢線的嗎」→ 沒有「MACD 與 KD 同時即將交叉」名單，只答「沒看到」。
 */
import type { TechScreenItem } from "@/lib/data";
import type { IndicatorState } from "@/lib/signals";

export type ConditionField = "rsi" | "k" | "d";
export type ConditionOp = "lt" | "le" | "gt" | "ge";

export interface IndicatorCondition {
  field: ConditionField;
  op: ConditionOp;
  value: number;
}

const FIELD_NAME: Record<ConditionField, string> = { rsi: "RSI", k: "K值", d: "D值" };
const OP_SYMBOL: Record<ConditionOp, string> = { lt: "<", le: "≤", gt: ">", ge: "≥" };

/** 「RSI ≤ 70」這種給人與 AI 看的條件文字。 */
export function describeCondition(c: IndicatorCondition): string {
  return `${FIELD_NAME[c.field]} ${OP_SYMBOL[c.op]} ${c.value}`;
}

const NAME = "(RSI|K值|D值|KD)";
// 「RSI低於70」「RSI 小於 70」「RSI<70」「RSI在70以下」
const OP_WORD_PATTERN = new RegExp(
  `${NAME}\\s*(?:值|指標)?\\s*(?:在|是|為|要|需要|須)?\\s*(低於|小於|少於|不到|未達|未超過|不超過|高於|大於|超過|多於|<=|>=|<|>|≤|≥)\\s*(\\d+(?:\\.\\d+)?)`,
  "gi"
);
const SUFFIX_PATTERN = new RegExp(
  `${NAME}\\s*(?:值|指標)?\\s*(?:在|是|為|要|需要|須)?\\s*(\\d+(?:\\.\\d+)?)\\s*(以下|以內|之下|以上|之上)`,
  "gi"
);
const WORD_TO_OP: Record<string, ConditionOp> = {
  低於: "lt", 小於: "lt", 少於: "lt", 不到: "lt", 未達: "lt", "<": "lt",
  未超過: "le", 不超過: "le", "<=": "le", "≤": "le", 以下: "le", 以內: "le", 之下: "le",
  高於: "gt", 大於: "gt", 超過: "gt", 多於: "gt", ">": "gt",
  ">=": "ge", "≥": "ge", 以上: "ge", 之上: "ge",
};

function fieldsOf(name: string): ConditionField[] {
  const n = name.toUpperCase();
  if (n === "RSI") return ["rsi"];
  if (n === "K值") return ["k"];
  if (n === "D值") return ["d"];
  return ["k", "d"]; // 「KD 低於 20」＝K、D 兩條都要
}

/** 從一句話解析出「RSI／K值／D值＋門檻」的數值條件（可多個）；沒有就回空陣列。 */
export function parseIndicatorConditions(text: string): IndicatorCondition[] {
  const out: IndicatorCondition[] = [];
  const push = (name: string, opWord: string, rawValue: string) => {
    const op = WORD_TO_OP[opWord.toLowerCase()] ?? WORD_TO_OP[opWord];
    const value = Number(rawValue);
    if (!op || !Number.isFinite(value)) return;
    for (const field of fieldsOf(name)) {
      if (!out.some((c) => c.field === field && c.op === op && c.value === value)) out.push({ field, op, value });
    }
  };
  for (const m of text.matchAll(OP_WORD_PATTERN)) push(m[1], m[2], m[3]);
  for (const m of text.matchAll(SUFFIX_PATTERN)) push(m[1], m[3], m[2]);
  return out;
}

function valueOf(state: IndicatorState, field: ConditionField): number | null {
  if (field === "rsi") return state.rsi;
  if (!state.kd) return null;
  return field === "k" ? state.kd.k : state.kd.d;
}

/** 算不出該指標（資料不足）一律不符合，不猜。 */
export function matchesCondition(state: IndicatorState, c: IndicatorCondition): boolean {
  const v = valueOf(state, c.field);
  if (v == null) return false;
  switch (c.op) {
    case "lt": return v < c.value;
    case "le": return v <= c.value;
    case "gt": return v > c.value;
    case "ge": return v >= c.value;
  }
}

export function matchesAllConditions(state: IndicatorState, conds: readonly IndicatorCondition[]): boolean {
  return conds.every((c) => matchesCondition(state, c));
}

/** 這句話是不是要求「本站評等為建議買進」（跟指標條件組合，例如「RSI70以下建議買進的股票」）。 */
export const WANTS_BUY_RATED_PATTERN = /建議(?:買進|買入|買)|買進建議|適合(?:明天|現在|今天)?買|可以買|值得買|推薦買|評等.{0,4}買/;
export function wantsBuyRated(text: string): boolean {
  return WANTS_BUY_RATED_PATTERN.test(text);
}

/**
 * 這一輪要用的條件：這句話自己有數值條件就用它；沒有、但這句有「建議買進」字眼（「那建議買進的呢」）時沿用上一個使用者問句的條件。
 * 上文沒有數值條件就回空陣列（走原本預先列好的組合）。
 */
export function conditionsForQuestion(question: string, lastUserTurn: string | undefined): { conds: IndicatorCondition[]; rated: boolean } {
  let conds = parseIndicatorConditions(question);
  let rated = wantsBuyRated(question);
  if (conds.length === 0 && rated && lastUserTurn) conds = parseIndicatorConditions(lastUserTurn);
  // 只有條件、這句沒提評等，但上一問有「建議買進」的接續（「那 KD 低於 30 的呢」）：沿用評等要求。
  if (conds.length > 0 && !rated && lastUserTurn && wantsBuyRated(lastUserTurn) && question.trim().length <= 20) rated = true;
  return { conds, rated };
}

// ---------------------------------------------------------------- MACD 與 KD 同時即將交叉

export type CrossDirection = "golden" | "death";

export interface DualNearEntry {
  item: TechScreenItem;
  /** KD 照目前速度推估幾個交易日交叉（差距沒在縮小時 null） */
  kdEst: number | null;
  /** MACD 照目前速度推估幾個交易日交叉 */
  macdEst: number | null;
  /** 兩者都符合正式「即將交叉」門檻（nearCross.ts） */
  bothNear: boolean;
}

/** 「最接近」名單：兩條都還在交叉前且差距都在縮小，但推估天數超過正式門檻者，最多收到這個天數。 */
export const DUAL_CLOSEST_MAX_EST_DAYS = 10;
/** 最接近名單最多列幾檔。 */
export const DUAL_CLOSEST_LIMIT = 8;

/** gap（今天，需>0＝尚未交叉）與前一天 gap 線性外推幾天歸零；沒在縮小回 null。 */
function estDays(gapToday: number, gapPrev: number): number | null {
  const shrink = gapPrev - gapToday;
  if (!(gapToday > 0) || !(shrink > 0)) return null;
  return gapToday / shrink;
}

/**
 * 同時往同一方向接近交叉的股票（使用者：「兩種線快線都快超過慢線」＝MACD 與 KD 都在黃金交叉前、快要追上）。
 * - both：KD 與 MACD 都符合正式「即將交叉」門檻（nearCross.ts，已用回測校準）。
 * - closest：不是 both，但兩條都還在交叉前、差距都在縮小，推估天數 ≤ DUAL_CLOSEST_MAX_EST_DAYS，
 *   依兩者較慢的推估天數由近到遠。
 */
export function rankDualNearCross(items: readonly TechScreenItem[], direction: CrossDirection): { both: DualNearEntry[]; closest: DualNearEntry[] } {
  const sign = direction === "golden" ? 1 : -1; // 黃金：慢線−快線 > 0 ＝ 尚未交叉
  const both: DualNearEntry[] = [];
  const closest: DualNearEntry[] = [];
  for (const item of items) {
    const { kd, macdReading: m } = item.state;
    if (!kd || !m) continue;
    const kdEst = estDays(sign * (kd.d - kd.k), sign * (kd.prevD - kd.prevK));
    const macdEst = estDays(sign * (m.signal - m.dif), sign * (m.prevSignal - m.prevDif));
    const bothNear = item.state.kdNearCross?.direction === direction && item.state.macdNearCross?.direction === direction;
    const entry: DualNearEntry = { item, kdEst, macdEst, bothNear };
    if (bothNear) both.push(entry);
    else if (kdEst != null && macdEst != null && Math.max(kdEst, macdEst) <= DUAL_CLOSEST_MAX_EST_DAYS) closest.push(entry);
  }
  const slowest = (e: DualNearEntry) => Math.max(e.kdEst ?? Infinity, e.macdEst ?? Infinity);
  both.sort((a, b) => slowest(a) - slowest(b));
  closest.sort((a, b) => slowest(a) - slowest(b));
  return { both, closest: closest.slice(0, DUAL_CLOSEST_LIMIT) };
}
