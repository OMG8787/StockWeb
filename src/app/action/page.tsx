import type { Metadata } from "next";
import ActionBriefCard from "@/components/ActionBriefCard";

export const metadata: Metadata = {
  title: "今日建議",
  description: "給沒有股市背景的人看的今日買進建議：直接講今天可以買哪幾檔、為什麼，以及哪些漲很多的股票反而不該追。",
  alternates: { canonical: "/action" },
};

export default function ActionPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">今日建議</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">
          不需要懂股票也看得懂：直接講今天可以買哪幾檔股票、為什麼。每一檔都要技術面、籌碼面（法人買賣超）、持股結構面（大戶／外資持股比例、融資使用率）、基本面（本益比、殖利率）、財報面（營收成長）多方同時支持才會被列進建議，只是今天漲很多但其他面向沒跟上的不算，反而會被點出來提醒不要追。真的沒有夠格的標的時會直接說「今天建議觀望」，不會硬湊。
        </p>
      </div>
      <ActionBriefCard />
    </div>
  );
}
