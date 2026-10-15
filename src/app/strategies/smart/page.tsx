import type { Metadata } from "next";
import SmartListClient from "./SmartListClient";

export const metadata: Metadata = { title: "我的智能清單" };

export default function Page() {
  return <SmartListClient />;
}
