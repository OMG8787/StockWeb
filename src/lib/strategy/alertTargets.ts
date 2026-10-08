import { runScreen } from "./screen";
import { ALERT_LIMITS } from "./store";

/**
 * 即時提醒的追蹤名單來源（2026-10-08 使用者要求：不只手動輸入，也能選「我的關注清單」與「AI 推薦清單」，
 * 這樣新增關注、AI 新增建議都能知道）。
 * 手動輸入的股票優先，其次關注清單，最後 AI 今日建議名單；去重後最多 ALERT_LIMITS.maxSymbols 檔。
 * 關注清單與 AI 名單任何一邊讀不到時回 null（不是空陣列）：前端據此略過名單比對，
 * 才不會把「暫時讀不到」誤報成「全部被移出」。
 */

export type TrackSource = "manual" | "watchlist" | "ai";

export interface AlertTrackConfig {
  symbols: string[];
  strategyIds: string[];
  trackWatchlist?: boolean;
  trackAiPicks?: boolean;
}

export interface NamedSymbol {
  symbol: string;
  name: string;
}

export interface TrackedResult {
  symbols: string[];
  /** 每檔股票來自哪些來源（標示在提醒頁的卡片上） */
  sources: Record<string, TrackSource[]>;
  /** 關注清單、AI 名單的完整內容（沒勾選或讀不到＝null）；前端用來比對新增／移出 */
  lists: { watchlist: NamedSymbol[] | null; ai: NamedSymbol[] | null };
  /** 合併後超過上限，被截斷 */
  truncated: boolean;
}

/** AI 今日建議名單第一次要算可能較久：最多等這麼久，逾時就當作這次讀不到 */
const LIST_TIMEOUT_MS = 25_000;

async function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), LIST_TIMEOUT_MS))]);
}

export async function resolveTracked(userId: string, cfg: AlertTrackConfig): Promise<TrackedResult> {
  const [watch, ai] = await Promise.all([
    cfg.trackWatchlist ? withTimeout(runScreen({ source: "watchlist" }, userId)) : null,
    cfg.trackAiPicks ? withTimeout(runScreen({ source: "ai", mode: "action_picks", count: 10 }, userId)) : null,
  ]);
  const lists = {
    watchlist: watch ? watch.map((w) => ({ symbol: w.symbol, name: w.name })) : null,
    ai: ai ? ai.map((w) => ({ symbol: w.symbol, name: w.name })) : null,
  };
  const sources: Record<string, TrackSource[]> = {};
  const order: string[] = [];
  const add = (symbol: string, from: TrackSource) => {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    if (!sources[s]) {
      sources[s] = [];
      order.push(s);
    }
    if (!sources[s].includes(from)) sources[s].push(from);
  };
  cfg.symbols.forEach((s) => add(s, "manual"));
  lists.watchlist?.forEach((x) => add(x.symbol, "watchlist"));
  lists.ai?.forEach((x) => add(x.symbol, "ai"));
  const truncated = order.length > ALERT_LIMITS.maxSymbols;
  return { symbols: order.slice(0, ALERT_LIMITS.maxSymbols), sources, lists, truncated };
}
