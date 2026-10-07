/**
 * 回答提到三大法人買賣超、但資料不是「今天」時，保證有講資料日期（2026-10-07 使用者回報達新 10:38：「三大法人當天的買賣超也要参考」）。
 * 事實：個股三大法人（證交所 T86／櫃買）約收盤後 15:00 才公布，盤中沒有官方當天資料，能用的是前一個交易日。
 * 資料面已在籌碼區塊標題寫明日期（grounding/stockNewsAndChips.ts chipsSectionTitle），但模型常只寫「三大法人合計賣超22張」不講是哪天，
 * 使用者就以為是今天的、或以為系統沒參考當天。跟 ensureMarginSignalMentioned 同一個做法：確定性補一句程式寫好的說明（不重生）。
 * 純函式（有測試 src/__tests__/chipsDateMention.test.ts）。
 */

const CHIPS_TITLE = /籌碼面（(\d{2})\/(\d{2})的資料(；今天(\d{2}\/\d{2})的個股三大法人|，最近一個交易日；今天非交易日)?/;
const INSTITUTION_MENTION = /(?:三大法人|外資|投信|自營商|法人)[^。\n]{0,30}?(?:買超|賣超|買賣超)/;
/** 回答已經交代資料日期／時間點的字眼。 */
function alreadyDated(answer: string, month: string, day: string): boolean {
  const m = String(Number(month));
  const d = String(Number(day));
  const dateForms = [`${month}/${day}`, `${m}/${d}`, `${m}月${d}日`, `${month}月${day}日`];
  if (dateForms.some((f) => answer.includes(f))) return true;
  return /前一(?:個)?交易日|上一(?:個)?交易日|昨(?:天|日)|最近一個交易日|尚未公布|還沒公布|盤後(?:才)?公布|15[:：]00/.test(answer);
}

export function ensureChipsDateMentioned(answer: string, grounding: string): { text: string; appended: string[] } {
  const title = grounding.match(CHIPS_TITLE);
  // 沒有籌碼區塊、或是「今天的資料」（標題不符合上面的格式）→ 不需要補。
  if (!title) return { text: answer, appended: [] };
  const [, month, day, tail] = title;
  const hit = answer.match(INSTITUTION_MENTION);
  if (!hit || hit.index == null) return { text: answer, appended: [] };
  if (alreadyDated(answer, month, day)) return { text: answer, appended: [] };
  const note = tail && tail.startsWith("，")
    ? `（註：法人買賣超是 ${month}/${day}（最近一個交易日）的數字，今天非交易日。）`
    : `（註：三大法人買賣超是 ${month}/${day} 的資料；今天${tail ? ` ${tail.match(/(\d{2}\/\d{2})/)?.[1] ?? ""}` : ""}的個股法人資料要收盤後約 15:00 才公布，盤中沒有官方當天數字。）`;
  const end = answer.slice(hit.index).search(/[。\n]/);
  const at = end < 0 ? answer.length : hit.index + end + (answer[hit.index + end] === "。" ? 1 : 0);
  return { text: `${answer.slice(0, at)}${note}${answer.slice(at)}`, appended: [note] };
}
