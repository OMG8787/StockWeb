import { getQuote } from "@/lib/data";
import { mapWithConcurrency } from "@/lib/data/cache";
import { computeHoldingPnl } from "@/lib/portfolio";
import type { HoldingInput } from "../askTypes";
import { describeHoldingTechnical } from "./indicators";
import { buildStockGrounding } from "./stock";

/**
 * The client's watchlist lives in localStorage, not anywhere this server
 * code can reach on its own — so "analyze my watchlist" only works because
 * the widget reads it and sends it along with the request. Each entry gets
 * a live requote (the client's copy is whatever the page last fetched,
 * which can be stale) and, when cost/shares were entered, its unrealized
 * P&L computed from that live price.
 */
export async function buildHoldingsGrounding(holdings: HoldingInput[], includeTechnical = false): Promise<string> {
  if (holdings.length === 0) return "";
  const lines = await Promise.all(
    holdings.map(async (h) => {
      const quote = await getQuote(h.symbol, h.market);
      if (!quote) return `${h.name}(${h.symbol})：目前查不到報價`;
      // 2026-09-16 實測抓到的缺口：使用者問「我的持股裡有沒有哪一檔出現黃金
      // 交叉?」時，這份輕量版清單只有報價跟損益，完全沒有技術訊號，AI 只好
      // 回答「個股詳細技術指標剛好沒有在這次的資料裡列出來」——可是這些資料
      // 本站每一檔個股頁都算得出來，只是沒送進來。這裡只在使用者真的問到技術
      // 指標時才多抓一次K線（getChart 本身有快取，持股通常也只有幾檔），
      // 不讓一般的「我持股賺還賠」問題平白多付這個成本。
      const technical = includeTechnical ? await describeHoldingTechnical(quote) : "";
      const base = `${quote.name}(${quote.symbol}，${quote.market === "TW" ? "台股" : "美股"})：現價 ${quote.price} ${quote.currency}，今日${quote.change >= 0 ? "漲" : "跌"} ${Math.abs(quote.changePercent)}%`;
      if (h.costBasis != null && h.shares != null && h.shares > 0) {
        // Same lib/portfolio.ts math the watchlist table itself uses (buy/
        // sell commission + TW 證交稅 folded in) — kept in one shared place
        // specifically so chat never reports a different 損益 for the same
        // holding than what the user is looking at on screen.
        const { pnl, pnlPercent } = computeHoldingPnl(quote.price, h.costBasis, h.shares, h.market);
        if (pnl == null) return `${base}；持有 ${h.shares} 股，平均成本 ${h.costBasis}`;
        const pnlText = pnlPercent != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}（${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%）` : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`;
        const pnlLabel = h.market === "TW" ? "損益（已估算計入買賣手續費與證交稅）" : "損益";
        return `${base}；持有 ${h.shares} 股，平均成本 ${h.costBasis}，${pnlLabel} ${pnlText}${technical}`;
      }
      return `${base}（尚未設定持股成本/股數）${technical}`;
    })
  );
  return lines.join("\n");
}

// A full buildStockGrounding() per holding is several sub-fetches each
// (quote/chart/earnings/fundamentals/chips/announcements/news) — bounded
// concurrency keeps a watchlist with many entries from firing a burst of
// requests at every upstream source at once, the same class of problem
// MOMENTUM_CHART_CONCURRENCY exists for elsewhere in this codebase.
const HOLDINGS_ANALYSIS_CONCURRENCY = 4;
// Past this many holdings, the rest fall back to the lightweight one-line
// summary (buildHoldingsGrounding) instead of a full grounding each — a
// personal watchlist realistically has a handful to a couple dozen entries,
// not enough to usually hit this, but it caps the worst case rather than
// letting one very long watchlist turn into an enormous, slow request.
const HOLDINGS_ANALYSIS_LIMIT = 12;

/**
 * The richer counterpart to buildHoldingsGrounding() above, used
 * specifically when the user is asking for a real per-stock analysis of
 * their watchlist (see HOLDINGS_ANALYSIS_INTENT_PATTERN) rather than just a
 * quick price/P&L check. Reuses buildStockGrounding() — the exact same
 * technical/fundamental/chip/news data a single-stock question already
 * gets — for every holding, and tags each block with whether it's an
 * actual position (持有中) or watch-only (僅關注), plus its P&L when it's a
 * real position, so the system prompt can tell the model which decision
 * framing applies to which stock.
 */
export async function buildHoldingsAnalysisGrounding(holdings: HoldingInput[]): Promise<string> {
  if (holdings.length === 0) return "";
  const rich = holdings.slice(0, HOLDINGS_ANALYSIS_LIMIT);
  const overflow = holdings.slice(HOLDINGS_ANALYSIS_LIMIT);

  const richBlocks = await mapWithConcurrency(rich, HOLDINGS_ANALYSIS_CONCURRENCY, async (h) => {
    const isHeld = h.costBasis != null && h.shares != null && h.shares > 0;
    // 持有中帶購買價格：評等的「已持有」結論會套停利提示（siteRating.ts checkTakeProfit）。
    const grounding = await buildStockGrounding(
      { symbol: h.symbol, market: h.market },
      { costBasis: isHeld ? h.costBasis : undefined }
    ).catch(() => undefined);
    if (!grounding) return `${h.name}(${h.symbol})：目前查不到完整資料，暫時無法分析`;
    let holdingLine = "狀態：僅關注，尚未持有";
    if (isHeld) {
      // getQuote() is the same 20s-TTL cache buildStockGrounding() itself
      // just read from — a second call here is a cheap in-process hit, not
      // a real extra upstream fetch — needed because buildStockGrounding()
      // returns pre-formatted text, not the quote object, and P&L needs the
      // live price.
      const quote = await getQuote(h.symbol, h.market).catch(() => null);
      const { pnl, pnlPercent } = quote ? computeHoldingPnl(quote.price, h.costBasis!, h.shares!, h.market) : { pnl: null, pnlPercent: null };
      const pnlText =
        pnl != null
          ? `，${h.market === "TW" ? "損益（已估算計入買賣手續費與證交稅）" : "損益"} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}${pnlPercent != null ? `（${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%）` : ""}`
          : "";
      holdingLine = `狀態：持有中，持有 ${h.shares} 股，平均成本 ${h.costBasis}${pnlText}`;
    }
    return `${grounding.text}\n${holdingLine}`;
  });

  const overflowText = overflow.length > 0 ? await buildHoldingsGrounding(overflow) : "";
  return [richBlocks.join("\n\n---\n\n"), overflowText].filter(Boolean).join("\n\n---\n\n");
}
