import { getChart, getChips, getChipsRatios, getEarnings, getFundamentals, getMaterialAnnouncements, getQuote } from "@/lib/data";
import type { Market } from "@/lib/data";
import { dedupeNews, fetchNews, fetchNewsMulti, type NewsItem } from "@/lib/data/news";
import { fetchFinnhubCompanyNews } from "@/lib/data/finnhub";

/** 美股個股新聞每次最多從 Finnhub 補幾則（Google News 中英兩版各 4 則之外） */
const FINNHUB_NEWS_LIMIT = 4;

/**
 * 美股：Google News（中英兩版）＋ Finnhub company-news 合併去重；Finnhub 沒設定金鑰時
 * fetchFinnhubCompanyNews 直接回空陣列，結果跟以前完全一樣。台股維持只用 Google News。
 */
async function fetchStockNews(quote: { symbol: string; market: Market }, newsQuery: string): Promise<NewsItem[]> {
  if (quote.market !== "US") return fetchNews(newsQuery, 8);
  const [google, finnhub] = await Promise.all([
    fetchNewsMulti(newsQuery, 4, ["zh-TW", "en-US"]).catch(() => []),
    fetchFinnhubCompanyNews(quote.symbol, FINNHUB_NEWS_LIMIT),
  ]);
  return dedupeNews([...google, ...finnhub]);
}
import { formatMarketCap, formatSharesWithLots } from "@/lib/format";
import { computeIndicatorState, computeSignals } from "@/lib/signals";
import { describeIndicatorState } from "./indicators";
import { describeChipsRatios } from "./chipsRatios";

export async function buildStockGrounding(
  target: { symbol: string; market: Market | undefined }
): Promise<{ symbol: string; text: string } | undefined> {
  const [quote, chart] = await Promise.all([
    getQuote(target.symbol, target.market),
    getChart(target.symbol, "3m", target.market),
  ]);
  if (!quote) return undefined;

  // Fired only once the quote resolves the actual market (target.market may
  // be undefined when guessed from text) and gives us the real company name
  // to search news for — a bare ticker like "2330" is a much weaker news
  // query than "台積電". For US stocks, quote.name is already the English
  // company name (from Yahoo), so the same query works for both the zh-TW
  // and en-US Google News editions — the en-US edition is what actually
  // surfaces English-language wire coverage (Reuters/Bloomberg/MarketWatch)
  // that the zh-TW edition mostly doesn't carry.
  const newsQuery = `${quote.name} ${quote.symbol}`;
  const [earnings, news, fundamentals, chips, announcements, chipsRatios] = await Promise.all([
    getEarnings(quote.symbol, quote.market).catch(() => null),
    fetchStockNews(quote, newsQuery).catch(() => []),
    getFundamentals(quote.symbol, quote.market).catch(() => null),
    getChips(quote.symbol, quote.market).catch(() => null),
    getMaterialAnnouncements(quote.symbol, quote.market).catch(() => []),
    // 美股直接回 null（沒有這些資料），不會多打任何上游。
    getChipsRatios(quote.symbol, quote.market).catch(() => null),
  ]);

  const changeLabel = quote.change >= 0 ? "上漲" : "下跌";
  const lines = [
    `股票：${quote.name}（${quote.symbol}，${quote.market === "TW" ? "台股" : "美股"}）`,
    `目前價格：${quote.price} ${quote.currency}，${changeLabel} ${Math.abs(quote.change)}（${quote.changePercent}%）`,
    quote.board === "emerging"
      ? // 興櫃沒有開盤價/收盤價這種東西（議價交易，見 lib/data/emerging.ts），
        // 硬套「開/高/低/昨收」這個格式會讓 AI 把 null 講成「開盤 0 元」或自己
        // 補一個數字上去。這裡直接換成符合興櫃實際制度的敘述。
        `今日：最高 ${quote.high ?? "（今日無成交）"} / 最低 ${quote.low ?? "（今日無成交）"} / 前日均價 ${quote.prevClose}，成交量 ${quote.volume.toLocaleString()} 股`
      : `今日：開 ${quote.open} / 高 ${quote.high} / 低 ${quote.low} / 昨收 ${quote.prevClose}，成交量 ${quote.volume.toLocaleString()}`,
  ];
  if (quote.board === "emerging") {
    lines.push(
      "板別：興櫃（Emerging Stock Market）。回答時務必讓使用者知道這幾件事，用白話講：興櫃是公司正式上市或上櫃之前的階段，交易方式是跟推薦證券商「議價」一對一談，不是集中撮合；因此沒有開盤價也沒有收盤價，上面的漲跌是拿最近一筆成交價跟「前日均價」比出來的；興櫃沒有漲跌幅上下限，單日大漲大跌都可能；成交量通常很少，甚至整天都沒有人成交。興櫃的交易時間是 09:00~15:00（比上市櫃的 09:00~13:30 晚 1.5 小時收盤，也沒有上市櫃那種 08:30 試撮），如果使用者問到現在有沒有在交易，要用這個時間回答。也要提醒興櫃風險明顯高於上市櫃股票。" +
        (quote.priceNote ? `另外，這一檔${quote.priceNote}，不要把它講成「今天成交價就是這個價格」。` : "")
    );
    lines.push(
      "興櫃沒有的資料（查不到就照實說沒有，絕對不要用自己的知識補）：本益比、殖利率、股價淨值比、三大法人買賣超、融資融券（興櫃依規定本來就不能融資融券）、每日重大訊息。興櫃有的是：報價、歷史走勢、月營收年增率、季報EPS。"
    );
  }
  if (chart) {
    const recent = chart.candles.slice(-10);
    lines.push(`近 10 個交易日收盤價：${recent.map((c) => `${c.time}=${c.close}`).join(", ")}`);
    // Individual stock questions previously got no technical-signal read at
    // all — only stocks that happened to surface in the momentum/movers
    // screen (getMultiSignalStocks, which pre-filters for 2+ signals) ever
    // got one. Computing it here too means asking about ANY stock (not just
    // ones already flagged as notably active) gets its own MA/RSI/MACD/KD/
    // Bollinger read, same engine as the chart page and /highlights.
    const signals = computeSignals(chart.candles, quote.price, "3m");
    if (signals.length > 0) lines.push(`技術訊號：${signals.map((s) => s.label).join("、")}`);
    // 上面那行只列「今天有觸發的」訊號，沒觸發的指標整個不會出現——2026-09-20
    // 正式站實測抓到的缺口：問「聯發科現在的RSI和MACD是什麼狀態?」時，因為當天
    // MACD 沒有發生交叉，資料裡連一個 MACD 字樣都沒有，AI 就拿當天剛好有觸發的
    // KD 頂替，回答「RSI 72 超買、KD 黃金交叉」，完全沒提使用者明明問到的 MACD，
    // 也沒說「MACD 今天沒有交叉」。使用者指名問某個指標時，「今天沒有交叉」本身
    // 就是一個完整、正確的答案，前提是資料裡要講得出來。這裡補上一行「每個指標
    // 當下的實際狀態值」（有沒有交叉、K/D/RSI 實際數值、均線排列、MACD 在 0 軸
    // 哪一側），讓任何被指名問到的指標都有真實數字可以回答，不必靠猜或改答別的。
    const indicatorLine = describeIndicatorState(computeIndicatorState(chart.candles, quote.price));
    if (indicatorLine) lines.push(`技術指標現況（不論今天有沒有觸發訊號，一律照實列出；使用者指名問哪個指標就答哪個，沒有交叉就照實說「今天沒有交叉」，不要改用別的指標代答）：${indicatorLine}`);
  } else {
    lines.push("（歷史走勢資料目前無法取得）");
  }
  lines.push("（來源：即時/近即時公開資料）");

  if (fundamentals) {
    const parts: string[] = [];
    if (fundamentals.peRatio != null) parts.push(`本益比 ${fundamentals.peRatio}`);
    if (fundamentals.pbRatio != null) parts.push(`股價淨值比 ${fundamentals.pbRatio}`);
    if (fundamentals.dividendYield != null) parts.push(`殖利率 ${fundamentals.dividendYield}%`);
    if (fundamentals.marketCap != null) parts.push(`市值 ${formatMarketCap(fundamentals.marketCap, quote.currency)}`);
    if (parts.length > 0) lines.push(`基本面：${parts.join("；")}`);
  }

  if (earnings) {
    const parts: string[] = [];
    if (earnings.monthlyRevenueYoyPercent != null) {
      parts.push(`${earnings.monthlyRevenuePeriod ?? "最新月"}營收年增率 ${earnings.monthlyRevenueYoyPercent >= 0 ? "+" : ""}${earnings.monthlyRevenueYoyPercent}%`);
    }
    if (earnings.quarterlyEps != null) {
      parts.push(`${earnings.quarterlyEpsPeriod ?? "最新一季"} EPS ${earnings.quarterlyEps}${quote.currency === "TWD" ? "元" : ""}`);
    }
    if (earnings.epsSurprisePercent != null) {
      // 驚喜幅度可能是負的（低於預期），不能一律寫「優於」——以前負值會被寫成「優於市場預期 -0.89%」。
      const s = earnings.epsSurprisePercent;
      parts.push(s > 0 ? `優於市場預期 ${s}%` : s < 0 ? `低於市場預期 ${Math.abs(s)}%` : "與市場預期相同");
    }
    if (earnings.nextEarningsDate) {
      parts.push(`下次公布財報日期約 ${earnings.nextEarningsDate}`);
    }
    if (parts.length > 0) lines.push(`財報：${parts.join("；")}`);
  }

  // TW only — chips/announcements are null/empty for US, see getChips/getMaterialAnnouncements.
  if (chips) {
    const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;
    const parts: string[] = [];
    if (chips.institutionalNetShares != null) {
      const detail = [
        chips.foreignNetShares != null ? `外資${formatSharesWithLots(chips.foreignNetShares)}` : "",
        chips.trustNetShares != null ? `投信${formatSharesWithLots(chips.trustNetShares)}` : "",
        chips.dealerNetShares != null ? `自營商${formatSharesWithLots(chips.dealerNetShares)}` : "",
      ]
        .filter(Boolean)
        .join("、");
      parts.push(`三大法人合計${formatSharesWithLots(chips.institutionalNetShares)}（${detail}）`);
    }
    if (chips.marginBalance != null) {
      const change = chips.marginBalanceChange != null ? `，較前日${signed(chips.marginBalanceChange)}張` : "";
      parts.push(`融資餘額 ${chips.marginBalance.toLocaleString()} 張${change}`);
    }
    if (chips.shortBalance != null) {
      const change = chips.shortBalanceChange != null ? `，較前日${signed(chips.shortBalanceChange)}張` : "";
      parts.push(`融券餘額 ${chips.shortBalance.toLocaleString()} 張${change}`);
    }
    if (parts.length > 0) lines.push(`籌碼面（${chips.date ?? "最近交易日"}）：${parts.join("；")}`);
  }
  const chipsRatiosText = describeChipsRatios(chipsRatios);
  if (chipsRatiosText) lines.push(chipsRatiosText);

  if (announcements.length > 0) {
    const shown = announcements.slice(0, 3).map((a) => `- ${a.date}：${a.subject.length > 80 ? `${a.subject.slice(0, 80)}…` : a.subject}`);
    lines.push(`近期重大訊息公告：\n${shown.join("\n")}`);
  }

  if (news.length > 0) {
    lines.push(`近期相關新聞：\n${news.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}`);
  }

  return { symbol: quote.symbol, text: lines.join("\n") };
}
