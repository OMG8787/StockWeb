// 跨模型 AI 品質評測的型別（cases.ts 是純資料、graders.ts 是純函式、run.ts 是執行器）。
import type { ChatTurn } from "@/lib/ai/types";
import type { HoldingInput } from "@/lib/ai/askTypes";

/** 每題可宣告的「題目專屬」檢查；通用檢查（繁中、英文句、內部標記、價位、代號、時段措辭…）每題自動套用。 */
export type CheckSpec =
  /** 第一句含該檔【本站綜合評等】字樣（held＝用已持有字樣）。 */
  | { kind: "ratingFirst"; symbol: string; held?: boolean }
  /** 回答裡每一檔都提到各自的評等字樣（多檔／名單題）。 */
  | { kind: "ratingEach"; symbols: string[] }
  /** 比較題：第一、二句要選出其中一檔。 */
  | { kind: "picksOne"; symbols: string[] }
  /** 回答裡出現的股票代號只能是這些（不可扯入無關個股）。 */
  | { kind: "onlySymbols"; allowed: string[] }
  /** 只能推薦參考資料裡有【本站綜合評等】的股票（全市場推薦／篩選）。 */
  | { kind: "onlyRatedSymbols" }
  /** 至少符合一個 pattern。 */
  | { kind: "require"; name: string; any: string[] }
  /** 一個都不能符合。 */
  | { kind: "forbid"; name: string; any: string[] }
  /** 中文字數區間（不含空白、標點也算）。 */
  | { kind: "length"; min?: number; max?: number }
  /** 是非題：第一句不可只以「有的／沒有／是的」開頭，且要帶主詞。 */
  | { kind: "yesNoDirect"; subject: string[] }
  /** 持股題：每檔的賣／留判斷要跟程式的「已持有」評等一致。 */
  | { kind: "holdingVerdicts"; symbols: string[] }
  /** 「賣掉哪些」列出的檔數要跟程式評等減碼／出場的完全相同。 */
  | { kind: "sellListMatches"; symbols: string[] }
  /** 參考資料有「融資融券組合判讀」【訊號】時，回答要講出訊號名稱；沒有訊號（中性）就不適用、視為通過。 */
  | { kind: "marginSignalMention" }
  /** 未持有不可用「停損」二字。 */
  | { kind: "noStopLossUnheld" };

export interface EvalCase {
  id: string;
  /** 一句話說明這題在測什麼 */
  title: string;
  question: string;
  /** 個股頁「問AI關於」按鈕會帶 contextSymbol */
  contextSymbol?: string;
  history?: ChatTurn[];
  holdings?: HoldingInput[];
  /** 假時鐘（台北時間 ISO，例如 "2026-10-05T10:30:00+08:00"）：測時段立場用，只影響組參考資料那一段 */
  clock?: string;
  checks: CheckSpec[];
  /** 題目來源（使用者回報日期、規則名稱） */
  source: string;
  tags: string[];
}

export interface CheckResult {
  rule: string;
  pass: boolean;
  detail?: string;
}
