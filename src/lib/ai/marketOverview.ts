import type { IndexQuote, MacroSnapshot, TaifexFuturesQuote } from "@/lib/data";
import { describeTaifexNightFutures } from "@/lib/data";
import { describeMacroSnapshot } from "./macroText";
import { describeMarketHistory } from "./marketHistoryText";

/**
 * 「【大盤概況（台股＋美股）】」這段文字，`ask.ts`（AI問答）、`actionBrief.ts`
 * （今日建議）、`brief.ts`（每日快報）三個檔案原本各自重複維護一份幾乎一模一樣
 * 的組裝邏輯——2026-09-22 地毯式審計發現這是「同一段商業邏輯散落多處」的例子，
 * 抽成這個共用函式，之後要調整大盤概況的措辭/格式，改一處三邊都生效，不用
 * 記得同步改三個檔案。
 *
 * 回傳值不含最前面的「【大盤概況（台股＋美股）】」標題行——三個呼叫端各自決定
 * 要不要加、加在陣列的哪個位置，這裡只負責內文（指數清單 + 台指期夜盤 + 美國總經）。
 *
 * `macro`（2026-09-30 新增，FRED 總經）刻意做成**必填**參數而不是選填：三個呼叫端都
 * 必須自己 `getMacroSnapshot()` 帶進來，編譯器會擋下漏帶的呼叫端，不會出現「某一頁
 * 的 AI 看得到總經、另一頁看不到」的隱藏落差（規則九第3點）。沒設定 FRED 金鑰時
 * getMacroSnapshot() 回 null，這裡輸出跟加功能之前逐字相同。
 *
 * 2026-10-04：`macro.marketHistory`（getMacroSnapshot() 一併抓好的大盤／總體歷史脈絡）
 * 有內容時，最後再接一段【市場歷史與情緒走勢】（見 marketHistoryText.ts）；這個函式
 * 維持同步、簽名不變，三個呼叫端不用改。
 */
export function buildMarketOverviewText(
  indices: IndexQuote[],
  taifexFutures: TaifexFuturesQuote | null,
  macro: MacroSnapshot | null
): string {
  const indexLines =
    indices.length === 0
      ? "（大盤指數目前無法取得）"
      : indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n");
  // 台指期夜盤跟前面的加權指數/道瓊等現貨指數不同，是「盤後衍生性商品」，
  // 一定要附帶交易中/已收盤狀態跟資料時間，不能讓 AI 誤把它講成即時現貨指數。
  const macroText = describeMacroSnapshot(macro);
  const historyText = describeMarketHistory(macro?.marketHistory);
  return `${indexLines}\n${describeTaifexNightFutures(taifexFutures)}${macroText ? `\n${macroText}` : ""}${historyText ? `\n${historyText}` : ""}`;
}
