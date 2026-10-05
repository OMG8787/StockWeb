import { findAllSymbolsByName, ensureTwUniverseWarm, findInUniverse, twCompaniesByPopularity } from "@/lib/data";
import type { UniverseEntry } from "@/lib/data";
import { guessByFuzzyName, type FuzzyNameGuess } from "./fuzzyName";
import type { Market } from "@/lib/data";

// The negative lookahead keeps a plain year mention ("2025年台股展望") from
// being read as TW stock code 2025 (千興) — TWSE codes are 4-6 digits with
// no reserved range, so any bare number in that span is otherwise ambiguous
// with a year, and "20XX年" is by far the most common way one shows up in a
// question that isn't about a specific stock at all.
// 美股代號至少要2個字母才算數（原本是1~5個）。2026-09-22 Opus驗證時意外測到：
// 訊息編碼錯誤送出的亂碼文字裡，任何孤立的大寫英文字母（例如亂碼剛好夾雜一個
// 「S」）都會被這個正則式當成一檔真實美股代號（S=SentinelOne、O=Realty Income
// 等），讓AI一本正經地分析一檔完全不相關的股票。真人在中文語境裡打字，幾乎
// 不會單獨打一個孤立大寫字母來指名股票（想問Visa/Ford會直接打公司名稱，
// 名稱比對走另一條路徑`findAllSymbolsByName`，不受這裡影響）；代價是T/F/V/C/D/O
// 這幾檔本來就有的真實單字母代號，改成只能用公司名稱查、不能只打裸代號，
// 這個犧牲遠比「亂碼/雜訊文字誤觸發分析無關股票」的風險划算。
const SYMBOL_PATTERN = /\b\d{4,6}\b(?!\s*年)|\b[A-Z]{2,5}\b/g;

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

// A comparison question ("台積電跟聯發科比較"、"2330和2454哪個好") names more
// than one company at once — capped at 4 so a rambling question naming half
// the market doesn't turn into 4+ parallel buildStockGrounding() calls each
// firing their own quote/chart/fundamentals/news fetches.
const MAX_COMPARE_TARGETS = 4;

/**
 * opts.max：最多回幾檔（預設 MAX_COMPARE_TARGETS）；「這幾檔」指代上一則 AI 列的清單時會放寬到 8。
 * opts.knownOnly：只留本站股票清單查得到的（AI 回答裡常有價格、張數等 4 位數字，會被當成代號）。
 */
export async function guessSymbolsFromText(
  text: string,
  opts: { max?: number; knownOnly?: boolean } = {}
): Promise<{ symbol: string; market: Market }[]> {
  const max = opts.max ?? MAX_COMPARE_TARGETS;
  // findSymbolByName/findAllSymbolsByName 讀的模組層級快照要 warm 過才完整
  // （見 ensureTwUniverseWarm() 的完整說明）。這裡跟 lib/data/quote.ts 的
  // getQuote() 各自獨立呼叫一次同一個 warm 函式——**不是多餘的重複，兩處都要
  // 保留**：這裡 warm 的時機比 getQuote() 更早（問句一進來、還沒解析出任何
  // 股票代號、getQuote() 根本還沒被呼叫過），純聊天問句如果只靠 getQuote()
  // 那份 warm，會漏掉「先解析代號」這一步本身也依賴同一份快照的情況。
  // ensureTwUniverseWarm() 內部是 Redis 快取，非冷啟動時這裡是免費的快取
  // 命中，兩處都呼叫沒有效能疑慮。2026-09-22 地毯式審計時特別留這段說明，
  // 避免以後有人「清理重複程式碼」時誤刪其中一處，重新製造出同一類bug。
  await ensureTwUniverseWarm();

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

  for (const entry of findAllSymbolsByName(text, max * 2)) {
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
        /^[A-Z]{2,5}$/.test(m) &&
        !matchedNameSubstrings.some((name) => name.includes(m.toLowerCase()))
      ) {
        seen.add(m);
        candidates.push({ symbol: m, market: "US", index: upper.indexOf(m) });
      }
    }
  }

  return candidates
    .filter((c) => !opts.knownOnly || !!findInUniverse(c.symbol, c.market))
    .sort((a, b) => a.index - b.index)
    .slice(0, max)
    .map(({ symbol, market }) => ({ symbol, market }));
}

/**
 * 完全比對不到任何股票時，用問句開頭的主詞做台股名稱近似比對（錯字，例如「建鼎」→ 健鼎 3044）。
 * 見 fuzzyName.ts 的誤判防線；呼叫端（ask.ts）只在沒有任何其他目標／篩選意圖時才呼叫。
 */
export async function guessSymbolByFuzzyName(question: string): Promise<FuzzyNameGuess<UniverseEntry> | null> {
  await ensureTwUniverseWarm();
  return guessByFuzzyName(question, twCompaniesByPopularity());
}
