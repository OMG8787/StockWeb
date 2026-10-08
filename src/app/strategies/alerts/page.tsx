import type { Metadata } from "next";
import AlertsClient from "./AlertsClient";

export const metadata: Metadata = { title: "即時提醒" };

export default function Page() {
  return <AlertsClient />;
}
