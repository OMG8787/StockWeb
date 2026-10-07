import type { Metadata } from "next";
import StrategiesClient from "./StrategiesClient";

export const metadata: Metadata = { title: "策略庫" };

export default function Page() {
  return <StrategiesClient />;
}
