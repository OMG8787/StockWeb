import type { Metadata } from "next";
import SimPortfolioPage from "@/components/simPortfolio/SimPortfolioPage";

export const metadata: Metadata = {
  title: "AI 模擬投資組合",
  description: "虛擬資金 100 萬元，依本站綜合評等在盤中與收盤後自動買賣的模擬投資組合：淨值走勢、對照 0050、持股、交易紀錄與 AI 每日檢討。",
  robots: { index: false },
};

export default function PortfolioPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">🤖 AI 模擬投資組合</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">100 萬虛擬資金，每天盤中與收盤後依本站評等自動調整持股，誠實記錄每一筆交易與成效。</p>
      </div>
      <SimPortfolioPage />
    </div>
  );
}
