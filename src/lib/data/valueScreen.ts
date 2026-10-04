import { cached } from "./cache";
import type { Market } from "./types";
import { getTwFundamentalsMap } from "./companyData";
import { searchStocks } from "./search";

export interface ValueScreenItem {
  symbol: string;
  market: Market;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  turnover: number;
  peRatio?: number;
  pbRatio?: number;
  dividendYield?: number;
}

/** 一次算好幾種「估值/跌幅」面向的全市場篩選結果，見 getValueScreen()。 */
export interface ValueScreen {
  lowPe: ValueScreenItem[];
  highYield: ValueScreenItem[];
  lowPb: ValueScreenItem[];
  decliners: ValueScreenItem[];
}

// 2026-09-20：拉長到 30 分鐘，跟本益比/殖利率背後的 FUNDAMENTALS_TTL_MS 對齊
// ——這個排行本身不用抓K線（只是重新排序已經快取好的基本面/報價資料），沒有
// MOMENTUM/TECH_SCREEN 那麼貴，但排序依據的本益比/殖利率一天也不會變好幾次。
const VALUE_SCREEN_TTL_MS = 30 * 60_000;
const VALUE_SCREEN_N = 12;
// 流動性下限：本益比/殖利率最極端的名次幾乎一定被「幾乎沒有人交易的殭屍股」佔滿
// （成交金額只有幾萬元的冷門股，本益比 2 倍也買不到、賣不掉），對使用者完全沒有
// 參考價值，還會讓回答看起來像在亂推薦。用「今日成交金額」當門檻，只保留真的有人
// 在交易的股票。3000 萬元大約是台股每天成交金額排行的中段，能濾掉極端冷門股又不會
// 嚴格到只剩權值股。
const VALUE_SCREEN_MIN_TURNOVER_TWD = 30_000_000;

/**
 * 全市場「便宜/高息/跌深」篩選。
 *
 * 加這個函式的原因跟 getVolumeSurgeStocks 是同一類問題：使用者實測問「有沒有本益比
 * 低的股票可以推薦？」「殖利率高的股票有哪些？」「今天跌最多的有哪些？有沒有跌深可以
 * 撿的？」時，AI 回答「資料裡沒有直接提供個股的本益比/殖利率數據」——但本站其實
 * 早就有全市場的本益比/股價淨值比/殖利率（TWSE 的 BWIBBU_ALL 加上 TPEx 的對應
 * 端點，見 getFundamentals 用的那份 `fundamentals:TW:all` 快取，一次就涵蓋整個市場），
 * 只是從來沒有任何地方把它整理成「排行清單」餵給 AI 問答，AI 手上真的沒有這份資料，
 * 才誠實說沒有。這就是典型的「明明有資料卻答沒有」——不是 AI 在說謊，是資料沒送到。
 *
 * 只做台股：美股的基本面是逐檔跟 Yahoo 拿的（fetchUsFundamentals），沒有一次拿到
 * 全市場的批次端點，硬要掃會變成上百個請求。
 */
export async function getValueScreen(market: Market): Promise<ValueScreen> {
  if (market !== "TW") return { lowPe: [], highYield: [], lowPb: [], decliners: [] };
  return cached(`value-screen:${market}:v1`, VALUE_SCREEN_TTL_MS, async () => {
    const [items, fundamentalsMap] = await Promise.all([
      searchStocks({ market, sortBy: "turnover", sortDir: "desc" }),
      getTwFundamentalsMap(),
    ]);

    const liquid = items.filter((i) => i.turnover >= VALUE_SCREEN_MIN_TURNOVER_TWD);
    const enriched: ValueScreenItem[] = liquid.map((i) => {
      const f = fundamentalsMap.get(i.symbol);
      return {
        symbol: i.symbol,
        market: i.market,
        name: i.name,
        sector: i.sector,
        price: i.price,
        changePercent: i.changePercent,
        turnover: i.turnover,
        peRatio: f?.peRatio,
        pbRatio: f?.pbRatio,
        dividendYield: f?.dividendYield,
      };
    });

    const byPe = enriched
      .filter((i) => i.peRatio != null && i.peRatio > 0)
      .sort((a, b) => a.peRatio! - b.peRatio!)
      .slice(0, VALUE_SCREEN_N);
    const byYield = enriched
      .filter((i) => i.dividendYield != null && i.dividendYield > 0)
      .sort((a, b) => b.dividendYield! - a.dividendYield!)
      .slice(0, VALUE_SCREEN_N);
    const byPb = enriched
      .filter((i) => i.pbRatio != null && i.pbRatio > 0)
      .sort((a, b) => a.pbRatio! - b.pbRatio!)
      .slice(0, VALUE_SCREEN_N);
    // 跌幅榜刻意不套流動性門檻以外的條件：使用者問「今天跌最多的」就是要看真實的
    // 跌幅排行，不是我們挑過的「跌得有道理的」。
    const decliners = enriched
      .filter((i) => i.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, VALUE_SCREEN_N);

    return { lowPe: byPe, highYield: byYield, lowPb: byPb, decliners };
  });
}
