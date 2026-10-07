"use client";

import type { ReactNode } from "react";
import { useHasPerm } from "@/lib/auth/useProfile";

/** 帳號沒有對應權限時不顯示（也就不會去打會被 proxy 擋下的 API）。 */
export default function RequirePerm({ need, children }: { need: number[]; children: ReactNode }) {
  return useHasPerm(need) ? <>{children}</> : null;
}
