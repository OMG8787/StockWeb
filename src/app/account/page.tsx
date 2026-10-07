import type { Metadata } from "next";
import { Suspense } from "react";
import AccountClient from "./AccountClient";

export const metadata: Metadata = { title: "帳號設定" };

export default function AccountPage() {
  return (
    <Suspense>
      <AccountClient />
    </Suspense>
  );
}
