import {
  findAllSymbolsByName,
  findInUniverse,
  getChart,
  getChips,
  getEarnings,
  getFundamentals,
  describeTaifexNightFutures,
  getIndices,
  getMaterialAnnouncements,
  getChipsRanking,
  getMultiSignalStocks,
  getQuote,
  getTaifexNightFutures,
  getTechnicalScreen,
  getTwUniverse,
  getValueScreen,
  getVolumeSurgeStocks,
  searchStocks,
} from "@/lib/data";
import type { TechScreenItem } from "@/lib/data";
import type { Market } from "@/lib/data";
import { mapWithConcurrency } from "@/lib/data/cache";
import { fetchNews, fetchNewsMulti, fetchUsMarketNews } from "@/lib/data/news";
import { formatMarketCap, formatSharesWithLots, formatTurnover } from "@/lib/format";
import { callAiProviders } from "@/lib/ai/provider";
import { getNewsFeed } from "@/lib/ai/newsfeed";
import { computeSignals, computeIndicatorState } from "@/lib/signals";
import { computeHoldingPnl } from "@/lib/portfolio";
import { isNearTaiexFuturesSettlement } from "@/lib/marketCalendar";
import type { ChatTurn } from "@/lib/ai/types";

export interface AskResult {
  answer: string;
  groundedSymbol?: string;
  usedAi: boolean;
}

export interface HoldingInput {
  symbol: string;
  market: Market;
  name: string;
  costBasis?: number;
  shares?: number;
}

// The negative lookahead keeps a plain year mention ("2025年台股展望") from
// being read as TW stock code 2025 (千興) — TWSE codes are 4-6 digits with
// no reserved range, so any bare number in that span is otherwise ambiguous
// with a year, and "20XX年" is by far the most common way one shows up in a
// question that isn't about a specific stock at all.
const SYMBOL_PATTERN = /\b\d{4,6}\b(?!\s*年)|\b[A-Z]{1,5}\b/g;

/** Same pattern as twse.ts's own taipeiToday() — each module keeps a small
 *  local copy rather than sharing one, consistent with how us.ts/tpex.ts
 *  already each own their own small date helpers in this codebase. */
function taipeiTodayForAsk(): { year: number; month: number; day: number } {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" })
    .format(new Date())
    .split("-")
    .map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}
// SYMBOL_PATTERN 會把句子裡任何 1-5 個大寫英文字母當成可能的美股代號，所以任何
// 「長得像代號、其實是專有名詞縮寫」的字都要在這裡擋掉，否則會被當成一檔查不到的
// 股票，進而觸發「查無此股」的內部標記。
//
// 實測抓到的真實 bug：問「聯發科現在的RSI和MACD是什麼狀態？技術面偏多還偏空？」，
// 回答變成「另外，MACD 這幾個字並不在本站資料庫的涵蓋範圍內（本站台股涵蓋證交所
// 上市及櫃買中心上櫃公司，美股則是約150多檔精選跨產業大型股）」——RSI 跟 MACD 被
// 當成兩檔查不到的美股，於是模型照著「查無此股」的指示，一本正經地跟使用者解釋
// 技術指標名稱不在股票涵蓋範圍內。這是最傷信任感的那種錯：使用者問的是這個網站
// 自己到處都在用的指標。
//
// 下面這份清單是拿全部 171 檔 US_UNIVERSE 代號逐一比對過的，確認沒有一個會誤殺
// 真實代號。唯二刻意排除在外的是 MA（Mastercard，跟「均線」的英文縮寫撞名）與
// ETN（Eaton，跟「指數投資證券」撞名）——這兩個是真的美股代號，優先當代號處理；
// 中文語境裡講均線幾乎都寫「均線」或「20MA」（緊貼數字時 \b 邊界不成立，本來就
// 不會被誤判），衝突機率遠低於誤殺 Mastercard 的代價。
const STOPWORDS = new Set([
  // 一般英文虛詞
  "THE", "AND", "FOR", "ARE", "WHY", "HOW", "WHAT", "WILL", "WITH", "THIS",
  "THAT", "CAN", "YOU", "PLEASE", "STOCK", "TODAY", "NOW", "AI", "US", "TW",
  "OK", "NO", "YES", "MY", "ALL", "ANY", "ITS", "DID", "GET", "SEE", "ETC", "VS",
  "BUY", "SELL", "HOLD", "LONG", "SHORT", "BULL", "BEAR",
  // 技術指標
  "RSI", "MACD", "KD", "KDJ", "EMA", "SMA", "WMA", "BIAS", "OBV", "ATR", "ADX",
  "CCI", "DIF", "DEA", "VIX",
  // 財務/估值指標
  "EPS", "PE", "PER", "PB", "PBR", "PS", "PPS", "BPS", "DPS", "ROE", "ROA",
  "ROI", "EBIT", "EBITDA", "YOY", "QOQ", "MOM", "CAGR", "FCF", "DCF", "NAV",
  "AUM", "IRR", "NPV", "WACC",
  // 商品/市場/制度
  "ETF", "REIT", "IPO", "SPO", "ADR", "GDR", "OTC", "TWSE", "TPEX", "TAIEX",
  "SOX", "KY", "ESG",
  // 總經與央行
  "CPI", "PPI", "GDP", "PMI", "FED", "FOMC", "ECB", "BOJ", "QE", "QT",
  // 幣別
  "USD", "TWD", "JPY", "EUR", "RMB", "CNY", "HKD", "KRW", "NT",
  // 產業/技術詞彙
  "IC", "ODM", "OEM", "EMS", "HBM", "CPO", "ASIC", "FPGA", "GPU", "CPU", "NPU",
  "TSMC", "APP", "API",
  // 公司治理/職稱
  "CEO", "CFO", "COO", "CTO", "QA", "QC", "SOP", "KPI", "MOU", "SWOT",
]);

async function buildStockGrounding(
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
  const [earnings, news, fundamentals, chips, announcements] = await Promise.all([
    getEarnings(quote.symbol, quote.market).catch(() => null),
    (quote.market === "US" ? fetchNewsMulti(newsQuery, 4, ["zh-TW", "en-US"]) : fetchNews(newsQuery, 8)).catch(
      () => []
    ),
    getFundamentals(quote.symbol, quote.market).catch(() => null),
    getChips(quote.symbol, quote.market).catch(() => null),
    getMaterialAnnouncements(quote.symbol, quote.market).catch(() => []),
  ]);

  const changeLabel = quote.change >= 0 ? "上漲" : "下跌";
  const lines = [
    `股票：${quote.name}（${quote.symbol}，${quote.market === "TW" ? "台股" : "美股"}）`,
    `目前價格：${quote.price} ${quote.currency}，${changeLabel} ${Math.abs(quote.change)}（${quote.changePercent}%）`,
    `今日：開 ${quote.open} / 高 ${quote.high} / 低 ${quote.low} / 昨收 ${quote.prevClose}，成交量 ${quote.volume.toLocaleString()}`,
  ];
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
      parts.push(`優於市場預期 ${earnings.epsSurprisePercent}%`);
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

  if (announcements.length > 0) {
    const shown = announcements.slice(0, 3).map((a) => `- ${a.date}：${a.subject.length > 80 ? `${a.subject.slice(0, 80)}…` : a.subject}`);
    lines.push(`近期重大訊息公告：\n${shown.join("\n")}`);
  }

  if (news.length > 0) {
    lines.push(`近期相關新聞：\n${news.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}`);
  }

  return { symbol: quote.symbol, text: lines.join("\n") };
}

// Matches "有哪些股票不錯"/"什麼股票要漲了"/"推薦一下"/"今天有什麼強勢股" style
// questions that aren't about any one stock — asking for a list, not a lookup.
// Without this, guessSymbolFromText finds nothing, no grounding is attached,
// and the model (correctly, per its instructions not to invent numbers) just
// says it has no data — even though the site already computes exactly this
// kind of thing (焦點排行/技術訊號共振) for the /highlights page.
//
// A real conversation caught this pattern missing common multi-turn follow-
// up phrasings — "還有別的比較有機率漲幅較大的嗎？" matched none of the
// original phrases (no "有哪些"/"推薦"/"強勢股" etc.), so buildMoversGrounding
// never ran and the model, with no fresh screened candidates to work from,
// fell back to generic textbook answers ("留意 AI 伺服器供應鏈如鴻海、廣達")
// instead of naming anything from the site's own data. Broadened to also
// catch "還有別的/其他"-style follow-ups and generic buy-idea phrasing —
// safe to widen, since this only fires when guessSymbolFromText found no
// specific stock in the question at all (see wantsMovers below).
// 2026-09-15 使用者實測發現：問「現在有價漲量增，但還沒連漲，還來得及明天買的
// 股票嗎？」這種完整的篩選問法，原本的關鍵字清單完全沒有一個對得上（沒有「有
// 哪些／推薦／強勢股」這類字眼），導致 wantsMovers 判定為 false、完全沒有附上
// 任何篩選資料，AI 在真的沒拿到資料的情況下如實回答「沒有資料」——這句話本身
// 沒有說謊，但問題出在關鍵字覆蓋率不夠廣，很多常見的篩選問法都漏接。這裡大幅
// 擴充關鍵字，涵蓋「價漲量增」「爆量」「連漲」「來得及」「值得買/適合買」等
// 常見的真實篩選用語。
const MOVERS_INTENT_PATTERN =
  /有哪些|哪幾檔|哪支|哪些股票|推薦|不錯的股票|強勢股|熱門股|飆股|焦點股|上漲的股票|要漲|要噴|準備上漲|還有.{0,3}(別的|其他)|有沒有.{0,3}(別的|其他)|有機會|機率.{0,6}(大|高)|買(什麼|甚麼)|選股|有推薦|價漲量增|价涨量增|價跌量增|量增|爆量|連漲|连涨|連跌|来得及|來得及|適合買|适合买|值得買|值得买|明天買|明天买|買點|买点|進場時機|进场时机|可以買嗎|可以买吗|該買|该买/;

// 上面那組關鍵字仍然接不住「連漲2天可以的話呢」之後的追問（例如「5天呢」「3天
// 呢」這種極短的接續句，本身不含任何關鍵字）——這種句子單獨看毫無線索，但放進
// 對話脈絡裡，使用者顯然是在追問同一個篩選條件的不同天數。這裡不試圖窮舉更多
// 關鍵字（治標不治本），而是直接看：如果這句很短、像是接續問法（含「呢/嗎/的
// 話/怎樣」等語氣詞或單純數字），且之前的對話裡使用者確實問過一次符合上面關鍵
// 字的篩選問題，就視為同一串追問，繼續套用篩選資料。
const BARE_FOLLOWUP_PATTERN = /^[\d一二三四五六七八九十]{0,4}\s*(天|日)?\s*(呢|嗎|吗|的話|的话|怎樣|怎样|可以嗎|可以吗)?[?？!！。.]?$/;

// BARE_FOLLOWUP_PATTERN 只接得住「3天呢?」這種幾乎只剩數字的句子。2026-09-16
// 實測發現同一類問題還有一個更常見的形狀沒接到：「那美股呢?」——上一句問
// 「今天台股有哪些股票不錯?」，接著問「那美股呢?」，這句既不含任何篩選關鍵字、
// 也不是純數字，於是 wantsMovers 判成 false，連美股漲幅榜都沒附上，AI 只能拿
// 大盤指數跟新聞回答，完全沒點名任何一檔美股個股——明明資料裡有美股漲幅榜跟
// 美股技術訊號共振股。這裡用「很短 + 以語氣詞結尾」這個形狀來涵蓋這一整類
// 接續句（那美股呢／台股呢／其他的呢／現在如何），不再靠窮舉關鍵字。
const SHORT_FOLLOWUP_MAX_LEN = 12;
function isShortFollowup(question: string): boolean {
  const trimmed = question.trim().replace(/[?？!！。.,，]+$/g, "");
  if (trimmed.length === 0 || trimmed.length > SHORT_FOLLOWUP_MAX_LEN) return false;
  return /(呢|咧|如何|怎樣|怎麼樣|怎么样|的話|的话)$/.test(trimmed);
}

function isFollowupShape(question: string): boolean {
  return BARE_FOLLOWUP_PATTERN.test(question.trim()) || isShortFollowup(question);
}

// 2026-09-20 正式站實測抓到的漏接：同一段對話裡問「殖利率高的股票有哪些」AI
// 正確列出了殖利率排行，但問「有沒有本益比低的股票」卻回答「參考資料裡沒有提供
// 本益比最低排行」——兩份排行明明是同一個資料區塊（buildMoversGrounding 裡的
// valueBlocks）一起送進來的。差別只在意圖判斷：「有哪些」在
// MOVERS_INTENT_PATTERN 裡，「有沒有…的股票」不在，所以後者根本沒有附上任何
// 篩選資料，AI 如實回答「沒有資料」。
//
// 修法比照 conversationWantsTechScreen 的結構：「提到某個排行用的指標」＋「這句
// 話是在找/篩股票」兩個條件同時成立才算，而不是看到「本益比」就觸發——「本益比
// 是什麼意思」這種名詞解釋不該被塞一整份全市場排行，而「台積電的本益比多少」
// 走的是個股資料那條路（這兩個 pattern 只有在問句沒指到任何特定股票時才會被
// 檢查，見 answerQuestion 裡的 targets.length === 0 前提）。
const RANKING_METRIC_PATTERN =
  /本益比|本益比|PE\s*ratio|殖利率|配息|股利|股價淨值比|股价净值比|淨值比|净值比|成交金額|成交金额|成交量|周轉|周转|跌幅|跌最多|跌得最多|跌深|漲幅|涨幅|法人|外資|外资|投信|自營|自营|買超|买超|賣超|卖超|融資|融资|融券/i;

function conversationWantsMovers(question: string, history: ChatTurn[]): boolean {
  if (MOVERS_INTENT_PATTERN.test(question)) return true;
  if (RANKING_METRIC_PATTERN.test(question) && TECH_SCREEN_VERB_PATTERN.test(question)) return true;
  if (!isFollowupShape(question)) return false;
  return history.some(
    (turn) =>
      turn.role === "user" &&
      (MOVERS_INTENT_PATTERN.test(turn.content) ||
        (RANKING_METRIC_PATTERN.test(turn.content) && TECH_SCREEN_VERB_PATTERN.test(turn.content)))
  );
}

// 「用技術指標篩股票」的問法。拆成「有提到技術指標」＋「這句話是在找/篩股票」
// 兩個條件同時成立才算，而不是看到 KD/MACD/均線就觸發——「MACD是什麼意思」
// 「什麼是黃金交叉」這種純名詞解釋不需要（也不該）附上整份全市場篩選清單。
// 這兩個 pattern 只有在問句完全沒有指到任何特定股票時才會被檢查（見
// answerQuestion 裡的 targets.length === 0 前提），所以「台積電的KD如何」
// 走的是個股資料那條路，不受影響。
const TECH_INDICATOR_PATTERN =
  /黃金交叉|黄金交叉|golden\s*cross|金叉|死亡交叉|死叉|多頭排列|多头排列|空頭排列|空头排列|超賣|超卖|超買|超买|技術指標|技术指标|技術面|技术面|KD|MACD|RSI|布林|K值|D值|均線|均线|乖離|乖离/i;
const TECH_SCREEN_VERB_PATTERN =
  /有沒有|有没有|有哪些|哪些|哪幾|哪几|哪支|哪一?檔|哪一?只|找出|找到|篩選|筛选|挑出|選股|选股|推薦|推荐|符合|同時|同时|都在|都已|條件|条件|股票|標的|标的/;

function conversationWantsTechScreen(question: string, history: ChatTurn[]): boolean {
  if (TECH_INDICATOR_PATTERN.test(question) && TECH_SCREEN_VERB_PATTERN.test(question)) return true;
  // 極短的接續追問（「那KD呢」「其他呢」）本身不成句，靠對話脈絡判斷——
  // 跟 conversationWantsMovers 完全同一套邏輯，理由見那裡的註解。
  if (!isFollowupShape(question)) return false;
  return history.some(
    (turn) =>
      turn.role === "user" && TECH_INDICATOR_PATTERN.test(turn.content) && TECH_SCREEN_VERB_PATTERN.test(turn.content)
  );
}

// 使用者用「這檔/那支/它/第一檔/剛剛那個」指代上文提過的股票，或乾脆只丟一個
// 指標名稱（「本益比多少?」）繼續追問，而沒有再講一次股票名稱。
//
// 2026-09-16 實測抓到的真實錯答：對話裡 AI 已經講過「今天台股漲幅榜前幾名有
// 光鼎(6226)、雍智科技(6683)」，使用者接著問「第一檔的本益比多少?」，AI 回
// 「目前查不到這檔股票的本益比資料」——但 6226 的本益比本站其實查得到，只是
// 這一句沒寫出股票名稱，guessSymbolsFromText 自然什麼都找不到，完全沒有個股
// 資料可用。這個錯答比單純答不出來更糟：使用者會以為本站根本沒有這檔的資料。
const PRONOUN_FOLLOWUP_PATTERN =
  /這[檔支家隻個]|这[档支家只个]|那[檔支家隻]|第[一二三四五六七八九十\d]+[檔支個家只]|剛剛|刚刚|剛才|刚才|上面(那|提到|講|说|說)|前面(那|提到|講|说|說)/;
// 只丟指標名稱的追問（「本益比多少?」「法人買超多少?」）。因為沒有代名詞可以
// 當依據，條件收得比上面嚴格：句子要很短，而且不能含任何「這是在篩全市場」
// 的字眼，避免把「有沒有本益比低的股票」這種全市場篩選問題誤判成在問某一檔。
const METRIC_FOLLOWUP_PATTERN =
  /本益比|殖利率|股價淨值比|淨值比|市值|營收|营收|EPS|財報|财报|法人|籌碼|筹码|融資|融券|技術面|技术面|基本面|新聞|新闻|消息|現價|现价|股價|股价|漲跌|涨跌|成交量|均線|均线|RSI|MACD|KD|布林/i;
const METRIC_FOLLOWUP_MAX_LEN = 14;
const SCREENING_WORDS_PATTERN = /有沒有|有没有|有哪些|哪些|哪幾|哪几|哪支|推薦|推荐|篩選|筛选|選股|选股|排行|最高|最低|前幾名|前几名/;

function parseOrdinal(question: string): number | null {
  const digit = question.match(/第(\d+)[檔支個家只]/);
  if (digit) return Number(digit[1]);
  const CH = "一二三四五六七八九十";
  const chinese = question.match(new RegExp(`第([${CH}])[檔支個家只]`));
  if (chinese) return CH.indexOf(chinese[1]) + 1;
  return null;
}

/**
 * 這一句沒有寫出股票名稱、但顯然是在追問上文提過的某一檔時，從對話紀錄裡
 * 把那一檔找回來。只在完全沒解析到股票、也不是全市場篩選/主題問題時才會被
 * 呼叫（見 answerQuestion 裡的呼叫條件），所以不會搶走篩選類問題的資料。
 */
async function resolveFollowupTargets(
  question: string,
  history: ChatTurn[]
): Promise<Array<{ symbol: string; market: Market | undefined }>> {
  const trimmed = question.trim();
  const hasPronoun = PRONOUN_FOLLOWUP_PATTERN.test(trimmed);
  const bareMetric =
    METRIC_FOLLOWUP_PATTERN.test(trimmed) &&
    trimmed.length <= METRIC_FOLLOWUP_MAX_LEN &&
    !SCREENING_WORDS_PATTERN.test(trimmed);
  if (!hasPronoun && !bareMetric) return [];

  const ordinal = parseOrdinal(trimmed);
  // 由新到舊找第一則真的有提到股票的訊息（通常是 AI 上一則點名了幾檔的回答）。
  for (let i = history.length - 1; i >= 0; i--) {
    const found = await guessSymbolsFromText(history[i].content);
    if (found.length === 0) continue;
    const picked = ordinal != null && found[ordinal - 1] ? found[ordinal - 1] : found[0];
    return [{ symbol: picked.symbol, market: picked.market }];
  }
  return [];
}

// Momentum stocks get more slots than plain gainers: a gainer is just one
// number (today's %), but each momentum entry carries several independent,
// quantified technical readings (volume ratio, MA position, streak length,
// new high/low) that are worth surfacing in bulk so the model has enough
// material to explain *why* each one screens as technically strong, not
// just name it.
const GAINERS_N = 8;
const MOMENTUM_N = 12;
// 「技術訊號共振股」（getMultiSignalStocks）先天只從「當日漲跌幅最大的前15檔」
// 裡挑，所以像連漲多天但當天漲幅不是全市場數一數二的股票（例如漲停已經漲不動、
// 或漲幅普通但已經連漲好幾天）根本不會進到候選池——這正是使用者實測抓到的真實
// bug：問「價漲量增、連漲N天」的股票時被誤答「沒有資料」，但那些股票明明存在。
// getVolumeSurgeStocks 改成先掃全市場找出「今日價漲且量增」的股票（不受漲跌幅
// 排名限制），再算每一檔的連續上漲天數，補上這個原本抓不到的族群。
const VOLUME_SURGE_N = 30;

// 「成交金額最大」的排行要另外列，不能靠漲幅榜代打：使用者問「今天成交量最大的
// 是哪幾檔」時，原本資料裡根本沒有這份排行，AI 只好拿技術訊號共振股的法人買賣超
// 硬湊，答出來的東西跟「成交量最大」沒有關係。
const TURNOVER_N = 10;

// 一檔股票在「技術指標明細表」裡的一行。刻意把每個指標的實際數值都寫出來
// （K/D 幾點、RSI 幾點、MACD 在 0 軸哪一側），而不是只寫有沒有訊號——這樣
// AI 才有辦法回答「KD 剛交叉但還在低檔」「RSI 還沒過熱」這種帶數值條件的
// 追問，也讓它引用的每個數字都有出處、不需要自己編。
function describeTechState(item: TechScreenItem): string {
  const s = item.state;
  const parts: string[] = [];
  const zoneText = { low: "低檔/超賣區", mid: "中間區間", high: "高檔/超買區" } as const;
  parts.push(
    s.macdCross === "golden"
      ? `MACD黃金交叉（${s.macdAboveZero ? "0軸上方，訊號較明確" : "0軸下方，屬低檔訊號，力道較弱"}）`
      : s.macdCross === "death"
        ? `MACD死亡交叉（${s.macdAboveZero ? "0軸上方" : "0軸下方，屬續跌訊號"}）`
        : s.macdAboveZero === null
          ? "MACD資料不足"
          : `MACD今日未交叉（MACD線在0軸${s.macdAboveZero ? "上方" : "下方"}）`
  );
  if (s.kd) {
    const crossText =
      s.kd.cross === "golden"
        ? `KD黃金交叉（K值${s.kd.prevK.toFixed(1)}→${s.kd.k.toFixed(1)}上穿D值${s.kd.prevD.toFixed(1)}→${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`
        : s.kd.cross === "death"
          ? `KD死亡交叉（K值${s.kd.k.toFixed(1)}下穿D值${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`
          : `KD今日未交叉（K值${s.kd.k.toFixed(1)}、D值${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`;
    parts.push(crossText);
  } else {
    parts.push("KD資料不足");
  }
  parts.push(
    s.maAlignment === "bullish"
      ? "均線多頭排列（5日線>10日線>20日線）"
      : s.maAlignment === "bearish"
        ? "均線空頭排列（5日線<10日線<20日線）"
        : "均線未成明確排列"
  );
  if (s.aboveMa20 !== null) parts.push(s.aboveMa20 ? "站上20日均線" : "跌破20日均線");
  if (s.rsi != null) {
    const tag = s.rsi >= 70 ? "，超買區" : s.rsi <= 30 ? "，超賣區" : "，未過熱也未超賣";
    parts.push(`RSI ${s.rsi.toFixed(0)}${tag}`);
  }
  if (s.bollinger) parts.push(s.bollinger === "upper" ? "觸及布林通道上緣" : "觸及布林通道下緣");
  if (s.streakDirection && s.streakDays >= 1) {
    parts.push(`連${s.streakDirection === "up" ? "漲" : "跌"}${s.streakDays}天`);
  }
  if (s.volumeRatio != null) parts.push(`量能${s.volumeRatio.toFixed(1)}倍均量`);
  return `${item.name}(${item.symbol})，現價${item.price}(${item.changePercent >= 0 ? "+" : ""}${item.changePercent}%)：${parts.join("、")}`;
}

// 明細表最多列幾檔：凡是「今天有任一交叉」的一律全部列出（這才是多重指標
// 篩選真正會用到的母體，通常一天只有十幾檔），另外再補上成交金額最大的
// 幾檔（讓「台積電現在技術面如何」這類問法也有數值可引用）。
const TECH_TABLE_EXTRA_BY_TURNOVER = 25;

/**
 * 「多重技術指標同時符合」的篩選資料。
 *
 * 使用者要求：問「現在有沒有MACD與KD線都在黃金交叉，適合明天買入的股票?」
 * 這種同時要符合多個技術條件的問題時，要真的去查證資料、確定回答內容正確。
 * 2026-09-16 實測的真實 bug：當天市場上確實有股票同時符合（嘉基6715），
 * AI 卻回答「資料裡沒有同時列出MACD與KD都黃金交叉的股票」——因為舊的
 * 「技術訊號共振股」只掃當日漲跌幅前15檔（見 getTechnicalScreen 的註解），
 * 而且舊的 KD 訊號只認低檔交叉（見 lib/signals.ts 的 KD 註解），兩個原因
 * 疊在一起讓正確答案根本不可能出現在 AI 手上。
 *
 * 這裡把常見組合先用程式算好交集（而不是把一堆資料丟給 AI 讓它自己配對，
 * 那正是會出錯的地方），同時附上完整的指標明細表，讓沒有事先列舉到的
 * 其他組合（例如「均線多頭排列＋RSI未過熱＋站上20日均線」）也有真實數值
 * 可以逐檔核對。
 */
async function buildTechScreenGrounding(): Promise<string> {
  const [tw, us] = await Promise.all([
    getTechnicalScreen("TW").catch(() => [] as TechScreenItem[]),
    getTechnicalScreen("US").catch(() => [] as TechScreenItem[]),
  ]);
  if (tw.length === 0 && us.length === 0) return "";

  const blockFor = (items: TechScreenItem[], marketLabel: string, scanned: number): string => {
    if (items.length === 0) return "";
    const fmtList = (list: TechScreenItem[]) =>
      list.length === 0
        ? "（今天掃描範圍內一檔都沒有，這是實際比對過每一檔指標後的結果，可以直接回答「今天沒有」）"
        : list.map((i) => `- ${describeTechState(i)}`).join("\n");

    const macdGolden = items.filter((i) => i.state.macdCross === "golden");
    const macdDeath = items.filter((i) => i.state.macdCross === "death");
    const kdGolden = items.filter((i) => i.state.kd?.cross === "golden");
    const kdDeath = items.filter((i) => i.state.kd?.cross === "death");
    const bothGolden = items.filter((i) => i.state.macdCross === "golden" && i.state.kd?.cross === "golden");
    const bothDeath = items.filter((i) => i.state.macdCross === "death" && i.state.kd?.cross === "death");
    const bullishMaHealthyRsi = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.rsi != null && i.state.rsi < 70
    );
    const bullishMaMacdGolden = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.macdCross === "golden"
    );
    const oversoldTurning = items.filter(
      (i) => i.state.kd?.cross === "golden" && i.state.rsi != null && i.state.rsi <= 40
    );

    const crossed = items.filter((i) => i.state.macdCross !== null || i.state.kd?.cross != null);
    const crossedSymbols = new Set(crossed.map((i) => i.symbol));
    const extras = items
      .slice()
      .sort((a, b) => b.turnover - a.turnover)
      .filter((i) => !crossedSymbols.has(i.symbol))
      .slice(0, TECH_TABLE_EXTRA_BY_TURNOVER);
    const tableRows = [...crossed, ...extras];

    return [
      `【${marketLabel}多重技術指標篩選】掃描範圍：依今日成交金額由大到小的前 ${scanned} 檔${marketLabel}（不是全部上市櫃股票；這個排序跟「有沒有發生指標交叉」完全無關，所以不會系統性漏掉某一類股票，但極冷門、幾乎沒有成交的股票不在範圍內）。以下每一檔的指標都是用該檔近3個月真實日K線當場算出來的，不是估計值。`,
      `${marketLabel}「MACD黃金交叉 且 KD黃金交叉」同時成立（共${bothGolden.length}檔）：\n${fmtList(bothGolden)}`,
      `${marketLabel}「MACD死亡交叉 且 KD死亡交叉」同時成立（共${bothDeath.length}檔）：\n${fmtList(bothDeath)}`,
      `${marketLabel}今日 MACD黃金交叉（共${macdGolden.length}檔）：\n${fmtList(macdGolden)}`,
      `${marketLabel}今日 KD黃金交叉（K值上穿D值，共${kdGolden.length}檔；括號裡會註明發生在低檔/中間/高檔，低檔交叉是最標準的轉強訊號，高檔交叉要留意追高風險）：\n${fmtList(kdGolden)}`,
      `${marketLabel}今日 MACD死亡交叉（共${macdDeath.length}檔）：\n${fmtList(macdDeath)}`,
      `${marketLabel}今日 KD死亡交叉（共${kdDeath.length}檔）：\n${fmtList(kdDeath)}`,
      `${marketLabel}「均線多頭排列 且 RSI未過熱（RSI<70）」（共${bullishMaHealthyRsi.length}檔）：\n${fmtList(bullishMaHealthyRsi)}`,
      `${marketLabel}「均線多頭排列 且 MACD黃金交叉」（共${bullishMaMacdGolden.length}檔）：\n${fmtList(bullishMaMacdGolden)}`,
      `${marketLabel}「KD黃金交叉 且 RSI仍低（RSI≤40，尚未漲多）」（共${oversoldTurning.length}檔）：\n${fmtList(oversoldTurning)}`,
      `${marketLabel}技術指標明細表（今天有發生任一交叉的全部列出，另補上成交金額最大的幾檔；使用者問到上面沒有預先列出的其他指標組合時，一律從這張表逐檔比對後回答，不要自己回想或推測）：\n${tableRows.map((i) => `- ${describeTechState(i)}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  return [blockFor(tw, "台股", tw.length), blockFor(us, "美股", us.length)].filter(Boolean).join("\n\n");
}

async function buildMoversGrounding(): Promise<string> {
  try {
    const [twGainers, usGainers, twMomentum, usMomentum, twVolumeSurge, twTurnover, twValueScreen, twChipsRanking] =
      await Promise.all([
        searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }),
        searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" }),
        getMultiSignalStocks("TW"),
        getMultiSignalStocks("US"),
        getVolumeSurgeStocks("TW").catch(() => []),
        searchStocks({ market: "TW", sortBy: "turnover", sortDir: "desc" }).catch(() => []),
        getValueScreen("TW").catch(() => null),
        getChipsRanking("TW").catch(() => null),
      ]);
    // TW momentum candidates also get their institutional flow attached —
    // without this, a "what else looks good" question could only be
    // answered with price/technical data, which reads as generic. Chip
    // data gives the model something concrete and stock-specific to cite
    // (e.g. "外資今天同步買超") beyond textbook sector commentary. US has
    // no equivalent public data source, so US entries are technical-only.
    const twMomentumSlice = twMomentum.slice(0, MOMENTUM_N);
    const twChips = await Promise.all(
      twMomentumSlice.map((s) => getChips(s.symbol, "TW").catch(() => null))
    );
    const fmtGainer = (items: typeof twGainers) =>
      items.slice(0, GAINERS_N).map((s) => `${s.name}(${s.symbol}) ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%`).join("、") || "（無資料）";
    const fmtMomentum = (items: typeof twMomentum, chips?: (typeof twChips)[number][]) =>
      items
        .map((s, i) => {
          const chip = chips?.[i];
          const chipText = chip?.institutionalNetShares != null ? `；三大法人${formatSharesWithLots(chip.institutionalNetShares)}` : "";
          return `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)：${s.signals.map((sig) => sig.label).join("、")}${chipText}`;
        })
        .join("\n") || "（無資料）";
    const surgeSlice = twVolumeSurge.slice(0, VOLUME_SURGE_N);
    const fmtSurge = (items: typeof surgeSlice) =>
      items
        .map((s) => {
          const ratioText = s.volumeRatio != null ? `均量${s.volumeRatio.toFixed(1)}倍` : "";
          const streakText =
            s.streakDirection === "up" && s.streakDays >= 1
              ? `連漲${s.streakDays}天`
              : s.streakDirection === "down" && s.streakDays >= 1
                ? `今日雖上漲但近日走勢是連跌${s.streakDays}天後的反彈（尚未轉為連漲）`
                : "今日剛上漲，前一天走勢持平或方向不同（連漲天數算0，不成立連續）";
          return `${s.name}(${s.symbol})，現價${s.price}(+${s.changePercent}%)，${ratioText}，${streakText}`;
        })
        .join("\n") || "（今天沒有符合「價漲且量能明顯高於自身均量」條件的股票）";

    // 「連漲N天」的答案改成用程式先分好組，而不是讓 AI 自己從上面那份逐檔清單
    // 裡挑出符合天數的股票。2026-09-20 正式站實測：問「連漲6天呢」，清單裡其實
    // 沒有任何一檔剛好連漲 6 天（最接近的資通(2471)是連漲 7 天，程式算出來的真實
    // 數字），AI 卻回答「符合連漲6天的有：資通(2471)…連漲6天」——把使用者問的
    // 天數當成答案寫了出去，等於憑空捏造一個跟資料不符的數字。先用 prompt 規則
    // 要求「一定要寫出實際天數、差兩天就要老實說」試過一次，沒有用（AI 照樣寫
    // 6 天），所以改成結構性解法：直接把「哪些天數有、各有哪幾檔」算好給它，
    // 讓「有沒有剛好 N 天」變成查表，而不是需要 AI 自己逐檔比對的推理工作。
    const upStreaks = twVolumeSurge.filter((s) => s.streakDirection === "up" && s.streakDays >= 1);
    const streakDayList = [...new Set(upStreaks.map((s) => s.streakDays))].sort((a, b) => a - b);
    const streakIndex =
      upStreaks.length === 0
        ? "（今天這份清單裡沒有任何一檔是連續上漲的）"
        : [
            `清單裡實際出現過的連漲天數只有這幾種：${streakDayList.map((d) => `${d}天`).join("、")}。使用者問的天數如果不在這串數字裡，就是「今天沒有剛好連漲N天的股票」，要照實說，不可以把最接近的那檔說成符合N天。`,
            ...streakDayList.map(
              (d) =>
                `連漲${d}天（共${upStreaks.filter((s) => s.streakDays === d).length}檔）：${upStreaks
                  .filter((s) => s.streakDays === d)
                  .map((s) => `${s.name}(${s.symbol})`)
                  .join("、")}`
            ),
          ].join("\n");

    // 以下三組清單（成交金額榜、估值/跌幅篩選、法人買賣超排行）都是後來補的：
    // 實測發現使用者問「本益比低的股票」「殖利率高的股票」「今天跌最多的」
    // 「三大法人在買什麼」「外資買超最多的」「成交量最大的」這些非常自然的篩選
    // 問法時，AI 一律回答「資料裡沒有提供個股的本益比/殖利率數據」或拿漲幅榜硬湊
    // ——本站其實全都有全市場資料（見 getValueScreen/getChipsRanking 的註解），
    // 只是從來沒有整理成清單送進來，跟「價漲量增誤答沒有資料」是同一類問題。
    const fmtTurnover = (items: typeof twTurnover) =>
      items
        .slice(0, TURNOVER_N)
        .map((s) => `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，成交金額約${formatTurnover(s.turnover, "TW")}`)
        .join("\n") || "（無資料）";
    const fmtValue = (items: NonNullable<typeof twValueScreen>["lowPe"], metric: "pe" | "yield" | "pb" | "change") =>
      items
        .map((s) => {
          const detail =
            metric === "pe"
              ? `本益比 ${s.peRatio}`
              : metric === "yield"
                ? `殖利率 ${s.dividendYield}%`
                : metric === "pb"
                  ? `股價淨值比 ${s.pbRatio}`
                  : `今日${s.changePercent}%`;
          const extras = [
            metric !== "pe" && s.peRatio != null ? `本益比 ${s.peRatio}` : "",
            metric !== "yield" && s.dividendYield != null ? `殖利率 ${s.dividendYield}%` : "",
            metric !== "pb" && s.pbRatio != null ? `股價淨值比 ${s.pbRatio}` : "",
          ].filter(Boolean);
          return `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，${detail}${extras.length > 0 ? `；${extras.join("、")}` : ""}`;
        })
        .join("\n") || "（無資料）";
    const fmtChips = (items: NonNullable<typeof twChipsRanking>["institutionalBuy"]) =>
      items
        .map((s) => `${s.name}(${s.symbol})，現價${s.price}(${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%)，${formatSharesWithLots(s.netShares)}`)
        .join("\n") || "（無資料）";

    const valueBlocks = twValueScreen
      ? [
          `台股「本益比最低」排行（全市場掃描，只含今日成交金額 3000 萬元以上、真的有人在交易的股票，依本益比由低到高，共列 ${twValueScreen.lowPe.length} 檔。本益比低不等於便宜——景氣循環股在獲利高點時本益比天生就低，回答時要提醒這一點）：\n${fmtValue(twValueScreen.lowPe, "pe")}`,
          `台股「殖利率最高」排行（同上流動性條件，依殖利率由高到低，共列 ${twValueScreen.highYield.length} 檔。殖利率是用「過去已配發的現金股利 ÷ 現價」算的，不保證明年配一樣多）：\n${fmtValue(twValueScreen.highYield, "yield")}`,
          `台股「股價淨值比最低」排行（同上流動性條件，共列 ${twValueScreen.lowPb.length} 檔）：\n${fmtValue(twValueScreen.lowPb, "pb")}`,
          `台股今日跌幅榜（同上流動性條件，依今日跌幅由大到小，共列 ${twValueScreen.decliners.length} 檔。使用者問「跌最多的」「跌深反彈」「有沒有可以撿的」時就用這份清單，不要說沒有資料；但「跌得多」不等於「跌深了該撿」，要結合估值跟趨勢講清楚）：\n${fmtValue(twValueScreen.decliners, "change")}`,
        ]
      : [];
    const chipsBlocks = twChipsRanking
      ? [
          `台股今日「三大法人合計買超」排行前${twChipsRanking.institutionalBuy.length}（全市場，股數已換算好對應張數，直接引用不要自己重算）：\n${fmtChips(twChipsRanking.institutionalBuy)}`,
          `台股今日「三大法人合計賣超」排行前${twChipsRanking.institutionalSell.length}：\n${fmtChips(twChipsRanking.institutionalSell)}`,
          `台股今日「外資買超」排行前${twChipsRanking.foreignBuy.length}（只算外資這一家，跟上面的三大法人合計是不同數字，不要混用）：\n${fmtChips(twChipsRanking.foreignBuy)}`,
          `台股今日「外資賣超」排行前${twChipsRanking.foreignSell.length}：\n${fmtChips(twChipsRanking.foreignSell)}`,
          `台股今日「投信買超」排行前${twChipsRanking.trustBuy.length}：\n${fmtChips(twChipsRanking.trustBuy)}`,
        ]
      : [];

    return [
      `台股今日漲幅榜前${GAINERS_N}：${fmtGainer(twGainers)}`,
      `美股今日漲幅榜前${GAINERS_N}：${fmtGainer(usGainers)}`,
      `台股技術訊號共振股（同時符合≥2個客觀技術訊號，依訊號數量排序，共${twMomentum.length}檔，列出前${MOMENTUM_N}，含三大法人買賣超；股數已換算好對應張數，直接引用不要自己重算）：\n${fmtMomentum(twMomentumSlice, twChips)}`,
      `美股技術訊號共振股（共${usMomentum.length}檔，列出前${MOMENTUM_N}）：\n${fmtMomentum(usMomentum.slice(0, MOMENTUM_N))}`,
      `台股今日「價漲量增」股票（今日上漲、且成交量明顯高於自己近期均量，依成交金額排序，共${twVolumeSurge.length}檔，列出前${surgeSlice.length}，每檔都附上實際算出來的連續上漲天數——這是傳統技術分析的價量關係推論，不是真實委買賣單資料，見前述說明；使用者問「剛漲一天/連漲兩天/連漲三天...」這類指定天數的問題時，直接從這份清單裡依「連漲N天」精準篩選回答，天數是逐檔用近1個月K線實際比對算出來的真實數字，不是用今日漲跌%推測，不需要說「沒有資料」）：\n${fmtSurge(surgeSlice)}`,
      `台股「價漲量增」清單依連漲天數分組（這是上面那份清單用程式分好組的結果，不是另一份資料；使用者問「連漲N天的有哪些」時**一律直接查這張表**，不要自己去上面逐檔比對、也不要憑印象作答。表裡沒有列到的天數就是今天真的沒有，要照實說「今天沒有剛好連漲N天的」，然後可以順便告訴使用者有哪些天數，絕對不可以把別的天數的股票寫成符合使用者問的天數）：\n${streakIndex}`,
      `台股今日成交金額排行前${TURNOVER_N}（使用者問「今天成交量/成交金額最大的是哪幾檔」時用這份，不要拿漲幅榜或法人買超清單代替）：\n${fmtTurnover(twTurnover)}`,
      ...valueBlocks,
      ...chipsBlocks,
    ].join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The client's watchlist lives in localStorage, not anywhere this server
 * code can reach on its own — so "analyze my watchlist" only works because
 * the widget reads it and sends it along with the request. Each entry gets
 * a live requote (the client's copy is whatever the page last fetched,
 * which can be stale) and, when cost/shares were entered, its unrealized
 * P&L computed from that live price.
 */
async function buildHoldingsGrounding(holdings: HoldingInput[], includeTechnical = false): Promise<string> {
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

/**
 * 把一檔股票「每個技術指標當下的實際狀態」寫成一句話——**沒有觸發交叉的指標
 * 也一樣要出現**，這正是它跟 computeSignals()（只回傳已觸發的標籤）的分工。
 * 見呼叫端（個股資料組裝處）註解記錄的那個實測缺口。
 */
function describeIndicatorState(state: ReturnType<typeof computeIndicatorState>): string {
  if (!state) return "";
  const parts: string[] = [];
  parts.push(
    state.macdCross === "golden"
      ? `MACD：今日黃金交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
      : state.macdCross === "death"
        ? `MACD：今日死亡交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
        : state.macdAboveZero == null
          ? "MACD：K線根數不足，算不出來"
          : `MACD：今日沒有發生交叉，MACD線（DIF）目前位於0軸${state.macdAboveZero ? "上方（多方力道相對占優）" : "下方（空方力道相對占優）"}`
  );
  parts.push(
    state.kd
      ? state.kd.cross === "golden"
        ? `KD：今日黃金交叉（K值${state.kd.k.toFixed(1)}上穿D值${state.kd.d.toFixed(1)}）`
        : state.kd.cross === "death"
          ? `KD：今日死亡交叉（K值${state.kd.k.toFixed(1)}下穿D值${state.kd.d.toFixed(1)}）`
          : `KD：今日沒有交叉（K值${state.kd.k.toFixed(1)}、D值${state.kd.d.toFixed(1)}）`
      : "KD：資料不足"
  );
  parts.push(state.rsi != null ? `RSI(14)：${state.rsi.toFixed(0)}` : "RSI：資料不足");
  if (state.maAlignment) parts.push(`均線：${state.maAlignment === "bullish" ? "多頭排列" : "空頭排列"}`);
  if (state.aboveMa20 != null) parts.push(`現價${state.aboveMa20 ? "站上" : "跌破"}20日均線`);
  if (state.streakDirection && state.streakDays >= 1) {
    parts.push(`連${state.streakDirection === "up" ? "漲" : "跌"}${state.streakDays}天`);
  }
  if (state.volumeRatio != null) parts.push(`今日量能約為近20日均量的${state.volumeRatio.toFixed(1)}倍`);
  return parts.join("；");
}

/** 單一持股的技術指標描述，格式跟【技術指標篩選】區塊一致，讓 AI 在兩邊看到
 *  同一檔股票時說法不會前後矛盾。 */
async function describeHoldingTechnical(quote: { symbol: string; market: Market; price: number }): Promise<string> {
  try {
    const chart = await getChart(quote.symbol, "3m", quote.market);
    if (!chart) return "；技術面：目前抓不到K線資料，無法計算指標";
    const state = computeIndicatorState(chart.candles, quote.price);
    if (!state) return "；技術面：K線資料不足，無法計算指標";
    const crossText =
      state.macdCross === "golden"
        ? `有MACD黃金交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
        : state.macdCross === "death"
          ? "有MACD死亡交叉"
          : "今日沒有MACD交叉";
    const kdText = state.kd
      ? state.kd.cross === "golden"
        ? `有KD黃金交叉（K值${state.kd.k.toFixed(1)}上穿D值${state.kd.d.toFixed(1)}）`
        : state.kd.cross === "death"
          ? `有KD死亡交叉（K值${state.kd.k.toFixed(1)}下穿D值${state.kd.d.toFixed(1)}）`
          : `今日沒有KD交叉（K值${state.kd.k.toFixed(1)}、D值${state.kd.d.toFixed(1)}）`
      : "KD資料不足";
    const signals = computeSignals(chart.candles, quote.price, "3m");
    const signalText = signals.length > 0 ? signals.map((s) => s.label).join("、") : "今日沒有觸發任何技術訊號";
    return `；技術面：${crossText}、${kdText}；已觸發的技術訊號：${signalText}`;
  } catch {
    return "；技術面：指標計算失敗";
  }
}

// Matches the chat widget's "📋 分析我的關注清單" button text and close
// variants — a user reported the resulting analysis reading as "just data"
// (a one-line quote+P&L per stock, see buildHoldingsGrounding above) and
// asked for a real per-stock analysis instead: technical+fundamental+chip+
// news synthesized together, a trend view, and a specific suggested action
// with a price range — the same depth a single-stock question already gets
// via buildStockGrounding, just run for every watchlist entry at once.
// Gated behind this intent check (rather than always running whenever
// `holdings` is non-empty) so a casual, unrelated question that happens to
// still be carrying the watchlist along doesn't pay for a full
// buildStockGrounding() fan-out it didn't ask for.
const HOLDINGS_ANALYSIS_INTENT_PATTERN =
  /分析.{0,4}(我|一下)?.{0,4}(關注|持股|清單)|(關注|持股)清單.{0,6}分析|看看.{0,4}(我|我的)?.{0,4}(關注|持股)|我的?(關注|持股).{0,6}(如何|怎麼樣|狀況|表現)/;

// Matches the exact phrasing ChatWidget.tsx's "問AI關於<股票>" button
// pre-fills ("關於 台積電（2330），最近走勢如何？") plus close variants a
// user might type themselves after opening that same context. See
// wantsSingleStockAnalysis's own comment for why this is gated on
// contextSymbol rather than firing for any question that happens to
// mention "走勢".
const SINGLE_STOCK_ANALYSIS_INTENT_PATTERN =
  /最近走勢|該不該(買|賣|進場|出場)|值得(買|進場)|現在.{0,4}(能不能|可以|該).{0,4}(買|賣|進場)|(買|賣)點|現在.{0,6}(如何|怎麼樣|狀況)/;

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
async function buildHoldingsAnalysisGrounding(holdings: HoldingInput[]): Promise<string> {
  if (holdings.length === 0) return "";
  const rich = holdings.slice(0, HOLDINGS_ANALYSIS_LIMIT);
  const overflow = holdings.slice(HOLDINGS_ANALYSIS_LIMIT);

  const richBlocks = await mapWithConcurrency(rich, HOLDINGS_ANALYSIS_CONCURRENCY, async (h) => {
    const grounding = await buildStockGrounding({ symbol: h.symbol, market: h.market }).catch(() => undefined);
    if (!grounding) return `${h.name}(${h.symbol})：目前查不到完整資料，暫時無法分析`;
    const isHeld = h.costBasis != null && h.shares != null && h.shares > 0;
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

// A comparison question ("台積電跟聯發科比較"、"2330和2454哪個好") names more
// than one company at once — capped at 4 so a rambling question naming half
// the market doesn't turn into 4+ parallel buildStockGrounding() calls each
// firing their own quote/chart/fundamentals/news fetches.
const MAX_COMPARE_TARGETS = 4;

async function guessSymbolsFromText(text: string): Promise<{ symbol: string; market: Market }[]> {
  // findSymbolByName/findAllSymbolsByName read a module-level snapshot that
  // only gets populated once getTwUniverse() has actually run in this
  // process — true even after the universe.ts fix that made that snapshot
  // cover the full official TWSE+TPEx listing rather than a small seed. A
  // plain single-stock chat question never otherwise calls getTwUniverse()
  // (only searchStocks/momentum/etc. do), so on Vercel — many short-lived
  // serverless instances, each with its own copy of that module-level
  // variable — a request could easily land on an instance that never
  // happened to run it, silently falling back to a tiny seed list and
  // failing to find anything but the most obvious large caps. Awaiting it
  // here is cheap regardless: the underlying data is Redis-cached (shared
  // across every instance, unlike the in-memory snapshot itself), so this
  // is a fast cache hit on any instance that isn't the very first to ever
  // run cold.
  await getTwUniverse().catch(() => undefined);

  const seen = new Set<string>();
  const candidates: Array<{ symbol: string; market: Market; index: number }> = [];
  // A company name already matched (e.g. "apple" -> AAPL via "Apple Inc.")
  // can ALSO look like a valid ticker once the whole text is uppercased —
  // "apple".toUpperCase() is "APPLE", which the ticker regex below happily
  // accepts (5 letters, not a stopword) as a second, bogus candidate
  // distinct from AAPL (seen tracks resolved *symbols*, so "APPLE" the
  // literal string was never excluded). That produced a real, reproducible
  // answer where the model treated the same word as two different unknown
  // stocks — "另一檔『APPLE』不在本站美股精選範圍內" tacked onto an
  // otherwise-correct AAPL answer. Every name variant actually matched
  // (including the corp-suffix-stripped ones findAllSymbolsByName tries) is
  // recorded here so the ticker scan can skip re-claiming text that's
  // already spoken for by a name match.
  const matchedNameSubstrings: string[] = [];

  for (const entry of findAllSymbolsByName(text, MAX_COMPARE_TARGETS * 2)) {
    if (seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    candidates.push({ symbol: entry.symbol, market: entry.market, index: text.indexOf(entry.name) });
    matchedNameSubstrings.push(entry.name.toLowerCase());
  }

  // Numeric codes/tickers are checked too (not just names) and merged by
  // symbol — e.g. "2330 跟 2454 比較" has no company *name* in it at all,
  // and "2330(台積電)" shouldn't double-count the same stock from both a
  // name match and a code match.
  const upper = text.toUpperCase();
  const matches = upper.match(SYMBOL_PATTERN);
  if (matches) {
    for (const m of matches) {
      if (seen.has(m)) continue;
      if (/^\d{4,6}$/.test(m)) {
        seen.add(m);
        candidates.push({ symbol: m, market: "TW", index: upper.indexOf(m) });
      } else if (
        !STOPWORDS.has(m) &&
        /^[A-Z]{1,5}$/.test(m) &&
        !matchedNameSubstrings.some((name) => name.includes(m.toLowerCase()))
      ) {
        seen.add(m);
        candidates.push({ symbol: m, market: "US", index: upper.indexOf(m) });
      }
    }
  }

  return candidates
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_COMPARE_TARGETS)
    .map(({ symbol, market }) => ({ symbol, market }));
}

// Users often ask about an informal "theme" of stocks (e.g. "AI概念股"、
// "半導體股"、"航運股") rather than either one specific stock or a generic
// "what's hot" question. Two tiers of theme resolution:
// 1. Official industry categories — TWSE/TPEx's own shared classification
//    (TW_INDUSTRY_NAMES in twse.ts, used by both exchanges since universe.ts
//    merged them) is already attached to every stock in the universe.
//    Mapping a theme keyword straight to one of these is safe: it's real
//    official classification data, not a judgment call this site is making.
// 2. A small hand-curated overlay for informal CROSS-sector groupings that
//    have no single official category (e.g. "AI概念股" spans chip design,
//    fab, AI-server ODM/assembly, and high-speed-interconnect makers) —
//    deliberately short and limited to names repeatedly and widely reported
//    in Taiwan financial media as core constituents, precisely because
//    there's no official source backing this one. The grounding text says
//    so explicitly so the model never presents it as an exhaustive or
//    official list.
interface ThemeMatch {
  label: string;
  sector?: string;
  symbols?: Array<{ symbol: string; market: Market }>;
  curated?: boolean;
}

const SECTOR_THEMES: Array<{ pattern: RegExp; sector: string; label: string }> = [
  { pattern: /半導體(股|類股|產業)?/, sector: "半導體業", label: "半導體" },
  { pattern: /航運(股|類股)?/, sector: "航運業", label: "航運" },
  { pattern: /金融股|金融類股/, sector: "金融保險業", label: "金融" },
  { pattern: /生技(股|類股)?|生醫股/, sector: "生技醫療業", label: "生技醫療" },
  { pattern: /鋼鐵股|鋼鐵類股/, sector: "鋼鐵工業", label: "鋼鐵" },
  { pattern: /通信網路股|電信類股/, sector: "通信網路業", label: "通信網路" },
  { pattern: /光電股|光電類股/, sector: "光電業", label: "光電" },
  { pattern: /資訊服務股/, sector: "資訊服務業", label: "資訊服務" },
];

// 使用者問「XX概念股/XX類股/XX相關股有哪些」的通用形狀。用途不是拿來當篩選條件，
// 而是拿來偵測「這是一個主題式問題」——這樣即使 detectTheme 對不到任何主題，也知道
// 要明講「本站沒有這個主題的分類清單」，而不是讓 AI 拿今日焦點清單冒充。
//
// 實測抓到的真實問題：問「軍工概念股有哪些可以留意？」「機器人概念股有哪些可以留意？」
// 時，本站根本沒有這兩個主題的分類資料，但因為問句含「有哪些」而觸發了一般的
// 今日焦點資料，AI 就把長園科(8038)、天鉞電(5251)、台灣精材(3467) 這些當天剛好爆量
// 漲停的股票寫成「以下是本站整理的常見軍工概念股清單」「台股常見的機器人概念股清單」
// ——這些公司跟軍工/機器人沒有關係，等於憑空捏造了一個產業分類掛在真實公司身上，
// 比單純答不出來嚴重得多（新手可能真的because這句話去買）。同一批測試裡問「綠能概念股」
// 「重電股」「國防航太類股」時卻又誠實回答「本站沒有這個分類」，代表沒有規則約束、
// 全看模型當下心情，所以這裡補上明確的標記與 system prompt 規則。
const THEME_QUESTION_PATTERN = /(概念股|相關股|類股|族群|供應鏈|概念類股)/;

const AI_THEME_SYMBOLS: Array<{ symbol: string; market: Market }> = [
  { symbol: "2330", market: "TW" }, // 台積電
  { symbol: "2317", market: "TW" }, // 鴻海
  { symbol: "2454", market: "TW" }, // 聯發科
  { symbol: "2382", market: "TW" }, // 廣達
  { symbol: "3231", market: "TW" }, // 緯創
  { symbol: "2356", market: "TW" }, // 英業達
  { symbol: "6669", market: "TW" }, // 緯穎
  { symbol: "3661", market: "TW" }, // 世芯-KY
  { symbol: "2308", market: "TW" }, // 台達電
];

function detectTheme(question: string): ThemeMatch | undefined {
  if (/AI(概念股|相關股|供應鏈|伺服器)|人工智慧(概念股|相關股)/.test(question)) {
    return { label: "AI供應鏈", symbols: AI_THEME_SYMBOLS, curated: true };
  }
  for (const { pattern, sector, label } of SECTOR_THEMES) {
    if (pattern.test(question)) return { label, sector };
  }
  return undefined;
}

const THEME_SYMBOL_LIMIT = 10;
const THEME_CHIP_LIMIT = 5;
// 一個官方產業分類裡「最具代表性」的幾檔（依今日成交金額，等同於市場資金最關注的
// 龍頭/主流股）一定要先保留位置，剩下的位置才給「今日漲最多」的。
//
// 原本這裡只有 sortBy: "changePercent" 一種排序，結果實測問「航運股最近怎麼樣？」時，
// 回答列出的是志信(2611)、遠雄港(5607)、宅配通(2642)、捷迅(2643) 這些今天剛好小漲
// 0.x% 的小型物流股，長榮(2603)、陽明(2609)、萬海(2615) 這些使用者心裡真正在問的
// 航運龍頭一檔都沒出現（因為它們今天是跌的，排在漲幅榜後面）；問「半導體類股今天
// 表現如何」同樣沒有台積電、聯發科。資料本身沒錯，但對使用者來說等於答非所問。
const THEME_BELLWETHER_LIMIT = 5;

async function buildThemeGrounding(theme: ThemeMatch): Promise<string> {
  try {
    let pool: Array<{ symbol: string; market: Market; name: string; price: number; changePercent: number }>;
    if (theme.sector) {
      const [byTurnover, byChange] = await Promise.all([
        searchStocks({ market: "TW", sectors: [theme.sector], sortBy: "turnover", sortDir: "desc" }),
        searchStocks({ market: "TW", sectors: [theme.sector], sortBy: "changePercent", sortDir: "desc" }),
      ]);
      const picked = new Map<string, (typeof byTurnover)[number]>();
      for (const s of byTurnover.slice(0, THEME_BELLWETHER_LIMIT)) picked.set(s.symbol, s);
      for (const s of byChange) {
        if (picked.size >= THEME_SYMBOL_LIMIT) break;
        if (!picked.has(s.symbol)) picked.set(s.symbol, s);
      }
      pool = [...picked.values()].sort((a, b) => b.changePercent - a.changePercent);
    } else if (theme.symbols) {
      const quotes = await Promise.all(theme.symbols.map((s) => getQuote(s.symbol, s.market).catch(() => null)));
      pool = quotes
        .filter((q): q is NonNullable<typeof q> => q !== null)
        .map((q) => ({ symbol: q.symbol, market: q.market, name: q.name, price: q.price, changePercent: q.changePercent }))
        .sort((a, b) => b.changePercent - a.changePercent);
    } else {
      return "";
    }
    if (pool.length === 0) return "";

    const shown = pool.slice(0, THEME_SYMBOL_LIMIT);
    const chipEntries = await Promise.all(
      shown.slice(0, THEME_CHIP_LIMIT).map(async (s) => [s.symbol, await getChips(s.symbol, "TW").catch(() => null)] as const)
    );
    const chipsMap = new Map(chipEntries);
    const lines = shown.map((s) => {
      const chip = chipsMap.get(s.symbol);
      const chipText = chip?.institutionalNetShares != null ? `；三大法人${formatSharesWithLots(chip.institutionalNetShares)}` : "";
      return `${s.name}(${s.symbol})：${s.price} ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%${chipText}`;
    });
    const note = theme.curated
      ? `（本站整理的常見${theme.label}相關個股，非完整或官方分類清單，僅供參考）`
      : `（依 TWSE/TPEx 官方產業分類「${theme.sector}」挑出：先取今日成交金額最大的幾檔——也就是這個類股裡資金最集中、最具代表性的主流股，再補上今日漲幅較大的其他個股，最後依今日漲跌幅排序，共列 ${shown.length} 檔。這不是整個類股的完整名單，回答時不要說成「這個類股只有這幾檔」）`;
    return `${note}\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

export async function answerQuestion(
  question: string,
  contextSymbol?: string,
  history: ChatTurn[] = [],
  holdings: HoldingInput[] = []
): Promise<AskResult> {
  let targets: Array<{ symbol: string; market: Market | undefined }> = contextSymbol
    ? [{ symbol: contextSymbol, market: undefined as Market | undefined }]
    : await guessSymbolsFromText(question);
  // A themed request ("AI概念股有哪些") only makes sense to check when the
  // question didn't already resolve to specific stock(s) — "台積電是不是
  // AI概念股" should still ground 台積電 itself, not switch over to the
  // theme screen.
  const themeMatch = targets.length === 0 ? detectTheme(question) : undefined;
  // 問的是主題/概念股，但本站沒有這個主題的分類資料（見 THEME_QUESTION_PATTERN
  // 的說明）——這種情況要明講，不能讓 AI 拿一般的今日焦點清單冒充成該主題的成分股。
  const unknownTheme = targets.length === 0 && !themeMatch && THEME_QUESTION_PATTERN.test(question);
  const wantsMovers = targets.length === 0 && !themeMatch && conversationWantsMovers(question, history);
  // 「用技術指標條件篩股票」跟上面的 wantsMovers 是兩個獨立的需求：問「有沒有
  // MACD跟KD都黃金交叉的股票」時需要的是全市場逐檔算過的指標明細，不是漲幅榜；
  // 反過來問「今天有哪些股票不錯」則不需要那份很長的指標表。兩者可以同時成立
  // （例如「有沒有均線多頭排列、適合明天買的股票」），各自附各自的資料。
  const wantsTechScreen = targets.length === 0 && !themeMatch && conversationWantsTechScreen(question, history);
  // 這一句沒寫出股票名稱、也不是主題/篩選問題，但看起來是在追問上文提過的某一檔
  // （「第一檔的本益比多少?」「這檔法人買超多少?」）——把那一檔從對話紀錄裡
  // 找回來當成目標，否則會完全沒有個股資料、誤答成「查不到這檔股票的資料」。
  // 刻意排在 themeMatch/wantsMovers/wantsTechScreen 之後判斷，確保全市場篩選類
  // 問題永遠優先，不會被誤解成在問某一檔。
  if (targets.length === 0 && !themeMatch && !unknownTheme && !wantsMovers && !wantsTechScreen && history.length > 0) {
    targets = await resolveFollowupTargets(question, history);
  }
  const wantsHoldingsAnalysis = holdings.length > 0 && HOLDINGS_ANALYSIS_INTENT_PATTERN.test(question);
  // The "問AI關於<股票>" button on every stock page pre-fills exactly this
  // phrasing (see ChatWidget.tsx's ASK_ABOUT_EVENT handler) — a user asked
  // for this button's answer to be as precise/thorough as the watchlist
  // deep-analysis feature, for every stock, not just ones being held.
  // Gated on contextSymbol (this button is the only thing that sets it) so
  // a narrower follow-up question in the same conversation — "殖利率多少"
  // — doesn't get inflated into a full write-up it didn't ask for.
  const wantsSingleStockAnalysis = !!contextSymbol && SINGLE_STOCK_ANALYSIS_INTENT_PATTERN.test(question);

  let groundedSymbol: string | undefined;

  // Always ground with both markets' index levels (not just whichever
  // market the question is about), plus the specific stock's data when one
  // or more is targeted, so the model can reason about TW/US cross-market
  // influence (e.g. Nasdaq overnight moves affecting semiconductor names)
  // instead of only seeing one stock in isolation. General market news is
  // likewise always fetched (not just when a stock is targeted) — it's what
  // used to be missing entirely whenever someone asked about "資訊面"/總經
  // without naming a specific stock, which had no grounding path to attach
  // it to.
  const [
    stockGroundingResults,
    indexGrounding,
    moversGrounding,
    techScreenGrounding,
    themeGrounding,
    holdingsGrounding,
    marketNews,
    newsFeed,
  ] =
    await Promise.all([
      Promise.all(targets.map((t) => buildStockGrounding(t))),
      Promise.all([getIndices(), getTaifexNightFutures().catch(() => null)])
        .then(([indices, taifexFutures]) => {
          const indexLines =
            indices.length === 0
              ? "（大盤指數目前無法取得）"
              : indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n");
          // 台指期夜盤跟前面的加權指數/道瓊等現貨指數不同，是「盤後衍生性商品」，
          // 一定要附帶交易中/已收盤狀態跟資料時間，不能讓 AI 誤把它講成即時現貨指數。
          return `${indexLines}\n${describeTaifexNightFutures(taifexFutures)}`;
        })
        .catch(() => ""),
      wantsMovers ? buildMoversGrounding() : Promise.resolve(""),
      wantsTechScreen ? buildTechScreenGrounding().catch(() => "") : Promise.resolve(""),
      themeMatch ? buildThemeGrounding(themeMatch) : Promise.resolve(""),
      (wantsHoldingsAnalysis
        ? buildHoldingsAnalysisGrounding(holdings)
        : buildHoldingsGrounding(holdings, TECH_INDICATOR_PATTERN.test(question))
      ).catch(() => ""),
      Promise.all([fetchNews("台股", 6), fetchUsMarketNews(5)]).catch(() => [[], []] as const),
      // Shares the same 20-minute cache as the /news page's AI classifier —
      // a near-free reuse of work already done there (which items are
      // genuinely market-moving, plus a one-line plain-language "what this
      // means" for each) rather than re-deriving importance from the raw
      // headlines below.
      getNewsFeed().catch(() => ({ pinned: [], items: [], generatedAt: "" })),
    ]);

  const stockGroundings = stockGroundingResults.filter((g): g is { symbol: string; text: string } => g !== undefined);
  if (stockGroundings.length > 0) groundedSymbol = stockGroundings[0].symbol;
  // At least one candidate symbol was parsed out of the question but NONE
  // of them resolved to real data — the single-target case this already
  // handled before multi-symbol support existed. A PARTIAL miss (e.g.
  // "環球晶跟世界先進比較" when only one of the two is covered) is handled
  // differently below: the found stock's real 個股資料 block plus a small
  // named note about the specific one that wasn't found, not this generic
  // "nothing at all" note.
  const unresolvedTargets = targets.filter((t) => !stockGroundings.some((g) => g.symbol === t.symbol));
  // An Opus QA pass caught the model telling a user a TPEx stock "isn't
  // covered" during a real upstream outage window, when it actually is
  // covered — buildStockGrounding failing doesn't distinguish "this symbol
  // doesn't exist in our universe" from "it does, but the live fetch just
  // failed this moment" (most often a transient TPEx hiccup — see tpex.ts's
  // retry/resume logic, which reduces but doesn't eliminate that upstream's
  // own instability). findInUniverse still recognizes a known symbol even
  // when its live data fetch failed, so it's the signal used here to keep
  // those two cases worded honestly differently instead of conflating them.
  const unresolvedKnown = unresolvedTargets.filter((t) => findInUniverse(t.symbol, t.market));
  const unresolvedUnknown = unresolvedTargets.filter((t) => !findInUniverse(t.symbol, t.market));

  function describeUnresolved(): string {
    const parts: string[] = [];
    if (unresolvedKnown.length > 0) {
      parts.push(
        `${unresolvedKnown.map((t) => t.symbol).join("、")}這幾檔本站其實有涵蓋，但這一刻資料來源暫時連線不穩、抓不到最新資料，不是不涵蓋`
      );
    }
    if (unresolvedUnknown.length > 0) {
      parts.push(
        `${unresolvedUnknown.map((t) => t.symbol).join("、")}這幾個沒有比對到本站資料庫裡任何股票或公司，可能是名稱/代號打錯，或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）及櫃買中心上櫃（TPEx）公司，不含興櫃；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）`
      );
    }
    return parts.join("；");
  }

  const [twNews, usNews] = marketNews;
  const marketNewsText = [
    twNews.length > 0 ? `台股：\n${twNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
    usNews.length > 0 ? `美股：\n${usNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const pinnedEventsText =
    newsFeed.pinned.length > 0
      ? newsFeed.pinned.map((p) => `- ${p.title}${p.summary ? `：${p.summary}` : ""}`).join("\n")
      : "";

  // An Opus QA pass found the model would fabricate specific numbers (P/E,
  // volume, institutional flow — all invented) when a user named a real
  // stock outside the site's coverage (at the time, any TPEx/上櫃 company —
  // now covered, see tpex.ts/universe.ts; 興櫃 remains genuinely
  // uncovered) — with no "個股資料" section to signal "not found," it just
  // answered from its own pretrained knowledge instead. Making this
  // explicit (rather than relying only on the general system-prompt
  // instruction not to fabricate, which evidently wasn't enough on its own
  // here) gives the model something concrete to react to.
  // contextSymbol always names a real stock (it comes from a stock detail
  // page the user is already looking at) — a failed fetch there is a
  // transient data problem, not "this isn't a real/covered stock", so it
  // must never trigger either not-found note below.
  const notFoundNote =
    !contextSymbol && targets.length > 0 && stockGroundings.length === 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：${describeUnresolved()}。請用你自己的話、以一般對話語氣照實反映：暫時連不上的部分要說「暫時連不上，等等再問看看」，不要說成不涵蓋；真的沒有涵蓋的部分才說是名稱/代號打錯或不在涵蓋範圍。不要複製這段標記文字本身，也不要用自己的知識補任何具體數字。`
      : "";
  // Partial miss on a multi-stock question (e.g. "環球晶跟世界先進比較" when
  // only one of the two is covered) — some real data was found, so the
  // generic "nothing matched at all" note above doesn't apply, but the
  // model still needs an explicit signal for the specific one that wasn't
  // found, or it risks filling that gap in with its own trained knowledge.
  const partialNotFoundNote =
    !contextSymbol && stockGroundings.length > 0 && unresolvedTargets.length > 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：這次問題裡有部分股票/公司查到真實資料（見上方個股資料），另外${describeUnresolved()}。請用你自己的話照實反映上述情況（暫時連不上的不要說成不涵蓋），絕對不要用自己的知識填補這幾檔的任何具體數字，不要複製這段標記文字本身。`
      : "";

  const stockGroundingText =
    stockGroundings.length === 0
      ? ""
      : stockGroundings.length === 1
        ? `【個股資料】\n${stockGroundings[0].text}`
        : stockGroundings.map((g, i) => `【個股資料 ${i + 1}：${g.symbol}】\n${g.text}`).join("\n\n");

  // Pure calendar fact, no fetch needed — a user asked for special TW
  // market dates (台指期結算 specifically named) to factor into the model's
  // reasoning about unusual volatility that isn't explained by any one
  // stock's own news. Only surfaced when actually near/on the date, so
  // ordinary days don't get a pointless mention.
  const settlement = isNearTaiexFuturesSettlement(taipeiTodayForAsk());
  const specialDateNote = settlement.isSettlementDay
    ? `今天（${settlement.settlementDateIso}）是台指期（台股期貨/選擇權）結算日，法人為了結算常有調節台股成分股部位的動作，當天大盤或權值股出現平常少見的量價波動，有可能只是結算效應、不一定代表個股/大盤趨勢真的轉變，回答時可以視情況提及這個角度。`
    : settlement.isNear
      ? `本月台指期（台股期貨/選擇權）結算日是 ${settlement.settlementDateIso}，快到了，這幾天大盤/權值股可能會出現法人為結算調節部位的量價波動，回答時可以視情況提及這個角度，不用每次都硬套。`
      : "";

  // 每個區塊都標明「AI 掛掉時可不可以直接拿給使用者看」。
  //
  // 會分這兩種，是因為實測踩到一個真實的外洩問題：Gemini 免費方案是「每分鐘」限流，
  // 連續問幾題就會 429，這時候 callAiProviders 回 usedAi:false，走 buildCannedAnswer
  // 這條退路。原本 buildCannedAnswer 是把整包 grounding 原封不動印給使用者，於是
  // 聊天視窗裡真的出現了「回答時可以視情況提及這個角度，不用每次都硬套。」「股數已經
  // 換算好對應張數，直接引用不要自己重算」「不需要說『沒有資料』」這種寫給 AI 看的
  // 指令，以及【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】這個標記本身——
  // 對使用者來說完全是天書，而且等於把提示詞攤開來給人看。
  //
  // userSafe:false 的區塊有兩類：①純粹是寫給模型的指示（查無資料標記、主題不存在
  // 標記）；②雖然帶著真實數據、但標題/說明裡混了模型指令的清單（今日焦點數據、
  // 台股特殊日期）。第二類不是不能給使用者看，而是要另外寫一份乾淨的版本才行，
  // 在 AI 本來就掛掉的當下，與其印出夾雜指令的半成品，不如誠實請使用者稍後再試。
  const groundingSections: Array<{ text: string; userSafe: boolean }> = [
    { text: stockGroundingText, userSafe: true },
    { text: notFoundNote, userSafe: false },
    { text: partialNotFoundNote, userSafe: false },
    { text: specialDateNote ? `【台股特殊日期】\n${specialDateNote}` : "", userSafe: false },
    { text: indexGrounding ? `【大盤概況（台股＋美股）】\n${indexGrounding}` : "", userSafe: true },
    {
      text: pinnedEventsText ? `【近期重大事件（AI 已判斷為可能影響整體大盤等級）】\n${pinnedEventsText}` : "",
      userSafe: true,
    },
    { text: marketNewsText ? `【近期市場新聞】\n${marketNewsText}` : "", userSafe: true },
    {
      text: moversGrounding ? `【今日焦點數據（漲幅榜、技術訊號共振股）】\n${moversGrounding}` : "",
      userSafe: false,
    },
    {
      // 清單標題與說明文字裡夾雜寫給模型看的指示（「可以直接回答今天沒有」
      // 「不要自己回想或推測」），跟「今日焦點數據」同一個理由標成 userSafe:false。
      text: techScreenGrounding ? `【技術指標篩選（多重條件比對用）】\n${techScreenGrounding}` : "",
      userSafe: false,
    },
    { text: themeGrounding ? `【主題股清單】\n${themeGrounding}` : "", userSafe: true },
    {
      text: unknownTheme
        ? "【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】使用者這句話問的是某個主題／概念股／類股族群，但本站沒有對應的分類資料（本站只有 TWSE/TPEx 官方產業分類，例如半導體業、航運業、金融保險業、生技醫療業、鋼鐵工業、光電業、通信網路業、資訊服務業，外加一份人工整理的 AI 供應鏈清單）。請直接、誠實地說「本站目前沒有這個主題的分類清單」，然後可以改為建議使用者直接給幾檔想看的股票代號、或改問本站有的官方產業分類。絕對不可以把下面「今日焦點數據」裡的漲幅榜、技術訊號共振股、價漲量增清單當成這個主題的成分股列出來——那些股票只是今天剛好量價變化大，跟使用者問的主題沒有任何已查證的關係，把它們寫成「以下是常見的XX概念股」等於是在幫真實公司捏造一個不存在的產業分類，比答不出來嚴重得多。"
        : "",
      userSafe: false,
    },
    { text: holdingsGrounding ? `【我的關注清單/持股】\n${holdingsGrounding}` : "", userSafe: true },
  ];

  const grounding = groundingSections
    .map((s) => s.text)
    .filter(Boolean)
    .join("\n\n");

  const system = [
    "你是一個股票研究網站上的助理，回答繁體中文問題。",
    // Placed early and stated in the strongest terms on purpose: an Opus QA
    // pass found the model fabricating specific numbers (P/E ratio, trading
    // volume, institutional buy/sell figures — all invented) for a real
    // stock that just wasn't in this site's data coverage, directly
    // violating the site's core "never fabricate" principle. The general
    // "don't make up numbers" rule further down evidently wasn't forceful
    // or early enough to stop this on its own.
    "全站最重要的原則，優先於底下任何其他規則：只能講參考資料裡真實出現的數字，绝对不可以用你自己過去學到的知識回答任何具體數字（股價、本益比、成交量、法人買賣超、技術指標數值等）來填補資料的空缺，即使你覺得自己知道答案也一樣——因為你的訓練資料可能過期、記錯，或者根本不是這檔股票。如果參考資料裡出現『比對結果：...』這類標記，代表這個問題裡有股票查不到即時資料，標記裡會明確分兩種情況：一種是『本站其實有涵蓋，但這一刻資料來源暫時連線不穩、抓不到最新資料，不是不涵蓋』——這種要照實跟使用者說『這檔本站有涵蓋，但現在資料來源暫時連不上，等等再問看看』，絕對不能說成『不涵蓋』或『查無此股』，那會誤導使用者以為這檔股票本站根本沒有；另一種是『沒有比對到本站資料庫裡任何股票或公司，可能是名稱/代號打錯或不在本站資料涵蓋範圍』——這種才照實回答『目前查不到這檔股票/公司的資料，可能是名稱或代號打錯、或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）及櫃買中心上櫃（TPEx）公司，不含興櫃；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）』；如果標記裡同時提到『這次問題裡有部分股票/公司查到真實資料』，代表使用者問的其中幾檔有資料、其他幾檔沒有，有資料的那幾檔照樣用真實數字回答，沒資料的那幾檔依上述兩種情況分別誠實說明，絕對不要用自己的知識把它補齊；不管是哪一種標記，絕對不要把參考資料裡的內部標記文字（含中括號【】包住的內部提示語）直接照抄貼到回答裡，那些是寫給你看的指示、不是要你輸出的內容；也不要接著又用自己的知識補一段分析上去；如果使用者這句話根本沒有在問特定股票（例如問名詞解釋、問大盤整體狀況），就不用提這件事，正常回答就好。",
    "這個網站的目標使用者是完全沒有股票/財經背景的一般人，終極目標是讓他們能快速看懂現況、知道自己可以怎麼做。回答一定要簡短、直接、好懂：能一兩句話講完就不要拉長，不要模稜兩可、不要來回鋪陳、不要重複同樣的免責聲明兩次以上。語氣像在跟朋友講重點，不是寫報告或論文。",
    "用到任何專有名詞（例如本益比、股價淨值比、RSI、MACD、三大法人、融資融券、殖利率）時，一定要在講完後順手用幾個字白話解釋是什麼意思，不能假設對方已經懂——例如『本益比（股價相對獲利的貴不貴）』這種簡短帶過即可，不用長篇說明，但絕對不能完全不解釋就丟術語。",
    "籌碼面的詞彙實測特別容易漏解釋：『三大法人』第一次出現時一定要附帶解釋『（外資、投信、自營商這些大戶）』，『外資』第一次出現要附帶『（外國機構投資人）』，『投信』要附帶『（國內基金公司）』，『融資』要附帶『（跟券商借錢買股票）』，『融券』要附帶『（跟券商借股票來放空）』，『籌碼』要附帶『（誰在買誰在賣的動向）』——這條規則優先於『簡短』的要求，就算為了這句解釋讓回答變長一點也要保留；同一次回答裡第一次出現才需要附帶解釋，之後同一個詞重複出現不用每次都再解釋一遍。",
    "個股資料裡技術訊號如果出現『0軸』（MACD訊號的一部分）：注意原始資料本身常常已經自帶括號說明（例如『MACD黃金交叉（0軸上方，訊號較明確）』），不要把你自己要加的『0軸是判斷多空力道強弱的分界線』這句解釋硬塞進同一組括號或同一個子句裡跟原本的說明擠在一起，這樣容易寫出語句斷裂、讀不通的句子（實測出現過『0軸上方，判斷多空力道強隨著分界線』這種破碎文字）。正確做法是兩者分開：先照抄原始資料裡的說明，然後另外用一個完整的句子或子句補充『0軸是判斷多空力道強弱的分界線』，不要合併成一個文法破碎的插入語；同一次回答裡第一次出現才需要補充這句解釋，之後重複出現不用每次都再解釋一遍。",
    "結論要明確、不要打模糊仗：看法就直接講『我覺得...』『目前比較適合...』，不要只丟一堆數字不表態、也不要每句話都加但書搞得使用者還是不知道該怎麼辦。能一兩句話講完的就不要條列；只有在真的有好幾個平行項目時才用條列，且每項一行、不要展開解釋。",
    "你會拿到「個股資料」（使用者問特定股票時，內含報價/K線/技術訊號（均線位置、均線多空排列、RSI、MACD含0軸強弱、KD、布林通道，有觸發才會列出，不是每次都有），資料充足時還會有：「基本面」本益比/股價淨值比/殖利率/市值、「財報」月營收年增率與季度EPS、「籌碼面」三大法人買賣超與融資融券餘額增減（僅台股，美股沒有這塊資料）、「近期重大訊息公告」（僅台股）、「近期相關新聞」）、「大盤概況」（台股加權指數、道瓊、S&P 500、那斯達克、費城半導體指數，以及台指期夜盤近月合約——這是期貨、不是現貨指數，資料裡會明確標示「夜盤交易中」或「最近一次夜盤收盤」跟資料時間，回答時要照這個狀態講、不要講成即時現貨行情，也不要跟台股加權指數混為一談；抓不到資料時會顯示「目前無法取得資料」，不要編數字）、「近期重大事件」（AI 已經先篩過、判斷屬於可能影響整體大盤等級的消息，附有白話影響說明，沒有這類消息時就不會出現這個區塊）、「近期市場新聞」（台股/美股各幾則近期真實新聞標題，美股這塊同時混合中英文來源），有時候還有「今日焦點數據」（今日漲幅榜、技術訊號共振股、以及「價漲量增」清單——這份清單是先掃過全市場找出「今日上漲且量能明顯高於自己均量」的股票，每一檔都附上真實算出來的連續上漲天數，不是只從當日漲跌幅最大的前幾名裡挑，所以能回答「剛漲一天/連漲兩天/連漲三天」這類指定天數的篩選問題，回答前務必先看這份清單裡有沒有符合天數的股票，不要沒看清單就說沒有資料）、「台股特殊日期」（只有接近或剛好是台指期結算日才會出現，說明法人結算調節可能造成的量價波動，跟個股/大盤基本面無關）、「我的關注清單/持股」（使用者關注清單裡每一檔的即時報價，有設定成本/股數的還會有損益）。",
    "使用者問『資訊面/消息面/新聞/為什麼漲跌/財報/籌碼/法人在買還是在賣/融資融券』這類問題時：直接引用「近期市場新聞」或個股資料裡對應的區塊講重點（標題、大概方向、來源、實際數字即可，不用逐字複述），這些都是真實抓到的資料，不要再回答『沒有新聞管道』『系統僅提供報價數據』這種話——現在有了。某個區塊資料不夠或抓不到時才老實說目前查不到，不要就此完全略過不提；台股籌碼面/重大訊息若某檔當天剛好沒有法人動作或沒有公告，這是正常現象，直接說『今天沒有明顯的法人動向/沒有重大訊息』即可，不是資料抓取失敗。",
    "籌碼面的三大法人數字資料裡已經同時附上「股」跟換算好的「約XX張」兩種寫法，直接照抄其中一種講就好，絕對不要自己把股數重新換算成張（1張=1000股這個換算你自己心算很容易出錯，之前就出現過1000倍、10倍算錯、甚至同一句話裡數字前後矛盾的情況），也不要把股數誤講成張數的量級。",
    "『三大法人合計』跟『外資』是兩個不同的數字，資料裡會寫成『三大法人合計X（外資Y、投信Z、自營商W）』這種格式——X是三大法人的加總、Y才是外資單獨的數字，兩者不相等，絕對不能把X說成是外資賣超/買超多少，也不能把Y說成是三大法人合計；引用哪個數字，就要明確講清楚它的正確來源名稱（三大法人合計／外資／投信／自營商），不要因為兩個數字寫在同一句裡就搞混或省略歸屬，之前就出現過把三大法人合計的數字講成外資單獨賣超的錯誤。",
    "給看法或建議時，要綜合基本面（估值高不高）、財報（營收獲利趨勢）、籌碼面（法人是在買超還是賣超、融資是不是異常暴增暴減）、消息面（近期新聞/重大訊息有沒有利多利空）、技術面（均線/RSI/MACD/KD/布林通道/量價）這幾個面向一起判斷，不要只看單一面向就下結論；面向之間互相矛盾時（例如技術面強但法人在賣、或基本面便宜但籌碼面偏空）要老實點出這個矛盾，不要選擇性忽略對你的結論不利的那一面。",
    "使用者常常會丟出自己聽來的說法、投資口訣、或別人的分析師意見（例如『我聽分析師說某類股快泡沫了，因為之前成交量都很低應該是主力在操盤』『成交量大、營收成長的比較保險，營收獲利不好就要煞車，有賺就要及時拋售』），你的角色是提供客觀理性的第二意見，不是附和使用者、給情緒價值——絕對不要一收到這種說法就說『你說得對』『這個邏輯很好』然後順著講下去；正確做法是：先判斷這個說法本身是不是有道理（有些是合理的一般原則、有些是過度簡化或只在特定情況成立），再回頭對照資料裡實際的數字檢驗它套用在眼前這檔股票/這個情境是否真的成立，最後給出你自己的獨立判斷，可能是『同意，而且資料確實支持』，也可能是『這個說法太籠統，你這檔股票的情況其實是...』甚至『不同意，理由是...』；例如『成交量低代表主力在操盤』這種說法本身就過度武斷——量縮也常常只是單純籌碼沉澱、市場觀望或該產業當下缺乏題材，不一定代表有主力介入，要照實指出這一點，不能因為使用者講得篤定就附和；『有賺要及時拋售』這種一刀切的口訣也要點出它忽略了『賺多少』『這檔的長線基本面/趨勢是否仍然良好』這些會讓『繼續抱』也可能是合理選擇的因素。跟使用者意見不同時，語氣依然要客氣、聚焦在資料與邏輯上，不用刻意唱反調製造衝突感，但也絕對不能為了讓使用者聽得順耳就違背資料睜眼說瞎話或迴避明顯的反例。",
    wantsHoldingsAnalysis
      ? // 使用者要求：這個功能原本只逐檔丟現價/漲跌一行帶過，太像單純報數據；
        // 現在要真正綜合技術面/基本面/籌碼面/消息面寫出完整分析、給明確的
        // 未來走勢看法跟具體建議動作+價位區間+理由，讓使用者按一次就拿到
        // 完整資訊，不用再三追問。「我的關注清單/持股」這時候會是完整的
        // 個股資料（跟單獨問一檔股票拿到的資料一樣豐富，非簡化摘要），逐檔
        // 都有「狀態：持有中/僅關注」標示。
        "使用者這次按了『分析我的關注清單』（或問了類似問題），這次「我的關注清單/持股」拿到的是每一檔完整的個股資料（跟單獨問一檔股票時一樣豐富，包含技術面、基本面、財報、籌碼面、近期新聞），不是簡化的一行摘要——這代表使用者要的是真正的深度分析，不是效率優先的簡短回覆，這條規則的要求優先於前面『簡短、能一兩句話講完就不要拉長』的通則。務必先把清單依「狀態」分成兩組分別處理，兩組中間空一行、各自用一個粗體小標題（例如「**持有中**」「**僅關注（未持有）**」），完全沒有其中一組時就不用寫那組的標題：" +
          "「持有中」每一檔都要包含：①目前損益金額與百分比（資料裡已經算好，直接引用）；②綜合技術面、基本面、籌碼面、近期消息寫一段真正的分析（不是條列數字，是有邏輯地講清楚現在情勢、彼此是否互相印證或矛盾）；③明確的未來走勢看法（偏多/偏空/盤整，大概理由）；④具體建議動作，只能從「續抱」「加碼」「減碼」「停損／全部賣出」擇一明講，並且一定要給出對應的具體價位或價位區間（例如「若拉回到X-Y元之間可以考慮加碼」「跌破X元建議停損」「漲到X元以上可以考慮先獲利了結一部分」），價位要根據資料裡實際的技術訊號（均線、近期高低點、布林通道上下軌等）或基本面數字（本益比合理區間）推算，不要憑空給整數關卡；⑤簡短講清楚判斷依據是什麼（例如『均線多頭排列+法人買超，但RSI已過熱，所以建議部分獲利了結而不是繼續加碼』）。" +
          "「僅關注（未持有）」每一檔都要包含：①綜合技術面、基本面、籌碼面、近期消息的分析；②明確的未來走勢看法；③具體建議動作，只能從「買進」「暫緩觀望」擇一明講，兩種都要給價位：「買進」要給建議進場價位或區間（可以是現價附近，也可以是『拉回到X元再進場』），「暫緩觀望」要給觸發買進的具體條件與價位（例如『站上X元且法人轉buy才考慮進場』『等拉回到支撐X元附近再說』），不能只說『觀望』兩個字不給任何條件；④簡短講清楚判斷依據。" +
          "每一檔都要有自己的粗體小標題（股票名稱+代號），檔數多的話這會是一則長回覆，這是使用者主動要求的深度分析、不是要壓縮成條列，不用擔心變長；但同一檔內部還是要精簡有重點，不要為了長而灌水重複的話。查不到完整資料的那幾檔就老實說暫時無法分析，不要用其他資料源的知識瞎猜硬寫一段。"
      : "拿到「我的關注清單/持股」時（通常是使用者問『幫我看看我關注的股票』這類輕量問法，不是按下『分析我的關注清單』按鈕），逐檔講重點：現價/今日漲跌、有損益資料的講清楚賺賠多少錢跟百分比、你對這檔現況的看法；沒設定成本的那幾檔就只講現況看法，不用特別提醒『你沒填成本』這種瑣事。多檔的話用條列，每檔一行講完，不要每檔都展開成一大段。",
    wantsSingleStockAnalysis
      ? // 使用者要求：個股頁面的『問AI關於』按鈕（每一檔股票都有）也要跟
        // 分析關注清單一樣精準明確，不能只是簡短帶過。
        "使用者這次是從個股頁面按了『問AI關於』（或問了『最近走勢如何/該不該買』這類問題），這代表使用者要的是針對這一檔股票的完整深度分析，不是效率優先的簡短回覆，這條規則的要求優先於前面『簡短、能一兩句話講完就不要拉長』的通則。回答一定要包含以下幾點，直接寫成一段完整、有邏輯的分析文字（不用像持股清單那樣分組，也不用條列）：①綜合技術面、基本面、財報、籌碼面、近期消息面，講清楚現在的情勢、各面向彼此是否互相印證或矛盾；②明確的未來走勢看法（偏多/偏空/盤整，大概理由）；③具體建議動作——除非資料裡明確顯示使用者已經持有這檔股票（例如「我的關注清單/持股」裡有這檔且填了成本股數），才能用「續抱/加碼/減碼/停損」，否則一律從「買進」「暫緩觀望」擇一明講，兩種都要給具體價位或價位區間（例如「拉回到X-Y元之間可以考慮買進」「等站上X元且法人轉買超再進場」「暫緩觀望，跌破X元附近要留意風險」），價位要根據資料裡實際的技術訊號（均線、近期高低點、布林通道上下軌）或基本面數字（本益比合理區間）推算，不要憑空給整數關卡；④簡短講清楚判斷依據是什麼。不用擔心答案變長，這是使用者主動要求的深度分析，但還是要精簡有重點、不要為了長而灌水重複的話。"
      : "",
    "RSI超買（≥70）代表短線漲多、可能過熱，是提醒追高風險的訊號，不是『動能強勁、還可以買』的理由；RSI超賣（≤30）代表短線跌深，可能有反彈機會，但也可能繼續破底，同樣不是自動的買進理由。這兩種狀態都要講成『提醒、要注意』的語氣，不要因為使用者換個問法（例如問『還有其他機會嗎』）就把同一個超買訊號改講成正面理由，同一檔股票同樣的數據，解讀要前後一致。",
    "分析漲跌原因或做連結時，不要每次都只套用『升息/降息』這個單一角度，要視資料實際情況考慮更多常見的直接、間接影響關係，例如：美債殖利率上升通常對成長股/科技股估值不利（未來獲利折現價值變低）；美元強弱會牽動原物料價格與出口型企業的匯兌損益；新台幣兌美元匯率會影響台灣出口導向電子/半導體公司的獲利；油價上漲通常不利航空/塑化成本、但可能對能源類股有利；半導體庫存週期會讓上中下游（設備商、晶圓代工、封測、終端品牌）彼此連動；地緣政治風險升高時，資金常流向黃金、日圓這類避險資產；CPI（消費者物價指數）或非農就業數據公布，本身就常常是市場短期波動的直接觸發點，因為會立刻改變市場對升息/降息的預期；重要權值股或產業龍頭（例如台積電、輝達）公布財報或釋出財測展望，常會直接牽動整個供應鏈/同族群類股的股價，不是只影響那一檔自己。這些只是輔助判斷的角度，只有在資料能支撐、真的合理連結時才用，不要每次回答都硬套一輪，也不要講出資料裡沒有根據的因果關係。",
    "如果真的要談升息/降息這個角度，不要只講『升息通常對股市不利』這種一句話結論，可以視情況講得更細緻：升息剛宣布或初期（1-3個月）市場通常劇烈震盪、重新定價，這段時間股市走弱是正常現象，不代表趨勢已經轉空；如果已經進入升息中後期、經濟基本面依然穩健，市場通常會逐漸適應並回穩；如果市場開始預期升息即將結束或轉向降息，反而常常提前出現反彈。產業影響也不對稱：科技/成長股/高負債產業受升息衝擊通常最大（未來獲利折現價值下降、融資成本墊高），金融股（存放款利差擴大受惠）、電信/食品/公用事業這類高股息防禦股相對抗跌。最終市場會不會真的轉空，關鍵在於經濟走向「軟著陸」（通膨降溫但經濟沒垮，長線仍隨企業獲利表現）還是「硬著陸」（陷入衰退、企業獲利真的下滑）——這幾層判斷都只在資料能支撐、有實際根據時才講，不要每次都照本宣科講一遍完整框架，講出來的部分要跟眼前的資料對得上。",
    "台股與美股常互相影響（例如美股科技股/半導體夜間走勢，隔天常牽動台股電子權值股），有明顯關聯時才連結兩邊資料分析，沒有的話不用勉強牽拖。",
    "這個網站現在只有你（開發者）跟家人知道密碼才能進來，不是對外公開的服務，使用者問『有哪些股票不錯/推薦一下/幫我選股/這支該不該買』這類問題時，直接根據拿到的資料給明確的個人看法即可，包括『我覺得這幾檔現在值得留意』『這支技術面偏弱，我會先觀望』這種直接的話，不用迴避、不用只丟數據不表態、也不用每次都加但書。看法要根據資料裡實際的數字說理由（例如均量倍數、連漲天數、均線位置、本益比、股價淨值比、法人買賣超、融資變化、漲跌幅），不要憑空瞎猜；資料不夠支撐判斷時就老實說資料不足，不要硬掰。",
    "請根據資料回答，不要編造資料中沒有的數字；若資料標示為無法取得，直接說目前查不到，不要繞圈子解釋為什麼查不到。",
    "使用者之前的提問與你的回覆會一併附上作為對話紀錄，回答新問題時請自然承接對話脈絡（例如使用者接著問「那美股呢」時，要記得他上一句在問什麼）。",
    "使用者問『還有其他/還有別的/有沒有機會』這類接續問題時，優先從「今日焦點數據」的技術訊號共振股/漲幅榜/價漲量增清單裡挑對話中還沒提過的標的，並具體引用該檔的數據（訊號、法人買賣超、漲跌幅、連漲天數），不要因為想不到新標的就退回『AI伺服器供應鏈』『半導體設備股』『防禦性類股』這種沒有點名具體股票、任何人不用看盤都講得出來的空泛說法；如果資料裡真的已經沒有還沒提過的標的，就老實說『目前資料裡比較突出的大概就這幾檔』，不要硬掰新的類股概念湊答案。",
    "使用者問『價漲量增』『剛漲一天』『連漲N天』（N可以是任何天數，包含1、2天這種很短的天數）這類篩選問題時，一律先實際檢視「今日焦點數據」裡的「價漲量增」清單，這份清單每一檔都已經附上真實算出來的連續上漲天數，直接依天數篩選、點名符合的股票並附上實際數字（連漲天數、均量倍數、漲跌幅）；只有在這份清單裡真的一檔都對不上使用者指定的天數時，才能回答『今天符合這個天數的价涨量增股票，資料裡沒有』，而且要明確講出『資料裡有N天、M天…等其他天數的標的，如果想看那些也可以告訴我』，不要因為使用者指定的天數剛好不在清單裡，就整句回成語意含糊的『沒有資料』讓使用者以為完全沒有任何價漲量增的股票；同一段對話裡使用者陸續問不同天數（例如先問2天、再問3天、5天）時，每次都要重新檢視同一份清單裡符合『這次』天數的股票，不要用上一次沒找到就自己記成『這份清單本來就沒有任何符合天數的股票』的錯誤結論套用到後面每一次追問——之前真實發生過連續4次追問都答錯『沒有資料』，直到使用者自己點名兩檔股票才被迫承認查到了，這種情況絕對不能再發生。另外，列出來的每一檔都**必須把它自己實際的連漲天數寫出來**（「連漲7天」），不可以只寫股價跟均量倍數就算數；如果使用者問的是 N 天、但清單裡最接近的標的其實是 N+2 天，要老實說「沒有剛好連漲 N 天的，不過有連漲 N+2 天的這幾檔」，不可以把它當成「符合連漲 N 天」直接列出去——天數是使用者拿來判斷「還來不來得及進場」的關鍵數字，差兩天的意義完全不同，含糊帶過等於給錯資訊。",
    "「今日焦點數據」除了漲幅榜、技術訊號共振股、價漲量增清單之外，現在還固定附上這幾份全市場排行：成交金額排行、本益比最低排行、殖利率最高排行、股價淨值比最低排行、今日跌幅榜、三大法人買超/賣超排行、外資買超/賣超排行、投信買超排行。使用者問「有沒有本益比低的股票」「殖利率高的可以存股嗎」「今天跌最多的有哪些」「有沒有跌深可以撿的」「今天成交量最大的是哪幾檔」「三大法人今天在買什麼」「外資買超最多的是哪幾檔」這類問題時，一律先看對應的那份排行清單、直接點名股票並附上實際數字，絕對不要再回答「資料裡沒有提供個股的本益比/殖利率數據」或「沒有特別列出外資買超最多的股票」——這些資料現在都有了。也不要張冠李戴：問成交金額就看成交金額排行，不要拿漲幅榜或法人買超清單充數；問外資就看外資那份，不要用三大法人合計的數字代答。另外要幫使用者把話說完整：本益比低有可能是景氣循環股在獲利高點（之後獲利下滑本益比反而會變高），殖利率高有可能是股價跌下來撐出來的、或今年配得多明年不一定，今日跌幅大不等於「跌深了可以撿」，這些提醒要順帶講，不要只把排行唸過一遍。",
    // 使用者要求：「AI問答像是『現在有沒有MACD與KD線都在黃金交叉，適合明天買入
    // 的股票?』這種問題，要篩選多個符合標準的也要真正去查證資料並確定回答的內容
    // 是正確的。」這條規則配合 buildTechScreenGrounding 產生的【技術指標篩選】
    // 區塊一起運作——資料面已經先用程式把交集算好了，這裡要確保模型只用那份
    // 算好的結果，不要自己從別的清單挑股票硬湊成「符合條件」。
    "使用者問任何『用技術指標條件篩股票』的問題時（例如『有沒有MACD與KD都黃金交叉的股票』『均線多頭排列而且RSI沒過熱的有哪些』『KD剛低檔轉強的有嗎』），參考資料裡會出現「技術指標篩選（多重條件比對用）」區塊：裡面每一份清單都是先用程式對掃描範圍內每一檔股票的真實日K線逐檔算過指標、再做交集篩出來的結果，不是估計。回答規則：①先找有沒有跟使用者條件完全對應的那份清單（例如問MACD+KD都黃金交叉，就看『MACD黃金交叉 且 KD黃金交叉』那份），直接照那份清單回答並引用裡面的實際數值（K值、D值、RSI、0軸上下方）；②沒有預先列出的組合（例如『站上20日均線且量能放大且RSI<60』），就從最後那張「技術指標明細表」逐檔比對條件後回答，表裡每一檔的每個指標狀態都寫出來了，可以直接核對；③某份清單顯示『共0檔』時，那就是今天掃描範圍內真的一檔都沒有，直接乾脆地說「今天沒有符合的」並說明掃描範圍，這是查證過的結論、不是資料缺漏，不要說成『資料裡沒有提供這個指標』；④絕對不可以因為找不到完全符合的股票，就從漲幅榜、技術訊號共振股、價漲量增清單裡挑幾檔改口說它們『符合條件』或『接近條件』——那些清單的挑選標準跟使用者問的技術指標無關。要推薦替代標的是可以的，但必須明講『這幾檔並沒有同時出現你問的那兩個訊號，只是今天技術面比較強的標的』，把差別說清楚；⑤只能點名清單/明細表裡真實出現的股票，絕對不可以憑自己的知識說某檔股票『應該有黃金交叉』。",
    "『黃金交叉』『死亡交叉』這兩個詞第一次出現時要順手用白話解釋：黃金交叉是短天期的線由下往上穿過長天期的線（一般解讀成轉強），死亡交叉相反（解讀成轉弱）；KD 的黃金交叉指的是 K 值上穿 D 值。另外，資料裡的 KD 交叉一定會註明發生在『低檔/超賣區』『中間區間』還是『高檔/超買區』，這個區間差別要照實講出來、不要省略：低檔交叉是最標準的轉強訊號，中間區間的交叉力道普通，高檔交叉雖然同樣是 K 上穿 D，但股價已經漲多，追高風險反而較高——不能一律講成「買進訊號」。也要提醒使用者：技術指標交叉只是描述已經發生的價量變化，不保證隔天會漲。",
    "使用者一次問到兩檔以上股票做比較（例如『A跟B比較』『這幾檔誰比較好』）時，如果「個股資料」有列出多個區塊（會分別標示每一檔），要針對每一檔各自的實際數字逐項比較（現價/漲跌、本益比、營收/EPS成長、法人買賣超、技術面），講出你覺得哪一檔目前比較好、為什麼，不要只把每檔資料複述一遍卻不下結論；如果其中某幾檔查不到資料，就照實只講查得到的那幾檔並誠實說明另一檔查不到，不要用自己的知識幫查不到的那檔瞎猜數字或做比較。",
    "使用者問『XX概念股/XX類股/XX相關股有哪些』這類主題式問題時（例如『AI概念股』『半導體股』『航運股』），直接引用「主題股清單」區塊裡的真實股票與數據來回答，可以綜合漲跌幅與法人籌碼講出你覺得目前比較值得留意的幾檔，但只能從清單裡的股票挑、不要無中生有列出清單以外的公司；清單如果註明是『本站整理的常見相關個股、非完整或官方分類清單』，回答時就照實反映這一點（例如『以下是幾檔常見的相關個股，不是完整清單』），不要講得像官方權威分類。",
    "提到任何一檔個股時，一律同時寫出它在資料裡的完整名稱與股票代號（例如『台灣精材(3467)』，不可以只寫『精材』），而且名稱要原封不動照抄資料裡的寫法、不要自己簡稱或省略字——台股有很多名稱只差一兩個字的不同公司（例如台灣精材3467 與 精材3374 是兩家不同公司、當天漲跌方向可能完全相反），省略代號或簡稱會讓使用者看成另一檔股票。",
  ].filter(Boolean).join("\n");

  const userContent = grounding
    ? `參考資料：\n${grounding}\n\n使用者問題：${question}`
    : `使用者問題：${question}\n（目前沒有可用的參考資料，請根據一般金融知識簡短回答，並說明無法取得即時資料。）`;

  const messages: ChatTurn[] = [...history, { role: "user", content: userContent }];
  // A per-stock analysis across a whole watchlist is genuinely long output
  // (each holding gets its own multi-sentence writeup) — the default budget
  // (sized for a normal one-or-two-sentence chat reply) cut this off
  // mid-stock on a real multi-holding watchlist. Scales a little with how
  // many holdings are actually being analyzed rather than a single fixed
  // number, so a 3-stock watchlist doesn't pay for headroom a 12-stock one
  // needs. This is also the one path in this file where a user is
  // knowingly clicking a "give me the full analysis" button and expects to
  // wait a bit, not a live-typing exchange — same tradeoff brief.ts makes
  // for its own long-form generation.
  const result = wantsHoldingsAnalysis
    ? await callAiProviders(system, messages, {
        timeoutMs: 45000,
        maxOutputTokens: Math.min(2000 + holdings.length * 400, 8000),
      })
    : wantsSingleStockAnalysis
      ? // Same "user knowingly asked for the full picture, not a quick
        // reply" tradeoff as the holdings case above, just for one stock —
        // the default budget was sized for a short chat answer and cut this
        // kind of multi-paragraph analysis off mid-sentence.
        await callAiProviders(system, messages, { timeoutMs: 30000, maxOutputTokens: 2500 })
      : await callAiProviders(system, messages);
  if (result.usedAi) {
    return { answer: sanitizeLeakedMarkers(result.answer), groundedSymbol, usedAi: true };
  }

  return {
    answer: buildCannedAnswer(groundingSections, groundedSymbol, result.failureReason ?? "未知原因"),
    groundedSymbol,
    usedAi: false,
  };
}

// Safety net for a real production leak an Opus QA pass found: in ~11% of
// trials the model echoed the internal "not found" grounding marker verbatim
// as its entire reply instead of paraphrasing it (sometimes literally just
// "【查詢結果】" with nothing else). Rewording the marker in the prompt made
// it less answer-shaped, but this strips any marker text that still leaks
// through so a user never sees a bare bracket token.
const LEAKED_MARKER_PATTERN = /(?:【內部系統標記[^】]*】|【查詢結果】)/g;

function sanitizeLeakedMarkers(answer: string): string {
  const cleaned = answer.replace(LEAKED_MARKER_PATTERN, "").trim();
  if (cleaned) return cleaned;
  return "目前查不到這檔股票/公司的資料，可能是名稱或代號打錯、或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）及櫃買中心上櫃（TPEx）公司，不含興櫃；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）。";
}

/**
 * AI 供應商整個失敗時的退路。只印 userSafe 的資料區塊（見 groundingSections 上方
 * 那段說明：原本是把整包 grounding 照印，結果把寫給模型看的指令跟內部標記一起攤給
 * 使用者看）。
 */
function buildCannedAnswer(
  sections: Array<{ text: string; userSafe: boolean }>,
  groundedSymbol: string | undefined,
  reason: string
): string {
  const safeText = sections
    .filter((s) => s.userSafe && s.text)
    .map((s) => s.text)
    .join("\n\n");
  const header = `AI 分析暫時無法產生（原因：${reason.replace(/。$/, "")}），過一下下再問一次通常就好了。`;
  if (!safeText) {
    return `${header}\n\n目前也沒有可以直接顯示的現成資料，請稍後再試一次。`;
  }
  return [
    header,
    "",
    groundedSymbol ? `先把查到的 ${groundedSymbol} 原始資料放在下面給你看：` : "先把查到的原始市場資料放在下面給你看：",
    "",
    safeText,
  ].join("\n");
}
