import type { Metadata } from "next";
import IndicatorsClient from "./IndicatorsClient";

export const metadata: Metadata = { title: "參考指標" };

export default function Page() {
  return <IndicatorsClient />;
}
