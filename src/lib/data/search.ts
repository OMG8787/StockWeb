import type { Market, Quote, SearchItem, VolumeTrend } from "./types";
import { US_UNIVERSE, getTwUniverse, UniverseEntry } from "./universe";
import { universeFor } from "./symbols";
import { getMarketQuoteMap } from "./marketQuoteMap";
import { computeVolumeMetrics, getTrailingAverageVolumeMap } from "./volumeHistory";

export interface SearchFilters {
  market?: Market;
  /** @deprecated use `sectors` (supports multi-select) */
  sector?: string;
  sectors?: string[];
  query?: string;
  minChangePercent?: number;
  maxChangePercent?: number;
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  maxVolume?: number;
  minTurnover?: number;
  maxTurnover?: number;
  /**
   * 多選，跟 `sectors` 同一套「不衝突條件可以複選」的設計：不傳或空陣列＝不篩選；
   * 傳了就只保留 volumeTrend 落在這個集合裡的股票。見 types.ts 的 VolumeTrend /
   * SearchItem.volumeTrend 說明——這是價量關係推論，不是真實買賣單量能分類。
   */
  volumeTrends?: VolumeTrend[];
  sortBy?: "changePercent" | "volume" | "price" | "turnover";
  sortDir?: "asc" | "desc";
}

/** Stocks with no live quote available are excluded, never shown with a placeholder price. */
export async function searchStocks(filters: SearchFilters): Promise<SearchItem[]> {
  let pool: UniverseEntry[] = filters.market
    ? await universeFor(filters.market)
    : [...(await getTwUniverse()), ...US_UNIVERSE];
  if (filters.sector) pool = pool.filter((e) => e.sector === filters.sector);
  if (filters.sectors && filters.sectors.length > 0) {
    const wanted = new Set(filters.sectors);
    pool = pool.filter((e) => wanted.has(e.sector));
  }
  if (filters.query) {
    const q = filters.query.trim().toLowerCase();
    pool = pool.filter((e) => e.symbol.toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
  }

  const marketsNeeded = [...new Set(pool.map((e) => e.market))];
  const [quoteMaps, avgVolumeMaps] = await Promise.all([
    Promise.all(marketsNeeded.map((m) => getMarketQuoteMap(m))),
    // Cheap (peekCached, read-only — see volumeHistory.ts): never triggers a
    // fresh computation, just reads whatever the batch-quote piggyback has
    // already accumulated. A market with no history yet just yields an
    // empty map, and every item's volumeTrend falls back to "neutral".
    Promise.all(marketsNeeded.map((m) => getTrailingAverageVolumeMap(m))),
  ]);
  const quoteBySymbol = new Map<string, Quote>();
  const avgVolumeBySymbol = new Map<string, number>();
  marketsNeeded.forEach((m, i) => {
    for (const [symbol, quote] of quoteMaps[i]) quoteBySymbol.set(`${m}:${symbol}`, quote);
    for (const [symbol, avg] of avgVolumeMaps[i]) avgVolumeBySymbol.set(`${m}:${symbol}`, avg);
  });

  let items: SearchItem[] = pool
    .map((entry): SearchItem | null => {
      const q = quoteBySymbol.get(`${entry.market}:${entry.symbol}`);
      if (!q) return null;
      const avgVolume = avgVolumeBySymbol.get(`${entry.market}:${entry.symbol}`);
      return {
        symbol: entry.symbol,
        market: entry.market,
        name: entry.name,
        sector: entry.sector,
        price: q.price,
        changePercent: q.changePercent,
        volume: q.volume,
        turnover: q.price * q.volume,
        ...computeVolumeMetrics(q.changePercent, q.volume, avgVolume),
      };
    })
    .filter((i): i is SearchItem => i !== null);

  if (filters.minChangePercent !== undefined) {
    items = items.filter((i) => i.changePercent >= filters.minChangePercent!);
  }
  if (filters.maxChangePercent !== undefined) {
    items = items.filter((i) => i.changePercent <= filters.maxChangePercent!);
  }
  if (filters.minPrice !== undefined) {
    items = items.filter((i) => i.price >= filters.minPrice!);
  }
  if (filters.maxPrice !== undefined) {
    items = items.filter((i) => i.price <= filters.maxPrice!);
  }
  if (filters.minVolume !== undefined) {
    items = items.filter((i) => i.volume >= filters.minVolume!);
  }
  if (filters.maxVolume !== undefined) {
    items = items.filter((i) => i.volume <= filters.maxVolume!);
  }
  if (filters.minTurnover !== undefined) {
    items = items.filter((i) => i.turnover >= filters.minTurnover!);
  }
  if (filters.maxTurnover !== undefined) {
    items = items.filter((i) => i.turnover <= filters.maxTurnover!);
  }
  if (filters.volumeTrends && filters.volumeTrends.length > 0) {
    const wantedTrends = new Set(filters.volumeTrends);
    items = items.filter((i) => wantedTrends.has(i.volumeTrend));
  }

  const sortBy = filters.sortBy ?? "changePercent";
  const sortDir = filters.sortDir ?? "desc";
  // 今天一張都沒成交的冷門股，漲跌幅其實是用委買賣中價估算出來的（見
  // twse.ts/tpex.ts rowToQuote 的 priceNote），不是真實成交價變動。放進
  // 「照漲跌幅排序」的排行榜（首頁焦點排行、/search 預設或明確按漲跌幅排序）
  // 會顯示看起來像真實漲跌的雜訊。使用者直接用關鍵字/代號查某一檔時
  // （filters.query 有值）完全不受影響，仍然照樣找得到、看得到報價。
  if (sortBy === "changePercent" && !filters.query) {
    items = items.filter((i) => i.volume > 0);
  }
  items.sort((a, b) => {
    const diff = a[sortBy] - b[sortBy];
    return sortDir === "desc" ? -diff : diff;
  });

  return items;
}
