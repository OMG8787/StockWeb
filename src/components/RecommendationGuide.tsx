import Link from "next/link";

/**
 * 「本站推薦以誰為主」說明（2026-10-15 使用者：「現在推薦股票就散落各地，然後推薦的還都沒有重複，不知道到底以誰為主」）。
 *
 * 唯一的買賣結論是「本站綜合評等」（程式計算、個股頁／名單／AI 問答同一份，每檔旁的「本站建議：買／不買」標籤就是它）；
 * AI 建議名單是評等為建議買進、依把握程度排名的前幾檔；其他名單（技術訊號共振、焦點排行、漲跌榜）只是候選或市場資訊。
 * full＝推薦總覽頁頂端的完整版；compact＝其他名單旁的一行提示。
 */
export default function RecommendationGuide({ variant = "compact", context }: { variant?: "full" | "compact"; context?: string }) {
  if (variant === "compact") {
    return (
      <p className="rounded-md bg-(--page-plane) px-3 py-1.5 text-xs text-(--text-secondary)">
        🧭 {context ? `${context}：` : ""}要不要買以「本站建議」（本站綜合評等）為準；本站的推薦名單是{" "}
        <Link href="/action" className="text-(--accent) underline">
          AI 建議名單
        </Link>
        ，所有名單一次看請到{" "}
        <Link href="/overview" className="text-(--accent) underline">
          推薦總覽
        </Link>
        。
      </p>
    );
  }
  return (
    <details open className="rounded-lg border border-(--gridline) bg-(--surface-1) px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-semibold">🧭 本站推薦以誰為主？（點一下收合）</summary>
      <ol className="mt-2 list-inside list-decimal space-y-1 text-(--text-secondary)">
        <li>
          <b className="text-(--text-primary)">唯一的買賣結論＝「本站建議」（本站綜合評等）</b>：程式依技術、籌碼、持股結構、估值、財報五個面向計算，個股頁、各名單、AI 問答看到的都是同一份；表格裡的「買／不買」標籤就是它。
        </li>
        <li>
          <b className="text-(--text-primary)">本站的推薦名單＝🎯 AI 建議名單</b>：本站建議為「買」的股票，依把握程度排名的前幾檔（檔數在首頁「我的關注 → AI 建議清單」設定）。
        </li>
        <li>
          <b className="text-(--text-primary)">🤖 AI 模擬組合</b>：照 AI 建議名單自動買賣的示範帳戶（最多 6 檔），用來檢驗推薦實際賺不賺。持股是「買進當時」名單裡的股票，之後名單換了不會馬上賣（本站建議轉為出場／減碼、或跌破出場價才賣），所以跟今天的名單不一定一樣。**名單裡「不買」不等於要賣**：「不買」是「還沒持有的人不要新買」；已持有的人看「持有中建議」——只有破底（跌破所有均線與近期低點）才建議出場、不支持的面向 ≥ 2 才建議減碼，其餘是「續抱觀察、不加碼」。
        </li>
        <li>
          <b className="text-(--text-primary)">📡 技術訊號共振股、焦點排行、漲跌榜</b>：只是候選或市場資訊（只看技術面或漲跌），<b>不是買進推薦</b>；裡面的股票本站建議可能是「不買」。
        </li>
        <li>
          <b className="text-(--text-primary)">🧠 我的智能清單、🔔 提醒訊號</b>：依你自己的策略挑出來的，跟本站建議分開看。
        </li>
      </ol>
      <p className="mt-2 text-xs text-(--text-muted)">
        各名單過去推薦的成績：<Link href="/review" className="text-(--accent) underline">📈 推薦回顧</Link>、
        <Link href="/scoreboard" className="text-(--accent) underline">成績看板</Link>。
      </p>
    </details>
  );
}
