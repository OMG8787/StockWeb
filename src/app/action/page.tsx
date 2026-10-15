import type { Metadata } from "next";
import Link from "next/link";
import ActionBriefCard from "@/components/ActionBriefCard";
import ActionBriefHeading from "@/components/ActionBriefHeading";
import ActionListLog from "@/components/ActionListLog";

export const metadata: Metadata = {
  // 14:30 後頁首與卡片會改成「明日操作建議」（見 ActionBriefHeading），metadata 是靜態的所以兩種都寫。
  title: "今日建議／明日操作建議",
  description: "給沒有股市背景的人看的買進建議：盤中講今天可以買哪幾檔，收盤後改講明天開盤與盤中怎麼操作，以及哪些漲很多的股票反而不該追。",
  alternates: { canonical: "/action" },
};

export default function ActionPage() {
  return (
    <div className="space-y-4">
      <ActionBriefHeading />
      <p className="rounded-md bg-(--page-plane) px-3 py-1.5 text-xs text-(--text-secondary)">
        🧭 這裡就是本站的推薦名單（AI 建議名單，依本站綜合評等與把握程度排出）；跟技術訊號共振、智能清單、AI 模擬組合一起比較請看{" "}
        <Link href="/overview" className="text-(--accent) underline">推薦總覽</Link>，過去推薦準不準看{" "}
        <Link href="/review" className="text-(--accent) underline">推薦回顧</Link>。
      </p>
      <ActionBriefCard />
      <ActionListLog />
    </div>
  );
}
