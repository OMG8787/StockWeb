import { redis } from "@/lib/data/kv";
import type { StockRatingResult } from "@/lib/ai/stockRating";
import type { SimDepth } from "./rules";
import type { SimTrade } from "./types";

/**
 * AI 模擬投資組合的永久封存（2026-10-06 使用者：「每天且每筆交易記錄、原因等都有全部記下來嗎?方便不斷優化與進步。」）。
 * state（store.ts）只留近期給頁面顯示；這裡按月分 key、不設 TTL，什麼都不刪：
 * - `sim-portfolio:v1:trades:{YYYY-MM}`（list）：每筆交易（含未成交），附完整決策快照（評等、五面向、價位框架、市況、追高防護、盤口與成交依據）。
 * - `sim-portfolio:v1:decisions:{YYYY-MM}`（list）：每個執行時點一筆決策紀錄（候選逐檔：評等與選或不選的原因；持股逐檔：持有建議與動作或不動作的原因）。
 * - `sim-portfolio:v1:daily:{YYYY-MM}`（hash，field＝日期）：每日淨值＋持股快照（同一天後面的時點覆寫）。
 * - AI 每日檢討：`learning:v1:sim-review:{日期}`（review.ts，不過期）。
 * 每個時點只用 1 個 pipeline（2～3 個指令）寫入。讀取：/api/sim-portfolio/archive、scripts/check-sim-portfolio.py。
 */

export const SIM_ARCHIVE_PREFIX = "sim-portfolio:v1:";
export type SimArchiveKind = "trades" | "decisions" | "daily";

export function simArchiveKey(kind: SimArchiveKind, month: string): string {
  return `${SIM_ARCHIVE_PREFIX}${kind}:${month}`;
}

/** 決策當下的評等快照（從 StockRatingResult 取，跟評等紀錄同一份來源）。 */
export interface SimRatingSnapshot {
  code: string;
  label: string;
  holdingLabel: string;
  /** 套過成本（停利）後的持有中結論；未持有時同 holdingLabel */
  appliedHoldingLabel?: string;
  reason: string;
  supportCount: number;
  againstCount: number;
  facets: Record<string, string>;
  /** 把握程度（評等若有這個欄位才有） */
  confidence?: unknown;
  zone: { low: number; high: number } | null;
  pullbackAdd: number | null;
  exit: number | null;
  noChase: number | null;
  chaseHits: string[];
  riskNote: string | null;
  marketNote: string | null;
  regime: string | null;
  price: number;
  computedAt: string;
}

export function ratingSnapshot(r: StockRatingResult, appliedHoldingLabel?: string): SimRatingSnapshot {
  const rt = r.rating as typeof r.rating & { confidence?: unknown };
  return {
    code: rt.code,
    label: rt.label,
    holdingLabel: rt.holdingLabel,
    ...(appliedHoldingLabel && appliedHoldingLabel !== rt.holdingLabel ? { appliedHoldingLabel } : {}),
    reason: rt.reason,
    supportCount: rt.supportCount,
    againstCount: rt.againstCount,
    facets: Object.fromEntries(r.facets.map((f) => [f.name.replace(/（.*$/, ""), f.verdict])),
    ...(rt.confidence !== undefined ? { confidence: rt.confidence } : {}),
    zone: rt.zone,
    pullbackAdd: rt.pullbackAdd ?? null,
    exit: rt.exit,
    noChase: rt.noChase,
    chaseHits: rt.chaseHits.map((h) => h.id),
    riskNote: rt.riskNote,
    marketNote: rt.marketNote ?? null,
    regime: r.regime ?? null,
    price: r.price,
    computedAt: r.computedAt,
  };
}

/** 封存的一筆交易＝交易本身＋決策快照＋成交當下的盤口。 */
export interface SimArchivedTrade extends SimTrade {
  rating?: SimRatingSnapshot | null;
  depth?: SimDepth | null;
  /** 這筆是哪個時點下的單（盤後定價委託在 13:35 下、14:30 成交） */
  decidedAt?: string;
}

export interface SimDecisionItem {
  symbol: string;
  name: string;
  /** 評等字樣（候選＝未持有結論；持股＝套過成本的持有中結論） */
  label: string;
  /** 動作：買進／賣出／減碼／加碼／委託…；不動作是「—」 */
  action: string;
  /** 為什麼（動作或不動作的原因） */
  why: string;
}

export interface SimDecisionRecord {
  at: string;
  day: string;
  slot: string;
  kind: string;
  note: string;
  cash: number;
  nav: number;
  candidates: SimDecisionItem[];
  holdings: SimDecisionItem[];
  /** 這個時點產生的單數、成交、未成交 */
  orders: number;
  filled: number;
  rejected: number;
}

export interface SimDailySnapshot {
  day: string;
  at: string;
  nav: number;
  cash: number;
  etf: number | null;
  index: number | null;
  holdings: Array<{ symbol: string; name: string; shares: number; avgCost: number; price: number; marketValue: number; pnl: number; stopPrice: number | null; label: string | null }>;
}

const monthOf = (day: string) => day.slice(0, 7);

/** 一個時點的封存寫入（一個 pipeline）。失敗只記 log，不影響交易本身（state 已另外存）。 */
export async function appendSimArchive(input: { trades: SimArchivedTrade[]; decision: SimDecisionRecord; daily: SimDailySnapshot }): Promise<void> {
  if (!redis) return;
  try {
    const p = redis.pipeline();
    // 交易依「交易日」分月（跨月的舊委託取消紀錄記在它自己的月份）。
    const byMonth = new Map<string, string[]>();
    for (const t of input.trades) {
      const m = monthOf(t.day);
      byMonth.set(m, [...(byMonth.get(m) ?? []), JSON.stringify(t)]);
    }
    for (const [m, rows] of byMonth) p.rpush(simArchiveKey("trades", m), ...rows);
    p.rpush(simArchiveKey("decisions", monthOf(input.decision.day)), JSON.stringify(input.decision));
    p.hset(simArchiveKey("daily", monthOf(input.daily.day)), { [input.daily.day]: JSON.stringify(input.daily) });
    await p.exec();
  } catch (err) {
    console.warn("[sim-portfolio] 封存寫入失敗：", err);
  }
}

const parse = <T,>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

export async function readSimArchive(kind: "trades", month: string): Promise<SimArchivedTrade[]>;
export async function readSimArchive(kind: "decisions", month: string): Promise<SimDecisionRecord[]>;
export async function readSimArchive(kind: "daily", month: string): Promise<SimDailySnapshot[]>;
export async function readSimArchive(kind: SimArchiveKind, month: string): Promise<unknown[]> {
  if (!redis) return [];
  const key = simArchiveKey(kind, month);
  if (kind === "daily") {
    const h = (await redis.hgetall<Record<string, unknown>>(key)) ?? {};
    return Object.keys(h)
      .sort()
      .map((k) => parse<SimDailySnapshot>(h[k]));
  }
  const rows = await redis.lrange(key, 0, -1);
  return rows.map((r) => parse(r));
}
