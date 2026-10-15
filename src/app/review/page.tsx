import type { Metadata } from "next";
import ReviewClient from "./ReviewClient";

export const metadata: Metadata = {
  title: "推薦回顧",
  description: "本站每次推薦（AI 建議名單、技術訊號共振股）的推薦價、買點區間、出場價，以及照建議操作的實際報酬、勝率與同期 0050 對照。",
  robots: { index: false },
};

export default function ReviewPage() {
  return <ReviewClient />;
}
