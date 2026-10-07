"use client";

import { useCallback, useEffect, useState } from "react";

/** 三個頁面共用的資料型別（對應 /api/strategy/* 的回應） */
export type ParamDef =
  | { key: string; label: string; type: "number"; default: number; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: "select"; default: string; options: Array<{ value: string; label: string }> };

export interface IndicatorTypeInfo {
  id: string;
  label: string;
  group: string;
  description: string;
  params: ParamDef[];
  twOnly: boolean;
}

export interface Indicator {
  id: string;
  name: string;
  typeId: string;
  params: Record<string, number | string>;
  summary: string;
  note: string;
}

export interface StrategyConfig {
  mode: "rules" | "score";
  buy: { ids: string[]; match: number };
  sell: { ids: string[]; match: number };
  weights: Record<string, number>;
  buyScore: number;
  sellScore: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldDays: number;
  positionPct: number;
  maxPositions: number;
}

export interface Strategy {
  id: string;
  name: string;
  config: StrategyConfig;
  summary: string;
  note: string;
}

export interface SimPosition {
  symbol: string;
  market: "TW" | "US";
  name: string;
  shares: number;
  avgCost: number;
  buyDay: string;
}

export interface Sim {
  id: string;
  name: string;
  strategyId: string;
  universe: "list" | "market";
  symbols: Array<{ symbol: string; market: "TW" | "US"; name: string }>;
  marketTopN: number;
  initialCash: number;
  cash: number;
  equity: number;
  returnPct: number;
  autoTrade: boolean;
  lastRunDay: string;
  lastRunNote: string;
  positions: SimPosition[];
  createdAt: string;
}

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `操作失敗（${res.status}）`);
  return data as T;
}

/** 讀取一個清單 API；reload 重新讀。第一次讀放在 timer 回呼裡（不在 effect 本體同步 setState）。 */
export function useList<T>(url: string): { items: T[] | null; error: string; reload: () => Promise<void> } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setItems((await api<{ items: T[] }>(url)).items);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [url]);
  useEffect(() => {
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);
  return { items, error, reload };
}

export const money = (v: number) => Math.round(v).toLocaleString("zh-TW");
export const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
/** 台股紅漲綠跌 */
export const upDownCls = (v: number) => (v > 0 ? "text-(--price-up)" : v < 0 ? "text-(--price-down)" : "");
