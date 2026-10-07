import type { Metadata } from "next";
import SimListClient from "./SimListClient";

export const metadata: Metadata = { title: "模擬倉" };

export default function Page() {
  return <SimListClient />;
}
