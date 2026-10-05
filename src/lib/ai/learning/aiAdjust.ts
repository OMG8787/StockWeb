import { RATING_LABEL, type RatingCode } from "../siteRating";

/**
 * AI 判斷層（學習循環第二階段）的純邏輯部分（無 I/O，有測試）：等級位移、解析 AI 的 JSON、給使用者看的一行。
 * I/O（呼叫 AI、快取、寫評等紀錄）在 ../aiJudge.ts。
 */

/**
 * 冠軍／挑戰者：AI 調整「能不能改變主結論」的開關。
 * 預設 false——在成績看板的冠軍／挑戰者統計符合 AI_ADJUST_PROMOTION 判準之前，AI 調整只顯示「AI 看法」一行、
 * 寫進評等紀錄 `ai` 欄位累積成績，使用者看到的結論一律是程式評等。
 */
export const AI_ADJUST_AFFECTS_CONCLUSION = false;

/**
 * 何時可以放寬 AI 調整空間（把 AI_ADJUST_AFFECTS_CONCLUSION 改 true）的判準，三項都要成立：
 * 1. 有 AI 判斷、且已滿 5 個交易日的紀錄 ≥ minSamples 筆（其中 AI 實際調整 delta≠0 的 ≥ minAdjusted 筆，
 *    delta=0 時兩邊結論相同、比不出差別）；
 * 2. 同一批紀錄上「AI 調整後結論」的 5 日平均獎勵比「程式評等」高 ≥ minEdgePct 個百分點；
 * 3. 逐筆配對差（AI 獎勵−程式獎勵）的 t 值 ≥ minT（約 95% 信心不是運氣）。
 * 判準由每日學習工作計算（learning/championChallenger.ts），結果顯示在 /scoreboard；改開關仍由人決定。
 */
export const AI_ADJUST_PROMOTION = { minSamples: 60, minAdjusted: 20, minEdgePct: 0.3, minT: 2 } as const;

export type AiDelta = -1 | 0 | 1;
export type AiConfidence = "高" | "中" | "低";

export interface AiJudgment {
  /** 判斷時的程式評等（評等在同一天改變時，舊判斷不再適用） */
  baseCode: RatingCode;
  delta: AiDelta;
  /** AI 調整後的結論 */
  code: RatingCode;
  reason: string;
  confidence: AiConfidence;
  model?: string;
  at: string;
}

/** 等級由低到高（2026-10-05 評等改果斷二分，不再有等回檔；舊紀錄的等回檔見 shiftCode）。 */
const LADDER: RatingCode[] = ["avoid", "buy"];

/** 程式評等調升／調降一級（到頂／到底就停在原級）。舊紀錄的「等回檔」介於兩者之間：調升＝買進、調降＝先不要買。 */
export function shiftCode(code: RatingCode, delta: AiDelta): RatingCode {
  if (code === "buy-on-pullback") return delta > 0 ? "buy" : delta < 0 ? "avoid" : code;
  const i = LADDER.indexOf(code);
  return LADDER[Math.max(0, Math.min(LADDER.length - 1, i + delta))];
}

/** 實際有效的位移（到頂再調升、到底再調降都算 0）。 */
export function effectiveDelta(code: RatingCode, delta: AiDelta): AiDelta {
  const to = shiftCode(code, delta);
  return to === code ? 0 : delta;
}

const DELTA_OF: Record<string, AiDelta> = { up: 1, keep: 0, down: -1, "+1": 1, "0": 0, "-1": -1, 調升: 1, 維持: 0, 調降: -1 };

/**
 * 解析 AI 回傳的 JSON 陣列 [{symbol, adjust: up|keep|down, reason, confidence}]，只收 `bases` 裡有的代號。
 * 格式錯或缺欄位的那一檔略過（＝維持程式評等）。
 */
export function parseAiJudgments(
  answer: string,
  bases: Map<string, RatingCode>,
  now: Date = new Date(),
  model?: string
): Map<string, AiJudgment> {
  const out = new Map<string, AiJudgment>();
  const m = answer.match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sym = String(o.symbol ?? "").trim().toUpperCase();
    const base = bases.get(sym);
    const raw = DELTA_OF[String(o.adjust ?? "").trim()];
    const reason = typeof o.reason === "string" ? o.reason.trim().slice(0, 120) : "";
    if (!base || raw == null || (raw !== 0 && !reason)) continue;
    const conf = String(o.confidence ?? "").trim();
    const confidence: AiConfidence = conf === "高" || conf === "低" ? conf : "中";
    const delta = effectiveDelta(base, raw);
    out.set(sym, { baseCode: base, delta, code: shiftCode(base, delta), reason, confidence, model, at: now.toISOString() });
  }
  return out;
}

/** 個股資料裡 AI 看法那一行的標題（askSystemCompose.ts 依這個標題帶 RULE_AI_VIEW）。 */
export const AI_VIEW_TITLE = "【AI 判斷層（只是看法，不改結論）】";

/** 使用者看得到的一行；AI 沒調整（或判斷是針對另一個程式評等）回 null。 */
export function describeAiView(j: AiJudgment | null | undefined, programCode: RatingCode): string | null {
  if (!j || j.baseCode !== programCode || j.delta === 0) return null;
  const dir = j.delta > 0 ? "調升一級" : "調降一級";
  const reason = j.reason.replace(/[。.]+$/, "");
  const note = AI_ADJUST_AFFECTS_CONCLUSION ? "" : "；僅供參考，結論仍以本站綜合評等為準";
  return `AI 看法：${dir}（${RATING_LABEL[j.code]}），因為${reason}（把握：${j.confidence}${note}）`;
}
