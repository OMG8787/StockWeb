import type { Metadata } from "next";
import CompareClient from "./CompareClient";

export const metadata: Metadata = { title: "策略疊圖" };

export default function Page() {
  return <CompareClient />;
}
