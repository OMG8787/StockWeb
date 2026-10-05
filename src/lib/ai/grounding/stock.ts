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
import { resolveMarketCap } from "@/lib/data/marketCap";
import { formatTwReportDeadline } from "@/lib/data/twReportDeadline";
import { computeIndicatorState, computeSignals } from "@/lib/signals";
import { describeIndicatorState, describeRecentCrosses, RECENT_CROSSES_TITLE } from "./indicators";
import { getMarketStatus, isTaipeiWeekend } from "@/lib/marketStatus";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { chipsSectionTitle, formatStockNewsLines } from "./stockNewsAndChips";
import { computePriceFramework, describePriceFramework } from "./priceLevels";
import { describeChipsRatios } from "./chipsRatios";
import { getUsStockSentiment } from "@/lib/data/sentiment";
import { describeSocialSentiment } from "./sentiment";
import { buildHistoryContext } from "./history";
import { describeSectorFactors } from "./sectorFactors";
import { findInUniverse } from "@/lib/data";
import { getStockRating } from "../stockRating";
import { describeExperience } from "../learning/experienceText";
import type { RatingSource } from "../ratingLog";
import { describeRatingForHolding } from "../holdingRating";
import { getAiJudgment } from "../aiJudge";
import { AI_VIEW_TITLE, describeAiView } from "../learning/aiAdjust";
import type { HistoryPeriod } from "../intent";

/**
 * opts.period：使用者明確問到過去某天/某段期間（intent.ts detectHistoryPeriod）時，
 * 【歷史脈絡】多附該期間逐日明細；opts.compact：多檔比較時每檔的歷史脈絡更短。
 */
export async function buildStockGrounding(
  target: { symbol: string; market: Market | undefined },
  opts: { period?: HistoryPeriod; compact?: boolean; costBasis?: number; source?: RatingSource; aiJudge?: boolean } = {}
): Promise<{ symbol: string; text: string } | undefined> {
  // 1年日K只給【歷史脈絡】用（區間報酬、52週高低、回檔、量能）；技術訊號維持用3個月日K，行為不變。
  const [quote, chart, chartYear, stockRating] = await Promise.all([
    getQuote(target.symbol, target.market),
    getChart(target.symbol, "3m", target.market),
    getChart(target.symbol, "1y", target.market).catch(() => null),
    // 本站綜合評等（跟今日建議／全市場推薦同一份快取，見 stockRating.ts）。
    getStockRating(target.symbol, target.market, opts.source ?? "ai-ask").catch(() => null),
  ]);
  if (!quote) return undefined;
  // AI 判斷層（學習循環第二階段，aiJudge.ts）：只在呼叫端要求時（個股問答、最多 2 檔），跟下面的資料抓取平行跑；
  // 每檔每天最多一次 AI 呼叫並快取，等不到 12 秒就先不附（背景照樣完成並快取）。
  const aiJudgePromise =
    opts.aiJudge && stockRating ? getAiJudgment(stockRating, opts.source ?? "ai-ask").catch(() => null) : Promise.resolve(null);

  // Fired only once the quote resolves the actual market (target.market may
  // be undefined when guessed from text) and gives us the real company name
  // to search news for — a bare ticker like "2330" is a much weaker news
  // query than "台積電". For US stocks, quote.name is already the English
  // company name (from Yahoo), so the same query works for both the zh-TW
  // and en-US Google News editions — the en-US edition is what actually
  // surfaces English-language wire coverage (Reuters/Bloomberg/MarketWatch)
  // that the zh-TW edition mostly doesn't carry.
  const newsQuery = `${quote.name} ${quote.symbol}`;
  const chipsRatiosPromise = getChipsRatios(quote.symbol, quote.market).catch(() => null);
  // 各段自己有時間上限、全部 fail open（見 history.ts），跟下面其他資料並行跑。
  const historyPromise = chipsRatiosPromise
    .then((chipsRatios) =>
      buildHistoryContext({ quote, candles: chartYear?.candles, chipsRatios, period: opts.period, compact: !!opts.compact })
    )
    .catch(() => undefined);
  // 油價敏感產業（航空、塑化…）才會多抓油價，其餘股票不多打任何請求（見 sectorFactors.ts）。
  const sectorFactorsPromise = describeSectorFactors({
    symbol: quote.symbol,
    market: quote.market,
    sector: findInUniverse(quote.symbol, quote.market)?.sector ?? "",
  }).catch(() => undefined);
  const [earnings, news, fundamentals, chips, announcements, chipsRatios, socialSentiment, historyText, sectorFactorsText] = await Promise.all([
    getEarnings(quote.symbol, quote.market).catch(() => null),
    fetchStockNews(quote, newsQuery).catch(() => []),
    getFundamentals(quote.symbol, quote.market).catch(() => null),
    getChips(quote.symbol, quote.market).catch(() => null),
    getMaterialAnnouncements(quote.symbol, quote.market).catch(() => []),
    // 美股直接回 null（沒有這些資料），不會多打任何上游。
    chipsRatiosPromise,
    // 美股限定的社群情緒（只讀快照，最多偶爾觸發1次批次刷新，見 lib/data/sentiment.ts）；缺金鑰回 null。
    quote.market === "US" ? getUsStockSentiment(quote.symbol).catch(() => null) : Promise.resolve(null),
    historyPromise,
    sectorFactorsPromise,
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
  if (stockRating) {
    lines.push(
      `${
        // 關注清單有購買價格時套持有中停利提示＋持有中出場參考（個人成本不進全站共用的評等快取；
        // 跟關注清單輕量／深度分析同一個函式，見 holdingRating.ts）。
        describeRatingForHolding(
          stockRating,
          opts.costBasis != null ? { costBasis: opts.costBasis, market: quote.market, emerging: quote.board === "emerging" } : null,
          chart?.candles
        ).text
      }（評等以現價 ${stockRating.price} 計算，與今日建議、全市場推薦同一份結論，每 10 分鐘更新；回答買賣判斷時第一句照抄，不可推翻）`
    );
    const aiView = describeAiView(await aiJudgePromise, stockRating.rating.code);
    if (aiView) lines.push(`${AI_VIEW_TITLE}${aiView}`);
    // AI 經驗層：相似案例統計＋相關教訓（learning/experienceText.ts；只有台股）。
    lines.push(...(await describeExperience(stockRating).catch(() => [] as string[])));
  }
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
    // 近幾天逐日的交叉紀錄：使用者會追問「昨天有沒有」「這幾天交叉過嗎」，沒有這行 AI 只能
    // 回「無法回溯」（2026-10-04 實測）。見 describeRecentCrosses 的說明。
    const recentCrosses = describeRecentCrosses(chart.candles, getMarketStatus(quote.market) === "open");
    if (recentCrosses) lines.push(`${RECENT_CROSSES_TITLE}（用當天為止的日K現算，可直接回答「昨天有沒有交叉」；今天若在盤中，這根K線會隨最新價變動，盤中出現的交叉到收盤可能消失）：${recentCrosses}`);
  } else {
    lines.push("（歷史走勢資料目前無法取得）");
  }
  // 支撐／壓力＋自洽的買進區間／出場價／不追價，由程式算好（見 priceLevels.ts）；興櫃成交稀疏不給。
  const levelCandles = chartYear?.candles ?? chart?.candles;
  if (stockRating) {
    // 直接用評等那份框架，買進區間的數字才會跟評等逐字相同。
    const levelsText = describePriceFramework(stockRating.framework);
    if (levelsText) lines.push(levelsText);
  } else if (levelCandles && quote.board !== "emerging") {
    const levelsText = describePriceFramework(computePriceFramework(levelCandles, quote.price, quote.market));
    if (levelsText) lines.push(levelsText);
  }
  lines.push("（來源：即時/近即時公開資料）");

  if (fundamentals) {
    const parts: string[] = [];
    if (fundamentals.peRatio != null) parts.push(`本益比 ${fundamentals.peRatio}`);
    if (fundamentals.pbRatio != null) parts.push(`股價淨值比 ${fundamentals.pbRatio}`);
    if (fundamentals.dividendYield != null) parts.push(`殖利率 ${fundamentals.dividendYield}%`);
    // 美股＝上游市值；台股＝現價×已發行普通股數（見 data/marketCap.ts）。
    const marketCap = resolveMarketCap(fundamentals, quote.price);
    if (marketCap != null) parts.push(`市值 ${formatMarketCap(marketCap, quote.currency)}`);
    if (parts.length > 0) lines.push(`基本面：${parts.join("；")}`);
  }

  if (earnings) {
    const parts: string[] = [];
    if (earnings.monthlyRevenueYoyPercent != null) {
      parts.push(`${earnings.monthlyRevenuePeriod ?? "最新月"}營收年增率 ${earnings.monthlyRevenueYoyPercent >= 0 ? "+" : ""}${earnings.monthlyRevenueYoyPercent}%`);
    }
    if (earnings.quarterlyEps != null) {
      // 台股的累計標籤已在資料層統一處理（見 data/earningsLabel.ts），這裡直接用，免得 AI 當成單季跟【歷史脈絡】的單季EPS比。
      const epsLabel = earnings.quarterlyEpsPeriod ?? "最新一季";
      parts.push(`${epsLabel} EPS ${earnings.quarterlyEps}${quote.currency === "TWD" ? "元" : ""}`);
    }
    if (earnings.epsSurprisePercent != null) {
      // 驚喜幅度可能是負的（低於預期），不能一律寫「優於」——以前負值會被寫成「優於市場預期 -0.89%」。
      const s = earnings.epsSurprisePercent;
      parts.push(s > 0 ? `優於市場預期 ${s}%` : s < 0 ? `低於市場預期 ${Math.abs(s)}%` : "與市場預期相同");
    }
    if (earnings.nextEarningsDate) {
      parts.push(`下次公布財報日期約 ${earnings.nextEarningsDate}`);
    }
    if (earnings.twReportDeadline) {
      // 台股沒有公司公告的預定日，這是法定最晚期限，公司可能提早公布；台股也沒有分析師共識，不能談「較市場預期」。
      parts.push(`下次財報${formatTwReportDeadline(earnings.twReportDeadline)}（法定期限，非公司公告日，可能提早公布）`);
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
    // 標題註明資料日；盤中當天的個股法人尚未公布時明講（見 stockNewsAndChips.ts）。
    if (parts.length > 0) lines.push(`${chipsSectionTitle(chips.date ?? chips.marginDate, taipeiDayKey(), isTaipeiWeekend())}：${parts.join("；")}`);
  }
  const chipsRatiosText = describeChipsRatios(chipsRatios);
  if (chipsRatiosText) lines.push(chipsRatiosText);
  const sentimentText = describeSocialSentiment(socialSentiment);
  if (sentimentText) lines.push(sentimentText);
  if (historyText) lines.push(historyText);
  if (sectorFactorsText) lines.push(sectorFactorsText);

  if (announcements.length > 0) {
    const shown = announcements.slice(0, 3).map((a) => `- ${a.date}：${a.subject.length > 80 ? `${a.subject.slice(0, 80)}…` : a.subject}`);
    lines.push(`近期重大訊息公告：\n${shown.join("\n")}`);
  }

  // 濾掉多檔彙整標題（法人買賣超排行等）並標日期，見 stockNewsAndChips.ts。
  const newsLines = formatStockNewsLines(news, quote.symbol);
  if (newsLines.length > 0) {
    lines.push(`近期相關新聞：\n${newsLines.join("\n")}`);
  }

  return { symbol: quote.symbol, text: lines.join("\n") };
}
