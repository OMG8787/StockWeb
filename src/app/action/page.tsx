import type { Metadata } from "next";
import ActionBriefCard from "@/components/ActionBriefCard";
import ActionBriefHeading from "@/components/ActionBriefHeading";

export const metadata: Metadata = {
  // 14:30 後頁首與卡片會改成「明日開盤建議」（見 ActionBriefHeading），metadata 是靜態的所以兩種都寫。
  title: "今日／明日開盤建議",
  description: "給沒有股市背景的人看的買進建議：盤中講今天可以買哪幾檔，收盤後改講明天開盤怎麼進場，以及哪些漲很多的股票反而不該追。",
  alternates: { canonical: "/action" },
};

export default function ActionPage() {
  return (
    <div className="space-y-4">
      <ActionBriefHeading />
      <ActionBriefCard />
    </div>
  );
}
