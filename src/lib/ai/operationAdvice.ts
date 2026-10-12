import { confidenceText, ratingConfidence, type SiteRating } from "./siteRating";

/**
 * 關注清單的「操作建議」欄（2026-10-12 使用者：買、賣、續抱、買*、賣*、續抱*，有 * 就是需要觀察，
 * 滑鼠移上去要說明「目前建議續抱但需觀察」之類）。
 *
 * 純邏輯、無 I/O，唯一來源：結論一律來自本站綜合評等（stockRating／siteRating，跟個股頁、今日建議、AI 問答同一份），
 * 這裡只把評等翻成這一欄的字樣與說明，不重算任何判斷。
 *  - 沒持有：建議買進＝「買」；建議先不要買＝「不買」。
 *  - 持有中：可分批加碼＝「買」（加碼）；續抱＝「續抱」；建議減碼／建議出場＝「賣」。
 *  - 「*」＝需觀察，只要符合任一（說明裡會逐條列出來）：①結論正在「連續 2 個交易日確認」期間（今天的資料指向不同結論，
 *    暫時維持前一交易日）②有短線風險提示（急漲、RSI／布林漲多警訊、離支撐區遠）③大盤偏弱的提示
 *    ④本站把握程度為「低」。
 */

export type AdviceAction = "買" | "賣" | "續抱" | "不買";

export interface OperationAdvice {
  action: AdviceAction;
  /** 需觀察（顯示成「買*」） */
  watch: boolean;
  /** 欄位上顯示的字（含 *） */
  text: string;
  /** 滑鼠移上去的說明（多行） */
  tip: string;
}

const ACTION_VERB: Record<AdviceAction, string> = { 買: "買進", 賣: "賣出（減碼或出場）", 續抱: "續抱", 不買: "先不要買" };

export function operationAdvice(r: SiteRating, held: boolean): OperationAdvice {
  const action: AdviceAction = held
    ? r.holdingCode === "add"
      ? "買"
      : r.holdingCode === "hold"
        ? "續抱"
        : "賣"
    : r.code === "avoid"
      ? "不買"
      : "買";
  const watchReasons: string[] = [];
  if (r.pendingChange) watchReasons.push(`結論還在確認期：${r.pendingChange}`);
  if (r.riskNote) watchReasons.push(r.riskNote);
  if (r.marketNote) watchReasons.push(r.marketNote);
  const conf = ratingConfidence(r);
  if (!held && r.code !== "avoid" && conf?.level === "低") watchReasons.push(`本站把握程度低（${conf.why}）`);
  const watch = watchReasons.length > 0;

  const verb = ACTION_VERB[action] + (held && action === "買" ? "（可分批加碼）" : "");
  const lines = [
    `${held ? "你持有中" : "你還沒持有"}：目前建議${verb}${watch ? "，但需觀察" : ""}。`,
    `本站評等：${held ? r.holdingLabel : r.label}`,
    `理由：${r.reason}`,
  ];
  if (watch) lines.push(`需觀察的原因：\n・${watchReasons.join("\n・")}`);
  const ct = confidenceText(r);
  if (ct) lines.push(ct);
  lines.push("（依本站綜合評等自動產生，僅供參考，不構成投資建議；沒填持有股數與成本時，以「還沒持有」判斷）");
  return { action, watch, text: `${action}${watch ? "*" : ""}`, tip: lines.join("\n") };
}
