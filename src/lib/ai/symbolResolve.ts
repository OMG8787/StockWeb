import { findAllSymbolsByName, getTwUniverse } from "@/lib/data";
import type { Market } from "@/lib/data";

// The negative lookahead keeps a plain year mention ("2025年台股展望") from
// being read as TW stock code 2025 (千興) — TWSE codes are 4-6 digits with
// no reserved range, so any bare number in that span is otherwise ambiguous
// with a year, and "20XX年" is by far the most common way one shows up in a
// question that isn't about a specific stock at all.
const SYMBOL_PATTERN = /\b\d{4,6}\b(?!\s*年)|\b[A-Z]{1,5}\b/g;

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

export async function guessSymbolsFromText(text: string): Promise<{ symbol: string; market: Market }[]> {
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
