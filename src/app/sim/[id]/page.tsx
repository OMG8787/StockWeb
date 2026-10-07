import type { Metadata } from "next";
import SimDetailClient from "./SimDetailClient";

export const metadata: Metadata = { title: "模擬倉" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SimDetailClient id={id} />;
}
