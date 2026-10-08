import { detectMarket, normalizeSymbol } from "@/lib/data";
import { findInUniverse } from "@/lib/data/universe";
import { getStockRating } from "@/lib/ai/stockRating";
import { readRatingLog } from "@/lib/ai/ratingLog";
import { taipeiNow } from "@/lib/auth/accounts";
import { getMarketStatus } from "@/lib/marketStatus";
import { AI_STRATEGY_ID, AI_STRATEGY_NAME, consensusBuy, ratingSignal, strategySignalSeries, type Signal } from "./history";
import { INDICATOR_TYPE_MAP, type IndicatorNeed } from "./indicatorCatalog";
import { DataCache, needsOf, rangeFor, warmUniverseBriefly, type Target } from "./runner";
import { listIndicators, listStrategies, prefetchStrategyTables, StrategyError } from "./store";

/**
 * 策略疊圖（2026-10-08 使用者要求）：選 1～10 檔股票、疊多個策略（含 AI 建議策略），
 * 看每個策略最近每天的買賣訊號，以及「全部策略同時買進」的日子。即時提醒也共用這裡的判斷。
 */

export const MAX_COMPARE_SYMBOLS = 10;
export const MAX_COMPARE_STRATEGIES = 8;
export const COMPARE_DAYS = 120;

export interface StrategyLine {
  id: string;
  name: string;
  signals: Signal[];
  current: Signal;
  summary: string;
  /** 只在最新一天判斷的指標（籌碼、基本面、評等…）提示 */
  latestOnly: boolean;
}

export interface CompareRow {
  symbol: string;
  market: "TW" | "US";
  name: string;
  days: string[];
  closes: number[];
  /** 最後一根是不是盤中補上的（價格會跳動） */
  live: boolean;
  lines: StrategyLine[];
  consensus: boolean[];
  error?: string;
}

function toTarget(raw: string): Target | null {
  const symbol = normalizeSymbol(raw);
  if (!symbol || !/^[A-Z0-9.^-]{1,12}$/.test(symbol)) return null;
  const market = detectMarket(symbol) === "US" ? "US" : "TW";
  return { symbol, market, name: (market === "TW" ? findInUniverse(symbol, "TW")?.name : undefined) ?? symbol };
}

export async function compareStrategies(
  userId: string,
  rawSymbols: string[],
  strategyIds: string[],
  opts: { days?: number; live?: boolean } = {},
): Promise<CompareRow[]> {
  const days = Math.min(COMPARE_DAYS, Math.max(5, opts.days ?? COMPARE_DAYS));
  await prefetchStrategyTables(userId);
  const [strategies, indicators] = await Promise.all([listStrategies(userId), listIndicators(userId)]);
  const wanted = [...new Set(strategyIds)].slice(0, MAX_COMPARE_STRATEGIES);
  const picked = wanted.map((id) => (id === AI_STRATEGY_ID ? AI_STRATEGY_ID : strategies.find((s) => s.id === id))).filter(Boolean);
  if (picked.length === 0) throw new StrategyError("請至少選一個策略");

  await warmUniverseBriefly();
  const targets = [...new Set(rawSymbols.map((s) => s.trim()).filter(Boolean))]
    .slice(0, MAX_COMPARE_SYMBOLS)
    .map(toTarget)
    .filter((t): t is Target => !!t);
  if (targets.length === 0) throw new StrategyError("請輸入至少一檔股票代號");

  const cache = new DataCache(new Set<IndicatorNeed>(["candles"]), opts.live ?? true);
  for (const p of picked) {
    if (p !== AI_STRATEGY_ID && p) cache.addNeeds(needsOf(p.config, indicators), rangeFor(p.config, indicators));
  }
  const useAi = picked.includes(AI_STRATEGY_ID);

  // AI 建議策略的歷史：評等紀錄裡每天最後一次的本站評等
  const today = taipeiNow().slice(0, 10);
  const from = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
  const aiHistory = new Map<string, Map<string, string>>();
  if (useAi) {
    const log = await readRatingLog(from, today).catch(() => []);
    for (const e of log) {
      const m = aiHistory.get(e.symbol) ?? new Map<string, string>();
      m.set(e.day, e.code); // 舊到新排序，同一天後面的蓋前面的
      aiHistory.set(e.symbol, m);
    }
  }

  const rows: CompareRow[] = [];
  // 一次兩檔，避免對證交所併發太多
  for (let i = 0; i < targets.length; i += 2) {
    const batch = targets.slice(i, i + 2);
    rows.push(
      ...(await Promise.all(
        batch.map(async (t): Promise<CompareRow> => {
          const ctx = await cache.get(t);
          if (!ctx || ctx.candles.length === 0) {
            return { symbol: t.symbol, market: t.market, name: t.name, days: [], closes: [], live: false, lines: [], consensus: [], error: "抓不到日K" };
          }
          const window = ctx.candles.slice(-days);
          const dayList = window.map((c) => c.time.slice(0, 10));
          const lines: StrategyLine[] = [];
          for (const p of picked) {
            if (p === AI_STRATEGY_ID) {
              const hist = aiHistory.get(t.symbol);
              const rating = await getStockRating(t.symbol, t.market).catch(() => null);
              const signals = dayList.map((d, idx) => (idx === dayList.length - 1 && rating ? ratingSignal(rating.rating.code) : ratingSignal(hist?.get(d))));
              lines.push({
                id: AI_STRATEGY_ID,
                name: AI_STRATEGY_NAME,
                signals,
                current: signals.at(-1) ?? null,
                summary: rating ? rating.rating.label : "評等暫時無法取得",
                latestOnly: false,
              });
              continue;
            }
            if (!p) continue;
            const { signals, latest } = strategySignalSeries(p.config, indicators, ctx, days);
            const used = new Set(p.config.mode === "score" ? Object.keys(p.config.weights) : [...p.config.buy.ids, ...p.config.sell.ids]);
            // 用到需要日K以外資料（籌碼、基本面、評等…）的指標：歷史日子無法判斷，只有最新一天
            const latestOnly = indicators.some((ind) => used.has(ind.id) && (INDICATOR_TYPE_MAP.get(ind.typeId)?.needs ?? []).some((n) => n !== "candles"));
            lines.push({ id: p.id, name: p.name, signals, current: signals.at(-1) ?? null, summary: latest.summary, latestOnly });
          }
          return {
            symbol: t.symbol,
            market: t.market,
            name: t.name,
            days: dayList,
            closes: window.map((c) => c.close),
            live: !!window.at(-1)?.live,
            lines,
            consensus: consensusBuy(lines.map((l) => l.signals)),
          };
        }),
      )),
    );
  }
  return rows;
}

/** 即時提醒的一次檢查：名單裡每檔股票、每個策略「現在」的訊號（盤中用即時價補今天的日K） */
export async function checkAlerts(userId: string, cfg: { symbols: string[]; strategyIds: string[] }) {
  const marketOpen = getMarketStatus("TW") === "open" || getMarketStatus("US") === "open";
  if (cfg.symbols.length === 0 || cfg.strategyIds.length === 0) return { at: new Date().toISOString(), marketOpen, items: [] };
  const rows = await compareStrategies(userId, cfg.symbols, cfg.strategyIds, { days: 2, live: true });
  return {
    at: new Date().toISOString(),
    marketOpen,
    items: rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      price: r.closes.at(-1) ?? null,
      error: r.error,
      allBuy: r.lines.length > 0 && r.lines.every((l) => l.current === "buy"),
      lines: r.lines.map((l) => ({ id: l.id, name: l.name, current: l.current, summary: l.summary })),
    })),
  };
}

