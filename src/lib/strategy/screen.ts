import { searchStocks } from "@/lib/data";
import { getTwFundamentalsMap } from "@/lib/data/companyData";
import { getVolumeHistory } from "@/lib/data/volumeHistory";
import { getStockRatings } from "@/lib/ai/stockRating";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getServerWatchlist } from "@/lib/watchlistStore";
import type { SearchItem } from "@/lib/data/types";
import { combineSources, describeSource, slicePosition, periodDays, type ScreenConfig, type ScreenMetric, type ScreenedStock, type SourceMode, type StockSource } from "./screenConfig";
import { ensureTwUniverseWarm, findInUniverse } from "@/lib/data/universe";
import { StrategyError } from "./store";

export * from "./screenConfig";

/**
 * 股票篩選的執行（抓全市場資料、排名）；設定與選項在 screenConfig.ts。
 * 股票篩選判斷（2026-10-08 使用者要求）：策略先用篩選條件挑出一份股票名單，再拿名單去跑策略。
 * 三種來源：依指標排名（成交量當日／5 日均／當週／當月、成交值、漲跌幅、本益比、殖利率、股價，
 * 取前段／中段／後段 N 名）、AI 判斷（今日建議名單、從成交量前段挑本站評等建議買進）、全部關注名單。
 * 排名只看台股、只算當天有成交的股票。
 */

async function metricValues(metric: ScreenMetric, items: SearchItem[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (metric === "pe" || metric === "dividend_yield") {
    const f = await getTwFundamentalsMap();
    for (const it of items) {
      const v = metric === "pe" ? f.get(it.symbol)?.peRatio : f.get(it.symbol)?.dividendYield;
      if (v != null && v > 0) out.set(it.symbol, v);
    }
    return out;
  }
  if (metric === "volume_5d" || metric === "volume_week" || metric === "volume_month") {
    const hist = await getVolumeHistory("TW");
    if (!hist || Object.keys(hist.bySymbol).length === 0) {
      throw new StrategyError("成交量歷史還在累積中（每個交易日收盤後記錄一次），暫時請改用「成交量（當日）」");
    }
    const n = metric === "volume_5d" ? 5 : periodDays(metric === "volume_week" ? "week" : "month", hist.lastRecordedDate);
    for (const it of items) {
      const h = hist.bySymbol[it.symbol];
      if (!h || h.length === 0) continue;
      const recent = h.slice(-n);
      const sum = recent.reduce((a, b) => a + b, 0);
      out.set(it.symbol, metric === "volume_5d" ? sum / recent.length : sum);
    }
    return out;
  }
  for (const it of items) {
    const v = metric === "volume_today" ? it.volume : metric === "turnover" ? it.turnover : metric === "change_pct" ? it.changePercent : it.price;
    if (Number.isFinite(v)) out.set(it.symbol, v);
  }
  return out;
}

/** 執行篩選，回傳股票名單（依篩選順序） */
export async function runScreen(cfg: ScreenConfig, userId: string): Promise<ScreenedStock[]> {
  if (cfg.source === "watchlist") {
    return (await getServerWatchlist(userId)).map((w) => ({ symbol: w.symbol, market: w.market, name: w.name }));
  }
  if (cfg.source === "ai") {
    if (cfg.mode === "action_picks") {
      const brief = await getActionBrief();
      return brief.picks.slice(0, cfg.count).map((p) => ({ symbol: p.symbol, market: "TW" as const, name: p.name }));
    }
    const pool = (await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" })).filter((i) => i.volume > 0).slice(0, 50);
    const ratings = await getStockRatings(pool.map((p) => ({ symbol: p.symbol, market: "TW" as const })), 2);
    return pool
      .filter((p) => {
        const code = ratings.get(p.symbol.toUpperCase())?.rating.code;
        return code === "buy" || code === "buy-on-pullback";
      })
      .slice(0, cfg.count)
      .map((p) => ({ symbol: p.symbol, market: "TW" as const, name: p.name }));
  }
  // 依指標排名：只算當天有成交的台股
  const items = (await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" })).filter((i) => i.volume > 0);
  const values = await metricValues(cfg.metric, items);
  const ranked = items
    .filter((i) => values.has(i.symbol))
    .map((i) => ({ symbol: i.symbol, market: "TW" as const, name: i.name, value: values.get(i.symbol)! }))
    .sort((a, b) => b.value - a.value);
  return slicePosition(ranked, cfg.position, cfg.count);
}

export interface SourceResult {
  items: Array<ScreenedStock & { tags: number[] }>;
  /** 每個來源各選出幾檔（-1＝這個來源失敗） */
  counts: number[];
  labels: string[];
  errors: Array<{ index: number; message: string }>;
}

/**
 * 執行多個股票來源並合併。單一來源失敗（例如成交量歷史還沒累積）不影響其他來源，錯誤另外回報。
 * strategySources：遇到「依策略選股」時要展開成哪些來源（模擬倉傳入所選策略的篩選）。
 */
export async function runSources(
  sources: StockSource[],
  mode: SourceMode,
  userId: string,
  opts: { strategySources?: { sources: StockSource[]; mode: SourceMode } | null } = {},
): Promise<SourceResult> {
  const errors: SourceResult["errors"] = [];
  const lists: ScreenedStock[][] = [];
  for (let i = 0; i < sources.length; i++) {
    try {
      lists.push(await runOneSource(sources[i], userId, opts));
    } catch (err) {
      errors.push({ index: i, message: (err as Error).message });
      lists.push([]);
    }
  }
  const ok = lists.filter((_, i) => !errors.some((e) => e.index === i));
  // 交集時，失敗的來源不參與（否則整個交集一定是空的）；聯集照常
  const combined = mode === "intersect" ? combineSources(ok, "intersect") : combineSources(lists, "union");
  // 交集用的是去掉失敗來源後的序號，要對回原本的序號
  const okIndex = lists.map((_, i) => i).filter((i) => !errors.some((e) => e.index === i));
  const items = mode === "intersect" ? combined.map((x) => ({ ...x, tags: x.tags.map((t) => okIndex[t]) })) : combined;
  return {
    items,
    counts: lists.map((l, i) => (errors.some((e) => e.index === i) ? -1 : l.length)),
    labels: sources.map(describeSource),
    errors,
  };
}

async function runOneSource(
  src: StockSource,
  userId: string,
  opts: { strategySources?: { sources: StockSource[]; mode: SourceMode } | null },
): Promise<ScreenedStock[]> {
  if (src.source === "all") {
    // 全市場：台股當天有成交的股票，依成交量排序（模擬倉掃描有時間上限，量大的先掃）
    return (await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" }))
      .filter((i) => i.volume > 0)
      .map((i) => ({ symbol: i.symbol, market: "TW" as const, name: i.name }));
  }
  if (src.source === "list") {
    await Promise.race([ensureTwUniverseWarm().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    return src.symbols.map((symbol) => {
      const market = /^[0-9]/.test(symbol) ? ("TW" as const) : ("US" as const);
      return { symbol, market, name: (market === "TW" ? findInUniverse(symbol, "TW")?.name : undefined) ?? symbol };
    });
  }
  if (src.source === "strategy") {
    const st = opts.strategySources;
    if (!st || st.sources.length === 0) throw new StrategyError("所選策略沒有設定股票篩選，「依策略選股」選不出股票");
    return (await runSources(st.sources, st.mode, userId)).items.map(({ symbol, market, name }) => ({ symbol, market, name }));
  }
  return runScreen(src, userId);
}

