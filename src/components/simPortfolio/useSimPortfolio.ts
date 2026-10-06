"use client";

import { useCallback, useState } from "react";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import type { SimPortfolioView } from "@/lib/simPortfolio/view";

/**
 * 首頁卡片與 /portfolio 頁共用：抓 /api/sim-portfolio，台股盤中跟全站同一套輪詢節奏（useLivePolling＋getPollDecision）。
 * TODO（全站自動刷新 AutoRefresh 上線後）：改接共用機制。
 */
export function useSimPortfolio(trades?: number): { data: SimPortfolioView | null; failed: boolean } {
  const [data, setData] = useState<SimPortfolioView | null>(null);
  const [failed, setFailed] = useState(false);
  const url = `/api/sim-portfolio${trades ? `?trades=${trades}` : ""}`;
  const onFetch = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as SimPortfolioView);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [url]);
  useLivePolling({ decide: (now, settled) => getPollDecision("TW", now, settled), onFetch, fetchOnMount: true, restartKey: url });
  return { data, failed: failed && !data };
}

export const ntd = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
export const pct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
export const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "text-(--price-up)" : "text-(--price-down)");
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export const SIM_DISCLAIMER =
  "模擬交易、非投資建議：虛擬資金 100 萬元，買賣全部由本站程式依「本站綜合評等」自動決定（AI 只寫每日檢討），成交價假設為執行當下的即時價／收盤價，已計手續費與證交稅、未計滑價與最低手續費。";
