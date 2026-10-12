"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { ActionBrief } from "@/lib/ai/actionBrief";
import type { SimPortfolioView } from "@/lib/simPortfolio/view";
import { PERM } from "@/lib/auth/permissions";
import { useHasPerm } from "@/lib/auth/useProfile";
import { clientRefreshMs } from "@/lib/autoRefresh";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { AI_PICK_LIMIT_DEFAULT, normalizePickLimit } from "@/lib/aiPickLimits";
import { sendJson } from "@/components/auth/ui";

/**
 * 「我的關注」旁邊的兩份 AI 名單（2026-10-09 使用者要求）：①AI 模擬持股（AI 模擬投資組合目前持有的）
 * ②AI 建議清單（今日建議／明日操作建議的名單）。我的關注清單裡的股票如果 AI 也持有或建議，會在名稱後面標出來。
 *
 * 資料來源跟專屬頁面同一個 API（/api/sim-portfolio、/api/action-brief），沒有複製任何判斷邏輯；
 * 帳號沒有該功能權限（AI 模擬組合／今日建議）就完全不抓、不顯示該名單。台股專用（兩份名單都只有台股）。
 */

export interface AiPickRow {
  symbol: string;
  name: string;
  /** 本站評等字樣（例：建議買進（現價 557 可分批買；…）） */
  label: string;
  plan?: string;
  confidence?: string;
  riskNote?: string;
}

export interface AiHoldRow {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  price: number;
  changePercent: number | null;
  /** 未實現損益金額與百分比（來自 AI 模擬組合，已扣假設賣出成本，跟首頁卡片、/portfolio 同一份） */
  pnl: number;
  pnlPct: number;
  weightPct: number;
  buyDay: string;
  stopPrice: number | null;
}

export interface AiLists {
  canPicks: boolean;
  canHoldings: boolean;
  /** null＝還在載入或沒權限 */
  picks: AiPickRow[] | null;
  holdings: AiHoldRow[] | null;
  picksFailed: boolean;
  holdingsFailed: boolean;
  /** 建議名單的標題（今日建議／明日操作建議） */
  picksTitle: string;
  /** 這個帳號設定要看前幾檔（依本站評分排名） */
  pickLimit: number;
  /** 排名名單實際總檔數（設定檔數可能比它大） */
  pickTotal: number;
  setPickLimit: (n: number) => void;
}

const EMPTY: AiLists = { canPicks: false, canHoldings: false, picks: null, holdings: null, picksFailed: false, holdingsFailed: false, picksTitle: "AI 建議清單", pickLimit: AI_PICK_LIMIT_DEFAULT, pickTotal: 0, setPickLimit: () => {} };
const Ctx = createContext<AiLists>(EMPTY);

export function AiListsProvider({ children }: { children: ReactNode }) {
  const canPicks = useHasPerm([PERM.ACTION]);
  const canHoldings = useHasPerm([PERM.SIM_PORTFOLIO]);
  // trades=1：只要持股，不要整份交易紀錄（省流量）
  const briefState = useFetchOnce<{ actionBrief: ActionBrief }>(canPicks ? "/api/action-brief" : null, clientRefreshMs);
  const simState = useFetchOnce<SimPortfolioView>(canHoldings ? "/api/sim-portfolio?trades=1" : null, clientRefreshMs);
  const limitState = useFetchOnce<{ limit: number }>(canPicks ? "/api/action-brief/limit" : null);
  const [override, setOverride] = useState<number | null>(null);
  const pickLimit = override ?? normalizePickLimit(limitState.data?.limit);
  const setPickLimit = (n: number) => {
    setOverride(n);
    void sendJson("/api/action-brief/limit", { limit: n }).catch(() => {});
  };
  const value = useMemo<AiLists>(() => {
    const brief = briefState.data?.actionBrief ?? null;
    const sim = simState.data;
    return {
      canPicks,
      canHoldings,
      picks: brief ? (brief.listPicks ?? brief.picks).slice(0, pickLimit).map((p) => ({ symbol: p.symbol, name: p.name, label: p.label, plan: p.plan, confidence: p.confidence, riskNote: p.riskNote })) : null,
      holdings: sim
        ? (sim.holdings ?? []).map((h) => ({
            symbol: h.symbol,
            name: h.name,
            shares: h.shares,
            avgCost: h.avgCost,
            price: h.price,
            changePercent: h.changePercent,
            pnl: h.pnl,
            pnlPct: h.pnlPct,
            weightPct: h.weightPct,
            buyDay: h.buyDay,
            stopPrice: h.stopPrice,
          }))
        : null,
      picksFailed: briefState.failed,
      holdingsFailed: simState.failed,
      picksTitle: brief?.title ?? "AI 建議清單",
      pickLimit,
      pickTotal: brief ? (brief.listPicks ?? brief.picks).length : 0,
      setPickLimit,
    };
  }, [canPicks, canHoldings, briefState.data, briefState.failed, simState.data, simState.failed, pickLimit]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiLists(): AiLists {
  return useContext(Ctx);
}

/** 我的關注清單某一檔的標記：AI 模擬組合持有中／AI 建議名單內（台股專用） */
export function AiTagBadges({ symbol, market, hide }: { symbol: string; market: string; hide?: "held" | "picked" }) {
  const { picks, holdings } = useAiLists();
  if (market !== "TW") return null;
  const code = symbol.toUpperCase();
  const held = hide !== "held" && (holdings?.some((h) => h.symbol.toUpperCase() === code) ?? false);
  const picked = hide !== "picked" && (picks?.some((p) => p.symbol.toUpperCase() === code) ?? false);
  if (!held && !picked) return null;
  return (
    <span className="ml-1 inline-flex gap-1 align-middle">
      {held && (
        <span className="rounded bg-(--accent)/15 px-1 py-px text-[11px] font-medium text-(--accent)" title="AI 模擬投資組合目前持有這檔">
          🤖 AI持有
        </span>
      )}
      {picked && (
        <span className="rounded bg-(--price-up)/15 px-1 py-px text-[11px] font-medium text-(--price-up)" title="在 AI 建議清單（今日建議）名單內">
          🎯 AI建議
        </span>
      )}
    </span>
  );
}
