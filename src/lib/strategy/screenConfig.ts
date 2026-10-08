/**
 * 股票篩選判斷的設定（純資料與純函式；前端、策略引擎、篩選執行 screen.ts 共用）。
 * 2026-10-08 使用者要求：策略先用篩選條件挑出股票名單，再拿名單去跑策略。
 * 三種來源：依指標排名（取前段／中段／後段 N 名）、AI 判斷、全部關注名單。
 */

export const SCREEN_METRICS = [
  { id: "volume_today", label: "成交量（當日）" },
  { id: "volume_5d", label: "成交量（5 日平均）" },
  { id: "volume_week", label: "成交量（當週累計）" },
  { id: "volume_month", label: "成交量（當月累計）" },
  { id: "turnover", label: "成交值（當日）" },
  { id: "change_pct", label: "漲跌幅（當日）" },
  { id: "pe", label: "本益比" },
  { id: "dividend_yield", label: "殖利率" },
  { id: "price", label: "股價" },
] as const;
export type ScreenMetric = (typeof SCREEN_METRICS)[number]["id"];

export const SCREEN_POSITIONS = [
  { id: "top", label: "前段（最高）" },
  { id: "middle", label: "中段" },
  { id: "bottom", label: "後段（最低）" },
] as const;
export type ScreenPosition = (typeof SCREEN_POSITIONS)[number]["id"];

export const SCREEN_COUNTS = [10, 20, 30, 50, 100] as const;

export const SCREEN_AI_MODES = [
  { id: "action_picks", label: "今日建議名單（本站每天選出的建議買進）" },
  { id: "rating_buy", label: "從當日成交量前 50 名中，挑本站評等「建議買進」的" },
] as const;
export type ScreenAiMode = (typeof SCREEN_AI_MODES)[number]["id"];

export type ScreenConfig =
  | { source: "metric"; metric: ScreenMetric; position: ScreenPosition; count: number }
  | { source: "ai"; mode: ScreenAiMode; count: number }
  | { source: "watchlist" };

export interface ScreenedStock {
  symbol: string;
  market: "TW" | "US";
  name: string;
  /** 排名用的數值（依指標篩選時才有） */
  value?: number;
}

const pick = <T extends string>(list: ReadonlyArray<{ id: T }>, v: unknown, d: T): T => (list.some((x) => x.id === v) ? (v as T) : d);

export function normalizeScreen(raw: unknown): ScreenConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const count = (SCREEN_COUNTS as readonly number[]).includes(Number(r.count)) ? Number(r.count) : 20;
  if (r.source === "metric") {
    return { source: "metric", metric: pick(SCREEN_METRICS, r.metric, "volume_today"), position: pick(SCREEN_POSITIONS, r.position, "top"), count };
  }
  if (r.source === "ai") return { source: "ai", mode: pick(SCREEN_AI_MODES, r.mode, "action_picks"), count };
  if (r.source === "watchlist") return { source: "watchlist" };
  return null;
}

export function describeScreen(s: ScreenConfig | null | undefined): string {
  if (!s) return "未設定股票篩選";
  if (s.source === "watchlist") return "全部關注名單";
  if (s.source === "ai") return `${SCREEN_AI_MODES.find((m) => m.id === s.mode)?.label ?? "AI 判斷"}，最多 ${s.count} 檔`;
  const metric = SCREEN_METRICS.find((m) => m.id === s.metric)?.label ?? s.metric;
  const pos = s.position === "top" ? "前" : s.position === "bottom" ? "後" : "中間";
  return `${metric} ${pos} ${s.count} 名`;
}

/** 依位置從排序好（高到低）的清單取 count 檔 */
export function slicePosition<T>(sortedDesc: T[], position: ScreenPosition, count: number): T[] {
  if (position === "top") return sortedDesc.slice(0, count);
  if (position === "bottom") return sortedDesc.slice(-count).reverse();
  const start = Math.max(0, Math.floor((sortedDesc.length - count) / 2));
  return sortedDesc.slice(start, start + count);
}

/** 週／月的交易日數估算（成交量歷史沒有日期，以「今天是星期幾／幾號」推算最近幾個交易日） */
export function periodDays(period: "week" | "month", lastDate: string): number {
  const d = new Date(`${lastDate}T12:00:00+08:00`);
  if (period === "week") return Math.min(5, Math.max(1, d.getUTCDay() === 0 ? 5 : d.getUTCDay()));
  // 當月：1 號到今天的平日數
  let n = 0;
  for (let day = 1; day <= d.getUTCDate(); day++) {
    const wd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return Math.max(1, n);
}

// ============================================================
// 股票名單來源（可複選）：篩選條件之外，再加上全市場、自選清單、依策略選股
// 2026-10-08 使用者要求：策略的篩選要能複選、預覽用顏色區分來源；模擬倉的股票範圍也要能複選。
// ============================================================

export type StockSource =
  | ScreenConfig
  | { source: "all" }
  | { source: "list"; symbols: string[] }
  | { source: "strategy" };

export type SourceMode = "union" | "intersect";

export const MAX_SOURCES = 8;
export const MAX_LIST_SOURCE_SYMBOLS = 100;

/** allowStrategy：模擬倉才有「依策略選股」；策略本身不能再引用策略 */
export function normalizeSource(raw: unknown, opts: { allowStrategy?: boolean } = {}): StockSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.source === "all") return { source: "all" };
  if (r.source === "strategy") return opts.allowStrategy ? { source: "strategy" } : null;
  if (r.source === "list") {
    const symbols = [...new Set((Array.isArray(r.symbols) ? r.symbols : []).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9.]{1,12}$/.test(x)))].slice(0, MAX_LIST_SOURCE_SYMBOLS);
    return { source: "list", symbols };
  }
  return normalizeScreen(raw);
}

export function normalizeSources(raw: unknown, opts: { allowStrategy?: boolean } = {}): StockSource[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: StockSource[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const s = normalizeSource(x, opts);
    if (!s) continue;
    // 完全相同的來源只留一個（例如勾了兩次「全市場」）
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

export function describeSource(s: StockSource): string {
  if (s.source === "all") return "全市場（台股當天有成交的股票）";
  if (s.source === "list") return `自選清單 ${s.symbols.length} 檔`;
  if (s.source === "strategy") return "依策略選股（用策略設定的股票篩選）";
  return describeScreen(s);
}

export function describeSources(sources: StockSource[], mode: SourceMode = "union"): string {
  if (sources.length === 0) return "未設定股票來源";
  const parts = sources.map(describeSource);
  return parts.length === 1 ? parts[0] : `${parts.join(mode === "intersect" ? " 且 " : " ＋ ")}（${mode === "intersect" ? "同時符合" : "符合任一"}）`;
}

/**
 * 合併多個來源的結果：每檔股票記下它來自哪些來源（tags＝來源序號）。
 * union＝符合任一；intersect＝每個來源都有。順序依第一個出現的來源。
 */
export function combineSources<T extends { symbol: string; market: string }>(lists: T[][], mode: SourceMode): Array<T & { tags: number[] }> {
  const map = new Map<string, T & { tags: number[] }>();
  lists.forEach((list, idx) => {
    for (const item of list) {
      const key = `${item.market}:${item.symbol}`;
      const hit = map.get(key);
      if (hit) {
        if (!hit.tags.includes(idx)) hit.tags.push(idx);
      } else map.set(key, { ...item, tags: [idx] });
    }
  });
  const all = [...map.values()];
  return mode === "intersect" ? all.filter((x) => lists.every((_, i) => x.tags.includes(i))) : all;
}

