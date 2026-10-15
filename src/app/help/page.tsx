import type { Metadata } from "next";
import HelpClient from "./HelpClient";

export const metadata: Metadata = { title: "操作手冊", robots: { index: false } };

export default function HelpPage() {
  return <HelpClient />;
}
