import type { Metadata } from "next";
import BacktestClient from "./BacktestClient";

export const metadata: Metadata = { title: "策略回測" };

export default function Page() {
  return <BacktestClient />;
}
