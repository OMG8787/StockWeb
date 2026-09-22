import type { IndexQuote, TaifexFuturesQuote } from "@/lib/data";
import { describeTaifexNightFutures } from "@/lib/data";

/**
 * 「【大盤概況（台股＋美股）】」這段文字，`ask.ts`（AI問答）、`actionBrief.ts`
 * （今日建議）、`brief.ts`（每日快報）三個檔案原本各自重複維護一份幾乎一模一樣
 * 的組裝邏輯——2026-09-22 地毯式審計發現這是「同一段商業邏輯散落多處」的例子，
 * 抽成這個共用函式，之後要調整大盤概況的措辭/格式，改一處三邊都生效，不用
 * 記得同步改三個檔案。
 *
 * 回傳值不含最前面的「【大盤概況（台股＋美股）】」標題行——三個呼叫端各自決定
 * 要不要加、加在陣列的哪個位置，這裡只負責內文兩行（指數清單 + 台指期夜盤）。
 */
export function buildMarketOverviewText(indices: IndexQuote[], taifexFutures: TaifexFuturesQuote | null): string {
  const indexLines =
    indices.length === 0
      ? "（大盤指數目前無法取得）"
      : indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n");
  // 台指期夜盤跟前面的加權指數/道瓊等現貨指數不同，是「盤後衍生性商品」，
  // 一定要附帶交易中/已收盤狀態跟資料時間，不能讓 AI 誤把它講成即時現貨指數。
  return `${indexLines}\n${describeTaifexNightFutures(taifexFutures)}`;
}
