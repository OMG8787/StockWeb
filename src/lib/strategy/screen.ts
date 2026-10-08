import { searchStocks } from "@/lib/data";
import { getTwFundamentalsMap } from "@/lib/data/companyData";
import { getVolumeHistory } from "@/lib/data/volumeHistory";
import { getStockRatings } from "@/lib/ai/stockRating";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { getServerWatchlist } from "@/lib/watchlistStore";
import type { SearchItem } from "@/lib/data/types";
import { slicePosition, periodDays, type ScreenConfig, type ScreenMetric, type ScreenedStock } from "./screenConfig";
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
