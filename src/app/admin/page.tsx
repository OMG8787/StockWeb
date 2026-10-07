import type { Metadata } from "next";
import AdminClient from "./AdminClient";

export const metadata: Metadata = { title: "帳號與權限" };

export default function AdminPage() {
  return <AdminClient />;
}
