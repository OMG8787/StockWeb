import type { Metadata } from "next";
import OverviewClient from "./OverviewClient";

export const metadata: Metadata = {
  title: "推薦總覽",
  description: "一次看本站所有推薦來源：AI 建議名單、技術訊號共振股、即時提醒訊號與 AI 模擬組合持股，每檔標出來源與本站建議。",
  robots: { index: false },
};

export default function OverviewPage() {
  return <OverviewClient />;
}
