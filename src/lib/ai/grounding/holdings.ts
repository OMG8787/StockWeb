import { getChart, getQuote } from "@/lib/data";
import { mapWithConcurrency } from "@/lib/data/cache";
import { computeHoldingPnl } from "@/lib/portfolio";
import type { HoldingInput } from "../askTypes";
import { describeHoldingTechnical } from "./indicators";
import { buildSoldGrounding } from "./soldHoldings";
import { buildStockGrounding } from "./stock";
import { getStockRatings } from "../stockRating";
import { describeRatingForHolding, formatHoldingRatingSummary, formatWatchRatingSummary, type HoldingRatingEntry } from "../holdingRating";

/**
 * 逐檔評等（含個人成本）併發上限：評等本身有 10 分鐘快取，冷快取時每檔要抓日K／籌碼／財報，
 * 一次全部打出去會被證交所限流（428/503），也拉高 Vercel Active CPU。
 */
export const HOLDING_RATING_CONCURRENCY = 4;

function isHeldInput(h: HoldingInput): boolean {
  return h.costBasis != null && h.shares != null && h.shares > 0;
}

/** 已賣出（跟 lib/watchlist.ts hasSoldState 同一個定義）：股數 0、購買價格保留、有賣出紀錄＝目前不持有，但不是「沒設定過」。 */
function isSoldInput(h: HoldingInput): boolean {
  return h.shares === 0 && h.costBasis != null && h.costBasis > 0 && (h.sales?.length ?? 0) > 0;
}

/**
 * 關注清單每一檔的「含個人成本的本站評等」（key＝代號大寫）。輕量清單、深度分析的後段、
 * 持股彙整都用這一份；跟個股資料（stock.ts）同一個 describeRatingForHolding()，結論一定一致。
 */
export async function rateHoldings(holdings: HoldingInput[]): Promise<Map<string, HoldingRatingEntry>> {
  const out = new Map<string, HoldingRatingEntry>();
  if (holdings.length === 0) return out;
  const ratings = await getStockRatings(
    holdings.map((h) => ({ symbol: h.symbol, market: h.market })),
    HOLDING_RATING_CONCURRENCY,
    "ai-ask"
  ).catch(() => new Map());
  await mapWithConcurrency(holdings, HOLDING_RATING_CONCURRENCY, async (h) => {
    const rated = ratings.get(h.symbol.toUpperCase());
    if (!rated) return;
    const held = isHeldInput(h);
    // 3 個月日K跟評等同一份快取（stockRating.ts 剛抓過），這裡是快取命中。
    const chart = held ? await getChart(rated.symbol, "3m", rated.market).catch(() => null) : null;
    const quote = held ? await getQuote(rated.symbol, rated.market).catch(() => null) : null;
    const r = describeRatingForHolding(
      rated,
      held ? { costBasis: h.costBasis, market: rated.market, emerging: quote?.board === "emerging" } : null,
      chart?.candles
    );
    out.set(h.symbol.toUpperCase(), { name: rated.name, symbol: rated.symbol, ...r });
  });
  return out;
}

/**
 * The client's watchlist lives in localStorage, not anywhere this server
 * code can reach on its own — so "analyze my watchlist" only works because
 * the widget reads it and sends it along with the request. Each entry gets
 * a live requote (the client's copy is whatever the page last fetched,
 * which can be stale) and, when cost/shares were entered, its unrealized
 * P&L computed from that live price.
 */
export async function buildHoldingsGrounding(
  holdings: HoldingInput[],
  includeTechnical = false,
  /** 附每檔【本站綜合評等】（含個人成本的停利提示與持有中出場參考）：問持股要不要賣、賣哪些、停損停利時用。 */
  withRating = false,
  /** 是否附【已賣出紀錄】區塊（深度分析的後段退回輕量版時傳 false，避免跟前段已附的重複）。 */
  withSold = true
): Promise<string> {
  if (holdings.length === 0) return "";
  const ratings = withRating ? await rateHoldings(holdings) : new Map<string, HoldingRatingEntry>();
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
      const rated = ratings.get(h.symbol.toUpperCase());
      const ratingText = rated ? `\n${rated.text}` : "";
      const base = `${quote.name}(${quote.symbol}，${quote.market === "TW" ? "台股" : "美股"})：現價 ${quote.price} ${quote.currency}，今日${quote.change >= 0 ? "漲" : "跌"} ${Math.abs(quote.changePercent)}%`;
      if (isHeldInput(h)) {
        // Same lib/portfolio.ts math the watchlist table itself uses (buy/
        // sell commission + TW 證交稅 folded in) — kept in one shared place
        // specifically so chat never reports a different 損益 for the same
        // holding than what the user is looking at on screen.
        const { pnl, pnlPercent } = computeHoldingPnl(quote.price, h.costBasis!, h.shares!, h.market);
        if (pnl == null) return `${base}；持有 ${h.shares} 股，平均成本 ${h.costBasis}${technical}${ratingText}`;
        const pnlText = pnlPercent != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}（${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%）` : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`;
        const pnlLabel = h.market === "TW" ? "損益（已估算計入買賣手續費與證交稅）" : "損益";
        return `${base}；持有 ${h.shares} 股，平均成本 ${h.costBasis}，${pnlLabel} ${pnlText}${technical}${ratingText}`;
      }
      if (isSoldInput(h)) return `${base}（已全部賣出，目前未持有；賣出紀錄見【已賣出紀錄】）${technical}${ratingText}`;
      return `${base}（尚未設定持股成本/股數）${technical}${ratingText}`;
    })
  );
  const summary = withRating ? formatHoldingRatingSummary(holdings.map((h) => ratings.get(h.symbol.toUpperCase()))) : "";
  const sold = withSold ? await buildSoldGrounding(holdings).catch(() => "") : "";
  return [...lines, summary, sold].filter(Boolean).join("\n");
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

  // 2026-10-05 使用者回報：後段（超過 HOLDINGS_ANALYSIS_LIMIT）退回輕量版、沒有評等，AI 只寫「等回檔再行評估」沒價位。
  // 先對「每一檔」取評等（併發 4、10 分鐘快取），完整個股資料仍只做前 N 檔；之後 buildStockGrounding 讀評等會命中快取。
  const ratings = await rateHoldings(holdings);
  const richBlocks = await mapWithConcurrency(rich, HOLDINGS_ANALYSIS_CONCURRENCY, async (h) => {
    const isHeld = h.costBasis != null && h.shares != null && h.shares > 0;
    // 持有中帶購買價格：評等的「已持有」結論會套停利提示（siteRating.ts checkTakeProfit）。
    const grounding = await buildStockGrounding(
      { symbol: h.symbol, market: h.market },
      { costBasis: isHeld ? h.costBasis : undefined }
    ).catch(() => undefined);
    if (!grounding) return `${h.name}(${h.symbol})：目前查不到完整資料，暫時無法分析`;
    let holdingLine = isSoldInput(h) ? "狀態：已賣出，目前未持有（賣出紀錄見【已賣出紀錄】）" : "狀態：僅關注，尚未持有";
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

  const overflowText = overflow.length > 0 ? await buildHoldingsGrounding(overflow, false, true, false) : "";
  // 全部持股的「該賣哪些」彙整：跟輕量清單同一個 formatHoldingRatingSummary()，兩條路徑結論一致。
  const entries = holdings.map((h) => ratings.get(h.symbol.toUpperCase()));
  const summary = formatHoldingRatingSummary(entries);
  // 僅關注（未持有）彙整：依本站把握程度高→低，回答後檢查用它確認每一檔都寫到（2026-10-06 漏掉旺矽）。
  const watchSummary = formatWatchRatingSummary(entries);
  const sold = await buildSoldGrounding(holdings).catch(() => "");
  return [richBlocks.join("\n\n---\n\n"), overflowText, summary, watchSummary, sold].filter(Boolean).join("\n\n---\n\n");
}
