import { peekCached, writeCached } from "./cache";
import type { Market } from "./types";

export interface UniverseEntry {
  symbol: string;
  market: Market;
  name: string;
  sector: string;
  currency: string;
  /**
   * Internal routing detail for TW entries only — which board this stock
   * actually trades on, used by lib/data/index.ts to pick the right
   * per-symbol fetch (TWSE 上市 vs TPEx 上櫃 vs Emerging 興櫃). Not part of
   * the public Market contract ("TW" | "US" stays as-is everywhere outside
   * this internal routing). Absent/undefined is treated as "TWSE" so every
   * pre-existing seed/US entry needs no changes.
   */
  exchange?: "TWSE" | "TPEx" | "Emerging";
}

// Small hand-curated seed list. Used as the TW universe until the full
// official listing (see getTwUniverse below) has been fetched at least
// once, and as a safety net if that fetch ever fails outright — search,
// rankings, and name lookups keep working with a smaller-but-real set of
// stocks instead of breaking or falling back to made-up data.
const TW_UNIVERSE_SEED: UniverseEntry[] = [
  { symbol: "2330", market: "TW", name: "台積電", sector: "半導體", currency: "TWD" },
  { symbol: "2317", market: "TW", name: "鴻海", sector: "電子零組件", currency: "TWD" },
  { symbol: "2454", market: "TW", name: "聯發科", sector: "半導體", currency: "TWD" },
  { symbol: "2308", market: "TW", name: "台達電", sector: "電子零組件", currency: "TWD" },
  { symbol: "2382", market: "TW", name: "廣達", sector: "電腦及週邊設備", currency: "TWD" },
  { symbol: "2412", market: "TW", name: "中華電", sector: "電信服務", currency: "TWD" },
  { symbol: "2881", market: "TW", name: "富邦金", sector: "金融保險", currency: "TWD" },
  { symbol: "2882", market: "TW", name: "國泰金", sector: "金融保險", currency: "TWD" },
  { symbol: "2886", market: "TW", name: "兆豐金", sector: "金融保險", currency: "TWD" },
  { symbol: "2891", market: "TW", name: "中信金", sector: "金融保險", currency: "TWD" },
  { symbol: "1301", market: "TW", name: "台塑", sector: "塑膠工業", currency: "TWD" },
  { symbol: "1303", market: "TW", name: "南亞", sector: "塑膠工業", currency: "TWD" },
  { symbol: "2002", market: "TW", name: "中鋼", sector: "鋼鐵工業", currency: "TWD" },
  { symbol: "2603", market: "TW", name: "長榮", sector: "航運業", currency: "TWD" },
  { symbol: "2609", market: "TW", name: "陽明", sector: "航運業", currency: "TWD" },
  { symbol: "3008", market: "TW", name: "大立光", sector: "光學元件", currency: "TWD" },
  { symbol: "3711", market: "TW", name: "日月光投控", sector: "半導體", currency: "TWD" },
  { symbol: "2379", market: "TW", name: "瑞昱", sector: "半導體", currency: "TWD" },
  { symbol: "2357", market: "TW", name: "華碩", sector: "電腦及週邊設備", currency: "TWD" },
  { symbol: "2395", market: "TW", name: "研華", sector: "電腦及週邊設備", currency: "TWD" },
  { symbol: "1216", market: "TW", name: "統一", sector: "食品工業", currency: "TWD" },
  { symbol: "2801", market: "TW", name: "彰銀", sector: "金融保險", currency: "TWD" },
  { symbol: "5880", market: "TW", name: "合庫金", sector: "金融保險", currency: "TWD" },
  { symbol: "3034", market: "TW", name: "聯詠", sector: "半導體", currency: "TWD" },
  { symbol: "2303", market: "TW", name: "聯電", sector: "半導體", currency: "TWD" },
  { symbol: "2884", market: "TW", name: "玉山金", sector: "金融保險", currency: "TWD" },
  { symbol: "2885", market: "TW", name: "元大金", sector: "金融保險", currency: "TWD" },
  { symbol: "2892", market: "TW", name: "第一金", sector: "金融保險", currency: "TWD" },
  { symbol: "2880", market: "TW", name: "華南金", sector: "金融保險", currency: "TWD" },
  { symbol: "2887", market: "TW", name: "台新金", sector: "金融保險", currency: "TWD" },
  { symbol: "2890", market: "TW", name: "永豐金", sector: "金融保險", currency: "TWD" },
  { symbol: "3045", market: "TW", name: "台灣大", sector: "電信服務", currency: "TWD" },
  { symbol: "4904", market: "TW", name: "遠傳", sector: "電信服務", currency: "TWD" },
  { symbol: "2912", market: "TW", name: "統一超", sector: "貿易百貨", currency: "TWD" },
  { symbol: "2903", market: "TW", name: "遠百", sector: "貿易百貨", currency: "TWD" },
  { symbol: "4938", market: "TW", name: "和碩", sector: "電腦及週邊設備", currency: "TWD" },
  { symbol: "3231", market: "TW", name: "緯創", sector: "電腦及週邊設備", currency: "TWD" },
  { symbol: "2354", market: "TW", name: "鴻準", sector: "電子零組件", currency: "TWD" },
  { symbol: "6505", market: "TW", name: "台塑化", sector: "油電燃氣", currency: "TWD" },
  { symbol: "5871", market: "TW", name: "中租-KY", sector: "其他", currency: "TWD" },
  { symbol: "1504", market: "TW", name: "東元", sector: "電機機械", currency: "TWD" },
  { symbol: "1717", market: "TW", name: "長興", sector: "化學工業", currency: "TWD" },
  { symbol: "2707", market: "TW", name: "晶華", sector: "觀光事業", currency: "TWD" },
  { symbol: "6446", market: "TW", name: "藥華藥", sector: "生技醫療", currency: "TWD" },
];

// No single free, reliable "full US market" listing endpoint exists without
// an API key/paid data provider, so this is a large hand-curated set of
// well-known, high-confidence large-cap tickers spanning every major GICS
// sector — a big step up from a 20-stock demo list, not a claim of covering
// every US-listed ticker. A stale or since-delisted entry here degrades
// safely: the live quote fetch for it simply fails and it's omitted from
// results (see lib/data/index.ts), it never produces fabricated data.
export const US_UNIVERSE: UniverseEntry[] = [
  // Technology
  { symbol: "AAPL", market: "US", name: "Apple Inc.", sector: "Technology", currency: "USD" },
  { symbol: "MSFT", market: "US", name: "Microsoft Corp.", sector: "Technology", currency: "USD" },
  { symbol: "NVDA", market: "US", name: "NVIDIA Corp.", sector: "Technology", currency: "USD" },
  { symbol: "AVGO", market: "US", name: "Broadcom Inc.", sector: "Technology", currency: "USD" },
  { symbol: "ORCL", market: "US", name: "Oracle Corp.", sector: "Technology", currency: "USD" },
  { symbol: "ADBE", market: "US", name: "Adobe Inc.", sector: "Technology", currency: "USD" },
  { symbol: "CRM", market: "US", name: "Salesforce Inc.", sector: "Technology", currency: "USD" },
  { symbol: "CSCO", market: "US", name: "Cisco Systems Inc.", sector: "Technology", currency: "USD" },
  { symbol: "ACN", market: "US", name: "Accenture plc", sector: "Technology", currency: "USD" },
  { symbol: "IBM", market: "US", name: "International Business Machines", sector: "Technology", currency: "USD" },
  { symbol: "INTU", market: "US", name: "Intuit Inc.", sector: "Technology", currency: "USD" },
  { symbol: "NOW", market: "US", name: "ServiceNow Inc.", sector: "Technology", currency: "USD" },
  { symbol: "AMD", market: "US", name: "Advanced Micro Devices", sector: "Technology", currency: "USD" },
  { symbol: "TXN", market: "US", name: "Texas Instruments", sector: "Technology", currency: "USD" },
  { symbol: "QCOM", market: "US", name: "Qualcomm Inc.", sector: "Technology", currency: "USD" },
  { symbol: "AMAT", market: "US", name: "Applied Materials", sector: "Technology", currency: "USD" },
  { symbol: "MU", market: "US", name: "Micron Technology", sector: "Technology", currency: "USD" },
  { symbol: "LRCX", market: "US", name: "Lam Research Corp.", sector: "Technology", currency: "USD" },
  { symbol: "KLAC", market: "US", name: "KLA Corp.", sector: "Technology", currency: "USD" },
  { symbol: "PANW", market: "US", name: "Palo Alto Networks", sector: "Technology", currency: "USD" },
  { symbol: "SNPS", market: "US", name: "Synopsys Inc.", sector: "Technology", currency: "USD" },
  { symbol: "CDNS", market: "US", name: "Cadence Design Systems", sector: "Technology", currency: "USD" },
  { symbol: "ADI", market: "US", name: "Analog Devices", sector: "Technology", currency: "USD" },
  { symbol: "INTC", market: "US", name: "Intel Corp.", sector: "Technology", currency: "USD" },
  { symbol: "DELL", market: "US", name: "Dell Technologies", sector: "Technology", currency: "USD" },
  { symbol: "HPQ", market: "US", name: "HP Inc.", sector: "Technology", currency: "USD" },
  { symbol: "UBER", market: "US", name: "Uber Technologies", sector: "Technology", currency: "USD" },
  { symbol: "ABNB", market: "US", name: "Airbnb Inc.", sector: "Technology", currency: "USD" },
  { symbol: "TSM", market: "US", name: "Taiwan Semiconductor ADR", sector: "Technology", currency: "USD" },
  { symbol: "CRWD", market: "US", name: "CrowdStrike Holdings", sector: "Technology", currency: "USD" },
  { symbol: "NET", market: "US", name: "Cloudflare Inc.", sector: "Technology", currency: "USD" },
  { symbol: "DDOG", market: "US", name: "Datadog Inc.", sector: "Technology", currency: "USD" },
  { symbol: "SNOW", market: "US", name: "Snowflake Inc.", sector: "Technology", currency: "USD" },
  { symbol: "MRVL", market: "US", name: "Marvell Technology", sector: "Technology", currency: "USD" },
  { symbol: "ON", market: "US", name: "ON Semiconductor Corp.", sector: "Technology", currency: "USD" },
  { symbol: "FTNT", market: "US", name: "Fortinet Inc.", sector: "Technology", currency: "USD" },
  { symbol: "WDAY", market: "US", name: "Workday Inc.", sector: "Technology", currency: "USD" },
  { symbol: "TEAM", market: "US", name: "Atlassian Corp.", sector: "Technology", currency: "USD" },

  // Communication Services
  { symbol: "GOOGL", market: "US", name: "Alphabet Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "META", market: "US", name: "Meta Platforms Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "NFLX", market: "US", name: "Netflix Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "DIS", market: "US", name: "Walt Disney Co.", sector: "Communication Services", currency: "USD" },
  { symbol: "CMCSA", market: "US", name: "Comcast Corp.", sector: "Communication Services", currency: "USD" },
  { symbol: "T", market: "US", name: "AT&T Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "VZ", market: "US", name: "Verizon Communications", sector: "Communication Services", currency: "USD" },
  { symbol: "TMUS", market: "US", name: "T-Mobile US Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "EA", market: "US", name: "Electronic Arts Inc.", sector: "Communication Services", currency: "USD" },
  { symbol: "TTWO", market: "US", name: "Take-Two Interactive", sector: "Communication Services", currency: "USD" },
  { symbol: "WBD", market: "US", name: "Warner Bros. Discovery", sector: "Communication Services", currency: "USD" },

  // Consumer Discretionary
  { symbol: "AMZN", market: "US", name: "Amazon.com Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "TSLA", market: "US", name: "Tesla Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "HD", market: "US", name: "Home Depot Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "MCD", market: "US", name: "McDonald's Corp.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "NKE", market: "US", name: "Nike Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "SBUX", market: "US", name: "Starbucks Corp.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "LOW", market: "US", name: "Lowe's Companies", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "BKNG", market: "US", name: "Booking Holdings", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "TJX", market: "US", name: "TJX Companies", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "CMG", market: "US", name: "Chipotle Mexican Grill", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "ROST", market: "US", name: "Ross Stores Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "YUM", market: "US", name: "Yum! Brands Inc.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "MAR", market: "US", name: "Marriott International", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "GM", market: "US", name: "General Motors Co.", sector: "Consumer Discretionary", currency: "USD" },
  { symbol: "F", market: "US", name: "Ford Motor Co.", sector: "Consumer Discretionary", currency: "USD" },

  // Consumer Staples
  { symbol: "WMT", market: "US", name: "Walmart Inc.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "PG", market: "US", name: "Procter & Gamble", sector: "Consumer Staples", currency: "USD" },
  { symbol: "KO", market: "US", name: "Coca-Cola Co.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "PEP", market: "US", name: "PepsiCo Inc.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "COST", market: "US", name: "Costco Wholesale Corp.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "PM", market: "US", name: "Philip Morris International", sector: "Consumer Staples", currency: "USD" },
  { symbol: "MO", market: "US", name: "Altria Group", sector: "Consumer Staples", currency: "USD" },
  { symbol: "CL", market: "US", name: "Colgate-Palmolive", sector: "Consumer Staples", currency: "USD" },
  { symbol: "MDLZ", market: "US", name: "Mondelez International", sector: "Consumer Staples", currency: "USD" },
  { symbol: "TGT", market: "US", name: "Target Corp.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "KHC", market: "US", name: "Kraft Heinz Co.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "STZ", market: "US", name: "Constellation Brands", sector: "Consumer Staples", currency: "USD" },
  { symbol: "KMB", market: "US", name: "Kimberly-Clark Corp.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "GIS", market: "US", name: "General Mills Inc.", sector: "Consumer Staples", currency: "USD" },
  { symbol: "SYY", market: "US", name: "Sysco Corp.", sector: "Consumer Staples", currency: "USD" },

  // Healthcare
  { symbol: "UNH", market: "US", name: "UnitedHealth Group", sector: "Healthcare", currency: "USD" },
  { symbol: "JNJ", market: "US", name: "Johnson & Johnson", sector: "Healthcare", currency: "USD" },
  { symbol: "LLY", market: "US", name: "Eli Lilly and Co.", sector: "Healthcare", currency: "USD" },
  { symbol: "ABBV", market: "US", name: "AbbVie Inc.", sector: "Healthcare", currency: "USD" },
  { symbol: "MRK", market: "US", name: "Merck & Co.", sector: "Healthcare", currency: "USD" },
  { symbol: "PFE", market: "US", name: "Pfizer Inc.", sector: "Healthcare", currency: "USD" },
  { symbol: "TMO", market: "US", name: "Thermo Fisher Scientific", sector: "Healthcare", currency: "USD" },
  { symbol: "ABT", market: "US", name: "Abbott Laboratories", sector: "Healthcare", currency: "USD" },
  { symbol: "DHR", market: "US", name: "Danaher Corp.", sector: "Healthcare", currency: "USD" },
  { symbol: "BMY", market: "US", name: "Bristol-Myers Squibb", sector: "Healthcare", currency: "USD" },
  { symbol: "AMGN", market: "US", name: "Amgen Inc.", sector: "Healthcare", currency: "USD" },
  { symbol: "GILD", market: "US", name: "Gilead Sciences", sector: "Healthcare", currency: "USD" },
  { symbol: "ISRG", market: "US", name: "Intuitive Surgical", sector: "Healthcare", currency: "USD" },
  { symbol: "CVS", market: "US", name: "CVS Health Corp.", sector: "Healthcare", currency: "USD" },
  { symbol: "MDT", market: "US", name: "Medtronic plc", sector: "Healthcare", currency: "USD" },
  { symbol: "VRTX", market: "US", name: "Vertex Pharmaceuticals", sector: "Healthcare", currency: "USD" },
  { symbol: "REGN", market: "US", name: "Regeneron Pharmaceuticals", sector: "Healthcare", currency: "USD" },
  { symbol: "ZTS", market: "US", name: "Zoetis Inc.", sector: "Healthcare", currency: "USD" },
  { symbol: "SYK", market: "US", name: "Stryker Corp.", sector: "Healthcare", currency: "USD" },
  { symbol: "BSX", market: "US", name: "Boston Scientific Corp.", sector: "Healthcare", currency: "USD" },
  { symbol: "HCA", market: "US", name: "HCA Healthcare Inc.", sector: "Healthcare", currency: "USD" },
  { symbol: "CI", market: "US", name: "Cigna Group", sector: "Healthcare", currency: "USD" },
  { symbol: "ELV", market: "US", name: "Elevance Health Inc.", sector: "Healthcare", currency: "USD" },

  // Financials
  { symbol: "JPM", market: "US", name: "JPMorgan Chase & Co.", sector: "Financials", currency: "USD" },
  { symbol: "V", market: "US", name: "Visa Inc.", sector: "Financials", currency: "USD" },
  { symbol: "MA", market: "US", name: "Mastercard Inc.", sector: "Financials", currency: "USD" },
  { symbol: "BAC", market: "US", name: "Bank of America Corp.", sector: "Financials", currency: "USD" },
  { symbol: "WFC", market: "US", name: "Wells Fargo & Co.", sector: "Financials", currency: "USD" },
  { symbol: "GS", market: "US", name: "Goldman Sachs Group", sector: "Financials", currency: "USD" },
  { symbol: "MS", market: "US", name: "Morgan Stanley", sector: "Financials", currency: "USD" },
  { symbol: "AXP", market: "US", name: "American Express Co.", sector: "Financials", currency: "USD" },
  { symbol: "C", market: "US", name: "Citigroup Inc.", sector: "Financials", currency: "USD" },
  { symbol: "SCHW", market: "US", name: "Charles Schwab Corp.", sector: "Financials", currency: "USD" },
  { symbol: "BLK", market: "US", name: "BlackRock Inc.", sector: "Financials", currency: "USD" },
  { symbol: "SPGI", market: "US", name: "S&P Global Inc.", sector: "Financials", currency: "USD" },
  { symbol: "PYPL", market: "US", name: "PayPal Holdings", sector: "Financials", currency: "USD" },
  { symbol: "USB", market: "US", name: "U.S. Bancorp", sector: "Financials", currency: "USD" },
  { symbol: "PNC", market: "US", name: "PNC Financial Services", sector: "Financials", currency: "USD" },
  { symbol: "TFC", market: "US", name: "Truist Financial Corp.", sector: "Financials", currency: "USD" },
  { symbol: "COF", market: "US", name: "Capital One Financial", sector: "Financials", currency: "USD" },
  { symbol: "MET", market: "US", name: "MetLife Inc.", sector: "Financials", currency: "USD" },
  { symbol: "PRU", market: "US", name: "Prudential Financial", sector: "Financials", currency: "USD" },
  { symbol: "AIG", market: "US", name: "American International Group", sector: "Financials", currency: "USD" },
  { symbol: "ICE", market: "US", name: "Intercontinental Exchange", sector: "Financials", currency: "USD" },
  { symbol: "CME", market: "US", name: "CME Group Inc.", sector: "Financials", currency: "USD" },
  { symbol: "MCO", market: "US", name: "Moody's Corp.", sector: "Financials", currency: "USD" },

  // Industrials
  { symbol: "GE", market: "US", name: "General Electric Co.", sector: "Industrials", currency: "USD" },
  { symbol: "CAT", market: "US", name: "Caterpillar Inc.", sector: "Industrials", currency: "USD" },
  { symbol: "BA", market: "US", name: "Boeing Co.", sector: "Industrials", currency: "USD" },
  { symbol: "HON", market: "US", name: "Honeywell International", sector: "Industrials", currency: "USD" },
  { symbol: "UPS", market: "US", name: "United Parcel Service", sector: "Industrials", currency: "USD" },
  { symbol: "RTX", market: "US", name: "RTX Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "LMT", market: "US", name: "Lockheed Martin Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "DE", market: "US", name: "Deere & Co.", sector: "Industrials", currency: "USD" },
  { symbol: "UNP", market: "US", name: "Union Pacific Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "MMM", market: "US", name: "3M Co.", sector: "Industrials", currency: "USD" },
  { symbol: "ADP", market: "US", name: "Automatic Data Processing", sector: "Industrials", currency: "USD" },
  { symbol: "ETN", market: "US", name: "Eaton Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "EMR", market: "US", name: "Emerson Electric Co.", sector: "Industrials", currency: "USD" },
  { symbol: "ITW", market: "US", name: "Illinois Tool Works", sector: "Industrials", currency: "USD" },
  { symbol: "NSC", market: "US", name: "Norfolk Southern Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "CSX", market: "US", name: "CSX Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "FDX", market: "US", name: "FedEx Corp.", sector: "Industrials", currency: "USD" },
  { symbol: "WM", market: "US", name: "Waste Management Inc.", sector: "Industrials", currency: "USD" },
  { symbol: "PH", market: "US", name: "Parker Hannifin Corp.", sector: "Industrials", currency: "USD" },

  // Energy
  { symbol: "XOM", market: "US", name: "Exxon Mobil Corp.", sector: "Energy", currency: "USD" },
  { symbol: "CVX", market: "US", name: "Chevron Corp.", sector: "Energy", currency: "USD" },
  { symbol: "COP", market: "US", name: "ConocoPhillips", sector: "Energy", currency: "USD" },
  { symbol: "SLB", market: "US", name: "Schlumberger (SLB)", sector: "Energy", currency: "USD" },
  { symbol: "EOG", market: "US", name: "EOG Resources Inc.", sector: "Energy", currency: "USD" },
  { symbol: "PSX", market: "US", name: "Phillips 66", sector: "Energy", currency: "USD" },
  { symbol: "OXY", market: "US", name: "Occidental Petroleum", sector: "Energy", currency: "USD" },
  { symbol: "WMB", market: "US", name: "Williams Companies", sector: "Energy", currency: "USD" },

  // Utilities
  { symbol: "NEE", market: "US", name: "NextEra Energy Inc.", sector: "Utilities", currency: "USD" },
  { symbol: "DUK", market: "US", name: "Duke Energy Corp.", sector: "Utilities", currency: "USD" },
  { symbol: "SO", market: "US", name: "Southern Co.", sector: "Utilities", currency: "USD" },
  { symbol: "D", market: "US", name: "Dominion Energy Inc.", sector: "Utilities", currency: "USD" },
  { symbol: "AEP", market: "US", name: "American Electric Power", sector: "Utilities", currency: "USD" },
  { symbol: "EXC", market: "US", name: "Exelon Corp.", sector: "Utilities", currency: "USD" },
  { symbol: "SRE", market: "US", name: "Sempra", sector: "Utilities", currency: "USD" },

  // Real Estate
  { symbol: "AMT", market: "US", name: "American Tower Corp.", sector: "Real Estate", currency: "USD" },
  { symbol: "PLD", market: "US", name: "Prologis Inc.", sector: "Real Estate", currency: "USD" },
  { symbol: "EQIX", market: "US", name: "Equinix Inc.", sector: "Real Estate", currency: "USD" },
  { symbol: "O", market: "US", name: "Realty Income Corp.", sector: "Real Estate", currency: "USD" },
  { symbol: "SPG", market: "US", name: "Simon Property Group", sector: "Real Estate", currency: "USD" },
  { symbol: "PSA", market: "US", name: "Public Storage", sector: "Real Estate", currency: "USD" },

  // Materials
  { symbol: "LIN", market: "US", name: "Linde plc", sector: "Materials", currency: "USD" },
  { symbol: "SHW", market: "US", name: "Sherwin-Williams Co.", sector: "Materials", currency: "USD" },
  { symbol: "APD", market: "US", name: "Air Products and Chemicals", sector: "Materials", currency: "USD" },
  { symbol: "ECL", market: "US", name: "Ecolab Inc.", sector: "Materials", currency: "USD" },
  { symbol: "NEM", market: "US", name: "Newmont Corp.", sector: "Materials", currency: "USD" },
  { symbol: "FCX", market: "US", name: "Freeport-McMoRan Inc.", sector: "Materials", currency: "USD" },
];

// Deliberately NOT lowered to the site-wide 5-min refresh standard applied
// elsewhere (fundamentals/chips/momentum/briefs/news — see
// FUNDAMENTALS_TTL_MS in lib/data/index.ts): this caches WHICH companies
// exist and their official industry classification, not any figure that
// actually moves during a trading day. A company doesn't newly list or
// change industry category between one 5-minute window and the next, so
// refetching this ~1700-company combined TWSE+TPEx listing every 5 minutes
// would be 288 refetches/day of something that changes maybe a few times a
// year, for zero real freshness gain. TW_UNIVERSE_DEGRADED_TTL_MS below is
// the one exception that already refreshes fast — that's for retrying a
// FAILED fetch quickly, not for freshness of a successful one.
const TW_UNIVERSE_TTL_MS = 24 * 60 * 60_000;
// Bounds how many TW symbols downstream code batch-fetches quotes/charts
// for at once (search results, rankings, momentum screening) — TWSE lists
// roughly 1000 companies, and rankings/momentum screens need to stay
// responsive rather than firing hundreds of concurrent requests. Capped,
// not fabricated: everything past the cap simply isn't included in THOSE
// screens, the same way an unreachable quote is omitted rather than
// replaced with a guess — this does not limit which stocks a single-stock
// lookup (by code, or by name via findSymbolByName) can find; see
// twFullCompanySnapshot above, which is never capped.
//
// Raised 200 -> 500 -> 1200. A user compared this site's TW coverage
// against TWSE's own official listing count and found ~600 real, currently-
// listed companies (roughly a third of the whole market) missing purely
// because they sorted past the 500th slot — this cap, not a data-source
// gap. TWSE's own open-data company listing (t187ap03_L) reports 1094 real
// listings; 1200 covers that with headroom for new listings without needing
// another bump soon. Confirmed live this is safe to raise: TPEx's own
// MAX_TPEX_UNIVERSE below already sits at 900 (covering TPEx's real ~891
// count) using the *same* mis.twse.com.tw chunked-batch mechanism (50
// symbols per pipe-separated request) since TPEx quotes were switched onto
// it — so 1200/50 = 24 chunks for TWSE is the same order of magnitude as
// TPEx's already-proven 900/50 = 18, not a new scale of load. Re-verified
// /api/search?market=TW still returns promptly and with correct data at
// 1200 (see PROGRESS.md for the actual measured response).
const MAX_TWSE_UNIVERSE = 1200;
// TPEx (上櫃) headroom, added alongside MAX_TWSE_UNIVERSE above when TPEx
// coverage was built. Deliberately a SEPARATE cap per exchange rather than
// one shared MAX_TW_UNIVERSE — TPEx's whole-market quote snapshot
// (fetchTpexQuoteSnapshot in tpex.ts) is always ONE request no matter how
// many TPEx symbols end up in this universe, unlike TWSE's batch fetch
// which is chunked per 50 symbols — so raising this number doesn't add any
// concurrent-request risk to TPEx's own upstream the way raising TWSE's cap
// would.
//
// Originally 300: an Opus QA pass found 信驊(5274) — a well-known, widely
// discussed TPEx chip-design stock — excluded from /api/search purely
// because it sorted past the 300th spot in fetchTpexListedCompanies' own
// paid-in-capital ordering, even though single-symbol lookups (quote/chart/
// AI chat) worked fine for it since those don't go through this cap at all.
// Raised to 900 — comfortably above TPEx's real ~891 OTC stock count — since
// there's no concurrency cost to justify capping this exchange tightly the
// way MAX_TWSE_UNIVERSE's 500 is (that one IS chunked batch requests). This
// is a ceiling for correctness/future headroom, not an active constraint:
// every real TPEx stock should now appear in search/rankings.
const MAX_TPEX_UNIVERSE = 900;

// Kept in sync (best-effort, in the background) so the synchronous
// findInUniverse/sectorsFor helpers below get the fuller official list as
// soon as it's been fetched once, without every caller having to await it.
// Two separate snapshots on purpose: `twUniverseSnapshot` is capped (see
// MAX_TW_UNIVERSE) for anything that batch-fetches live quotes for the whole
// list (search/rankings/momentum) — that cap exists to protect TWSE's
// unofficial batch-quote endpoint from too much concurrent load, a real
// constraint. But `findSymbolByName`/`findInUniverse` never batch-fetch
// anything themselves — they're a single dictionary lookup — so capping
// *them* to the same 200 was an unnecessary side effect of reusing one
// snapshot for both jobs. A user reported the AI/chat/search-by-name
// couldn't find "many stocks" and their P/E, monthly revenue etc. came back
// missing; the underlying data endpoints (BWIBBU_ALL, monthly revenue,
// quarterly EPS — see twse.ts) already cover the full ~1000-company listing
// regardless of this cap, so the actual bug was that the *name lookup*
// itself never got past the first 200 whenever a real stock's Chinese name
// was typed into chat/search instead of its numeric code.
let twUniverseSnapshot: UniverseEntry[] = TW_UNIVERSE_SEED;
let twFullCompanySnapshot: UniverseEntry[] = TW_UNIVERSE_SEED;
/** 一個可以拿來在文字裡比對的名稱（公司全名、去掉 Inc./Corp. 後的簡稱，或
 *  美股的中文俗名），以及它對應到哪一檔股票。 */
interface NameLookupTerm {
  /** 已經轉成小寫，比對時不用每次再轉一遍。 */
  term: string;
  entry: UniverseEntry;
}

// Pre-built and pre-sorted (longest *term* first) once per getTwUniverse()
// refresh, not on every findSymbolByName() call — that function runs on
// every chat message, and re-sorting ~1000+ entries per call would be
// wasted work repeated on a hot path for a list that only actually changes
// once a day.
//
// Sorted by the length of each individual match term rather than by
// entry.name.length: those two used to disagree whenever a match candidate
// wasn't the full legal name, and adding Chinese aliases for US stocks
// (US_NAME_ALIASES) made that gap matter. A 3-character alias like 「特斯拉」
// hangs off an entry whose name ("Tesla Inc.") is 10 characters long, so
// ordering by entry.name.length would let it be tried *before* a longer,
// more specific Taiwanese company name — exactly the "shorter name steals
// the match" failure findAllSymbolsByName's claimed-range logic exists to
// prevent. Ordering by the term actually being searched for keeps the
// "longest, most specific match wins" rule true for every candidate form.
let nameLookupTerms: NameLookupTerm[] | undefined;

/**
 * Built on first use rather than eagerly at module load. buildNameLookupTerms
 * reads CORP_SUFFIX_PATTERN and US_NAME_ALIASES, both `const`s declared
 * further down this file — a `const` is in its temporal dead zone until its
 * own declaration statement runs, so evaluating this at the top of the module
 * would throw a ReferenceError the instant anything imported this file. (The
 * old entry-based pool got away with eager initialization only because it
 * sorted on `entry.name.length` and touched neither of those constants.)
 */
function getNameLookupTerms(): NameLookupTerm[] {
  if (!nameLookupTerms) nameLookupTerms = buildNameLookupTerms(TW_UNIVERSE_SEED);
  return nameLookupTerms;
}

const MIN_NAME_MATCH_LENGTH = 2;

// Same problem as STOPWORDS above, just on the Chinese-name side instead of
// the English-ticker side: a company's OFFICIAL short name can coincide with
// an everyday word, and a plain substring match then hijacks any sentence
// that happens to use that word in its ordinary sense. Confirmed via a real
// production incident (Opus QA, 2026-09-21): asking "殖利率最高的有哪些股票？
// 請附上殖利率數字" got misread as naming 數字(5287, TPEx) purely because the
// question ends with the word "數字" ("number/figure") — verified directly
// against the exchange's own listing (`/api/symbol-lookup?q=數字` on this
// site) that "數字" genuinely IS 5287's real, official short name, not a bug
// in how this file derives it. Because targets.length becomes non-zero, the
// whole ranking-screen grounding path never runs and the model has to answer
// "no data" for a question the site could actually answer — same failure
// shape as "MACD/RSI got treated as unknown US tickers" that STOPWORDS
// exists to prevent, just triggered by an ordinary Chinese word instead of a
// technical acronym.
//
// A blanket length increase (e.g. requiring 3+ characters) isn't a safe fix
// here: plenty of real, commonly-referenced TW companies have genuinely
// 2-character short names people actually type as-is (台泥, 中鋼, 台塑, 統一,
// 鴻海, 台達, 廣達…) — raising the floor would break all of those instead of
// just this one collision. So this is a small, curated exclusion list in the
// same spirit as STOPWORDS: only add a name here once it's been confirmed to
// (a) be a real official short name that (b) also reads as ordinary
// vocabulary common enough that a sentence using the word in its normal
// sense is far more likely than someone actually meaning this specific,
// otherwise-obscure company. Excluding a term here only blocks *name-based*
// sentence parsing (guessSymbolsFromText/findAllSymbolsByName/
// findSymbolByName) — the numeric code (e.g. "5287") still resolves fine
// through SYMBOL_PATTERN in symbolResolve.ts, and the search box's own
// separate contains-match function is untouched, so someone who deliberately
// types "數字" into the search box to find this company can still find it.
const AMBIGUOUS_CN_NAME_STOPWORDS = new Set(["數字"]);

function buildNameLookupTerms(twCompanies: UniverseEntry[]): NameLookupTerm[] {
  const terms: NameLookupTerm[] = [];
  for (const entry of [...twCompanies, ...US_UNIVERSE]) {
    for (const candidate of matchCandidates(entry)) {
      if (candidate.length >= MIN_NAME_MATCH_LENGTH && !AMBIGUOUS_CN_NAME_STOPWORDS.has(candidate)) {
        terms.push({ term: candidate.toLowerCase(), entry });
      }
    }
  }
  return terms.sort((a, b) => b.term.length - a.term.length);
}

/**
 * The full TW stock universe, sourced from TWSE's official open-data
 * company listing (see fetchTwseListedCompanies in ./twse) instead of a
 * small hand-picked list. Falls back to the seed list if the official
 * endpoint is unreachable — never a fabricated one.
 */
/**
 * Applies MAX_TW_UNIVERSE without letting the cap decide *which* stocks
 * survive by accident. TWSE's listing comes back ordered by 公司代號, so a
 * plain `slice(0, 100)` keeps codes 1101-~1800 (水泥/食品/塑膠/紡織…) and
 * drops every stock a Taiwanese user actually looks for — 2330 台積電,
 * 2317 鴻海, 2454 聯發科, 2412 中華電 and the whole 28xx 金融 block are all
 * above the cut. That silently emptied the TW side of the site of anything
 * recognizable: 焦點排行, 漲跌幅榜, 成交量榜, 技術訊號共振股 and the daily
 * brief were ranking only obscure traditional-industry small caps.
 *
 * So the hand-curated seed (the well-known large caps) is placed first and
 * the rest of the official list fills the remaining slots. Entries still
 * carry TWSE's own official name/industry — the seed only decides priority,
 * never the data itself, and a seed symbol that isn't actually listed
 * anymore simply doesn't appear.
 */
/**
 * Applied per-exchange (see MAX_TWSE_UNIVERSE/MAX_TPEX_UNIVERSE above) so
 * TPEx entries can never crowd out TWSE's existing, already-tuned slice (or
 * vice versa) — a single shared cap over the concatenated list would let
 * whichever exchange's companies happen to come first fill most of the
 * budget.
 */
function capOne(companies: UniverseEntry[], seed: UniverseEntry[], max: number): UniverseEntry[] {
  const official = new Map(companies.map((e) => [e.symbol, e]));
  const picked = new Map<string, UniverseEntry>();
  for (const s of seed) {
    const match = official.get(s.symbol);
    if (match) picked.set(match.symbol, match);
  }
  for (const entry of companies) {
    if (picked.size >= max) break;
    if (!picked.has(entry.symbol)) picked.set(entry.symbol, entry);
  }
  return Array.from(picked.values()).slice(0, max);
}

/**
 * 興櫃（exchange === "Emerging"）**刻意完全不進入這個回傳值**，這是產品決策
 * 不是遺漏，理由三個，都跟「這個網站是給沒有股市背景的家人看的」直接相關：
 *
 * 1. 興櫃沒有漲跌幅限制，單日 ±30% 是常態。這個回傳值餵的是漲跌幅排行、
 *    成交量榜、技術訊號共振股、今日建議——只要把興櫃混進去，這些「今天漲最多」
 *    的榜單幾乎每天都會被興櫃股洗版，而使用者看榜單時的預期是上市櫃。
 * 2. 興櫃是議價交易、流動性極低（實測某個交易日 361 檔裡有 18 檔整天 0 成交），
 *    均線/RSI/MACD 這類技術指標套在這種成交結構上算出來的數字沒有意義。
 * 3. 興櫃是「準備上市櫃的過渡階段」，風險本來就明顯高於上市櫃，不適合出現在
 *    一個會直接給「建議買進」的清單裡。
 *
 * **但興櫃股票完全查得到**：getTwUniverse() 回傳前會把含興櫃的完整清單寫進
 * twFullCompanySnapshot，所以搜尋框、代號/中文名查詢、個股頁、AI 問答全部都
 * 認得興櫃股票（那些路徑走的是單檔查詢，不是這裡的批次報價清單）。要改這個
 * 決策的話，要連同上面三點一起重新評估，不要只因為「看起來少收了東西」就加。
 */
function capUniverse(companies: UniverseEntry[]): UniverseEntry[] {
  const twse = companies.filter((e) => e.exchange == null || e.exchange === "TWSE");
  const tpex = companies.filter((e) => e.exchange === "TPEx");
  // TW_UNIVERSE_SEED is all-TWSE, so it only ever matches (and only ever
  // needs to be checked against) the twse partition; tpex has no hand-picked
  // seed — fetchTpexListedCompanies' own paid-in-capital sort already puts
  // its well-known large caps first, so a plain cap-to-N does the
  // equivalent job for that partition.
  return [...capOne(twse, TW_UNIVERSE_SEED, MAX_TWSE_UNIVERSE), ...capOne(tpex, [], MAX_TPEX_UNIVERSE)];
}

// "-v4": this key's SHAPE changed when TPEx was merged in (TWSE-only ->
// TWSE+TPEx) — bumping the key (same pattern as news-feed:v1 -> v2
// elsewhere in this codebase) forces every instance to recompute on next
// read instead of serving whatever pre-TPEx list this key already holds in
// Redis for up to its full 24h TTL. Went through v2 and v3 first: v2 was
// bumped when TPEx first merged in, but real traffic hit (and cached, for
// the full 24h TTL) a TWSE-only result in the window before
// fetchTpexListedCompanies' reliability was actually fixed; v3 was bumped
// right after that fix landed, but got unlucky and ALSO cached a TWSE-only
// result on its very first computation (the ~1MB company-listing fetch can
// still fail outright even with a large byte-resume budget). That second
// poisoning is what motivated the asymmetric-TTL logic below — from v4
// onward, a degraded (TPEx-empty) result is no longer trusted with the
// full 24h TTL a genuine success deserves.
// "-v5": bumped again when 興櫃 (Emerging) entries joined this merged list —
// same reasoning as the v2->v4 history above, this key's CONTENT shape
// changed, and without a bump every instance would keep serving the
// pre-興櫃 list out of Redis for up to the full 24h TTL, making emerging
// stocks look like they still aren't covered.
const TW_UNIVERSE_CACHE_KEY = "tw-universe-full-raw-v5";
// How long a DEGRADED (TPEx came back empty — meaning its fetch almost
// certainly failed, since a real company listing is never actually empty)
// merge result is trusted before the next request gets a fresh attempt.
// Deliberately much shorter than TW_UNIVERSE_TTL_MS: a genuine 24h-cacheable
// success and "we don't have TPEx data yet, retry soon" are different
// enough situations that they shouldn't share a TTL.
const TW_UNIVERSE_DEGRADED_TTL_MS = 5 * 60_000;

// Single-flight guard for the (relatively expensive, whole-market) compute
// below — getTwUniverse() is called on most search/chat/momentum requests,
// and without this, several concurrent cache-miss callers would each kick
// off their own redundant TWSE+TPEx fetch. peekCached/writeCached (unlike
// cached()) don't provide this on their own, since they're the "read what's
// there, or compute-and-write-with-a-chosen-TTL" building blocks used here
// specifically to support the asymmetric TTL above.
let universeComputePromise: Promise<UniverseEntry[]> | undefined;

export async function getTwUniverse(): Promise<UniverseEntry[]> {
  const { fetchTwseListedCompanies } = await import("./twse");
  const { fetchTpexListedCompanies } = await import("./tpex");
  const { fetchEmergingListedCompanies } = await import("./emerging");
  // Cache holds the FULL uncapped official list (TWSE + TPEx merged) — the
  // cap is applied fresh on every read (cheap: an in-memory filter over an
  // already-fetched array), so the raw full list is always available for
  // name lookups even though this function's own return value stays capped
  // for callers that batch-fetch live quotes for everything it returns.
  // Each exchange's fetch is wrapped in its own try/catch (not one try
  // around both) so a TPEx outage never takes down TWSE's listing or vice
  // versa — matching the "degrade gracefully per source" pattern already
  // used for e.g. getIndices' per-index try/catch. No symbol-collision risk
  // merging the two: TW stock codes are allocated from one shared national
  // registry, TWSE and TPEx never reuse the same code for different
  // companies.
  const cachedValue = await peekCached<UniverseEntry[]>(TW_UNIVERSE_CACHE_KEY);
  let full: UniverseEntry[];
  if (cachedValue) {
    full = cachedValue;
  } else if (universeComputePromise) {
    full = await universeComputePromise;
  } else {
    universeComputePromise = (async () => {
      const [twse, tpex, emerging] = await Promise.all([
        fetchTwseListedCompanies().catch(() => []),
        fetchTpexListedCompanies().catch(() => []),
        fetchEmergingListedCompanies().catch(() => []),
      ]);
      // TWSE failing outright falls back to the hand-curated (all-TWSE) seed
      // as before — TPEx succeeding independently must never be the reason
      // every TWSE stock silently vanishes from the universe.
      const twseFinal = twse.length > 0 ? twse : TW_UNIVERSE_SEED;
      const merged = [...twseFinal, ...tpex, ...emerging];
      // 降級 TTL 的判斷條件只看 TPEx（維持原本的行為）：那份清單空掉幾乎必然
      // 代表抓取失敗，而且它會直接讓上櫃股從排行/搜尋消失，屬於嚴重降級。興櫃
      // 清單空掉的影響小得多（興櫃本來就不進排行，只影響「查不查得到」），且
      // 它跟 TPEx 共用同一個上游主機、失敗原因通常也一樣，所以 TPEx 成功時
      // 沒必要因為興櫃單獨失敗就把整份清單的信任期縮到 5 分鐘、害整個 TW
      // universe 每 5 分鐘重抓一次全市場。
      const ttl = tpex.length > 0 ? TW_UNIVERSE_TTL_MS : TW_UNIVERSE_DEGRADED_TTL_MS;
      await writeCached(TW_UNIVERSE_CACHE_KEY, merged, ttl);
      return merged;
    })();
    try {
      full = await universeComputePromise;
    } finally {
      universeComputePromise = undefined;
    }
  }
  twFullCompanySnapshot = full;
  nameLookupTerms = buildNameLookupTerms(full);
  const capped = capUniverse(full);
  twUniverseSnapshot = capped;
  return capped;
}

/**
 * 呼叫這個函式一次，確保 `findInUniverse()`／`searchUniverseByQuery()`／
 * `sectorsFor()` 這幾個同步讀取函式讀到的是真正完整的官方股票清單，不是一份
 * 只有幾十檔的內建SEED清單。
 *
 * 為什麼需要這個：上面 `twFullCompanySnapshot`／`twUniverseSnapshot` 這兩個
 * 模組層級變數只有在 `getTwUniverse()` 真的執行完一次之後才會是完整清單，在那
 * 之前是很小的SEED。這幾個同步函式的簽名完全看不出這個前置條件，是這個檔案
 * 最容易被忘記的一個地雷——2026-09-14（`searchUniverseByQuery`，美利達查不到）
 * 跟 2026-09-22（`findInUniverse`，關注清單產業別查不到信驊等股票）已經各自在
 * 不同呼叫端咬過一次。與其要求每個新呼叫端都自己記得寫`await getTwUniverse()
 * .catch(() => undefined)`這串（現有的`/api/sectors`、`/api/symbol-lookup`、
 * `symbolResolve.ts`都是各自手寫這行，容易漏），統一呼叫這個具名函式，之後
 * `grep -rn "ensureTwUniverseWarm"` 就能一眼看出哪些進入點已經處理過。
 *
 * 這份資料是 Redis 快取（跨所有無伺服器實例共用），非冷啟動時這裡幾乎是免費的
 * 快取命中，可以放心在任何用得到上述三個函式的 async 進入點呼叫，不用擔心效能。
 */
export async function ensureTwUniverseWarm(): Promise<void> {
  await getTwUniverse().catch(() => undefined);
}

/** 呼叫前必須先 `await ensureTwUniverseWarm()`（見上方說明），否則市場為 "TW"
 *  時查到的可能只是SEED清單、漏掉大量非超大型權值股。 */
export function findInUniverse(symbol: string, market?: Market): UniverseEntry | undefined {
  const upper = symbol.toUpperCase();
  const pool = market === "US" ? US_UNIVERSE : market === "TW" ? twFullCompanySnapshot : [...twFullCompanySnapshot, ...US_UNIVERSE];
  return pool.find((e) => e.symbol.toUpperCase() === upper);
}

// US entries carry full legal names ("Apple Inc.", "Alphabet Inc."), but
// nobody types the legal suffix when asking about a stock — matching only
// the literal full name meant "Apple" (or "apple", any case) never matched
// "Apple Inc." at all, and the AI fell back to only recognizing the bare
// ticker "AAPL". Stripped names are tried as an additional candidate rather
// than replacing the full name, so exact full-name matches (rare but
// possible) still work too.
/** 台股官方簡稱結尾的標記：「*」／全形「＊」、「-KY」（含全形連字號）。 */
const TW_NAME_MARK_PATTERN = /(?:[*＊]+|[-－]KY)$/i;
const CORP_SUFFIX_PATTERN = /[,.]?\s+(inc|corp|corporation|co|ltd|plc|company|holdings?|group)\.?$/i;

/**
 * 美股個股的中文俗名。US_UNIVERSE 只存英文法定名稱，但這個網站的使用者是
 * 台灣的一般人/長輩——他們問美股時幾乎不會打 "Tesla" 或 "TSLA"，而是直接
 * 打「特斯拉」。實測抓到的真實 bug：問「特斯拉現在多少錢？值得買嗎？」
 * 回答「目前查不到特斯拉的資料…不在本站資料涵蓋範圍」，但 TSLA 明明就在
 * US_UNIVERSE 裡——純粹是名稱比對只認英文造成的假性「查不到」，跟「價漲量增
 * 誤答沒有資料」是同一類（有資料卻答沒有）的問題。
 *
 * 只收錄台灣財經媒體長期慣用、辨識度高的譯名，並同時收常見的簡體/中國譯法
 * （使用者可能從簡體資訊來源看到「英伟达」「奈飞」而照打）。刻意不收罕用或
 * 自創譯名，避免拿一個沒人用的詞去誤攔其他問題。
 *
 * 重要：這裡的每個詞都必須確認「不是任何台股公司簡稱的子字串」，否則會把台股
 * 問題誤判成美股（例如絕對不能把「台積電」設成 TSM 的別名，那會讓所有問 2330
 * 的問題跑去查 ADR；只收「台積電ADR」這種明確指名 ADR 的寫法）。
 */
const US_NAME_ALIASES: Record<string, string[]> = {
  AAPL: ["蘋果", "苹果"],
  MSFT: ["微軟", "微软"],
  NVDA: ["輝達", "英偉達", "英伟达"],
  AVGO: ["博通"],
  ORCL: ["甲骨文"],
  ADBE: ["奧多比"],
  CSCO: ["思科"],
  AMD: ["超微半導體", "超微"],
  TXN: ["德州儀器", "德州仪器"],
  QCOM: ["高通"],
  AMAT: ["應用材料", "应用材料"],
  MU: ["美光"],
  LRCX: ["科林研發", "科林研发"],
  KLAC: ["科磊"],
  INTC: ["英特爾", "英特尔"],
  DELL: ["戴爾", "戴尔"],
  // HPQ 刻意不設「惠普」別名：台股 8424 的公司簡稱就叫「惠普」（惠普科技），
  // 兩邊字面完全相同，設了就會讓問台股惠普的人拿到美股 HP 的資料。
  UBER: ["優步", "优步"],
  ABNB: ["愛彼迎"],
  // 只收明確指名 ADR 的寫法——「台積電」本身一定要留給台股 2330。
  TSM: ["台積電ADR", "台積電 ADR", "台積電adr"],
  GOOGL: ["谷歌", "google"],
  META: ["臉書", "脸书"],
  NFLX: ["網飛", "奈飛", "奈飞"],
  DIS: ["迪士尼"],
  CMCSA: ["康卡斯特"],
  VZ: ["威訊"],
  AMZN: ["亞馬遜", "亚马逊"],
  TSLA: ["特斯拉"],
  HD: ["家得寶"],
  MCD: ["麥當勞", "麦当劳"],
  NKE: ["耐吉", "耐克"],
  SBUX: ["星巴克"],
  GM: ["通用汽車", "通用汽车"],
  WMT: ["沃爾瑪", "沃尔玛"],
  PG: ["寶僑", "寶潔", "宝洁"],
  KO: ["可口可樂", "可口可乐"],
  PEP: ["百事可樂", "百事可乐"],
  COST: ["好市多", "開市客"],
  PM: ["菲利普莫里斯"],
  UNH: ["聯合健康", "联合健康"],
  // 只收台灣慣用的「嬌生」：中國譯法「強生」跟台股 4747 的簡稱「強生*」
  // 只差一個代表特殊註記的星號，使用者打「強生」時會被這個別名攔走。
  JNJ: ["嬌生"],
  LLY: ["禮來", "礼来"],
  PFE: ["輝瑞", "辉瑞"],
  MRK: ["默克"],
  ABT: ["亞培"],
  AMGN: ["安進"],
  JPM: ["摩根大通", "小摩"],
  MA: ["萬事達卡", "萬事達", "万事达"],
  BAC: ["美國銀行", "美银"],
  GS: ["高盛"],
  MS: ["摩根士丹利", "大摩"],
  AXP: ["美國運通", "美国运通"],
  C: ["花旗"],
  BLK: ["貝萊德", "贝莱德"],
  GE: ["奇異電氣", "通用電氣", "通用电气"],
  CAT: ["開拓重工", "卡特彼勒"],
  BA: ["波音"],
  RTX: ["雷神"],
  LMT: ["洛克希德馬丁", "洛克希德"],
  DE: ["強鹿", "迪爾公司"],
  FDX: ["聯邦快遞", "联邦快递"],
  XOM: ["埃克森美孚", "艾克森美孚"],
  CVX: ["雪佛龍", "雪佛龙"],
  NEM: ["紐蒙特"],
  FCX: ["自由港"],
};

function matchCandidates(entry: UniverseEntry): string[] {
  const { name } = entry;
  const stripped = name.replace(CORP_SUFFIX_PATTERN, "").trim();
  const candidates = stripped && stripped !== name ? [name, stripped] : [name];
  // 台股官方簡稱常帶標記：結尾「*」（例：國巨*）、「-KY」（例：臻鼎-KY）。使用者打字時不會帶這些，
  // 2026-10-05 使用者📝回報「為什麼沒有國巨資料」：AI 問答完全解析不到「國巨」，因為清單裡只有「國巨*」。
  if (entry.market === "TW") {
    const plain = name.replace(TW_NAME_MARK_PATTERN, "").trim();
    if (plain && plain !== name && !candidates.includes(plain)) candidates.push(plain);
  }
  const aliases = entry.market === "US" ? US_NAME_ALIASES[entry.symbol.toUpperCase()] : undefined;
  return aliases ? [...candidates, ...aliases] : candidates;
}

/**
 * Finds a stock by scanning free-form text for a known company name as a
 * substring (e.g. picks "鴻海" out of "鴻海現在多少錢" or "台積電" out of a
 * longer sentence, or "Apple"/"apple" out of "Apple現在股價多少" via
 * matchCandidates above). Names are checked longest-first so a specific
 * match (e.g. "台積電") wins over any shorter name that happens to also be a
 * substring of the text. Comparison is case-insensitive throughout (matters
 * for English names only — lowercasing Chinese text is a no-op). Used to
 * ground the AI chat when a user types a company name instead of a
 * ticker/code.
 */
export function findSymbolByName(text: string): UniverseEntry | undefined {
  const lowerText = text.toLowerCase();
  return getNameLookupTerms().find(({ term }) => lowerText.includes(term))?.entry;
}

/**
 * Like findSymbolByName, but collects every distinct company name found in
 * the text (up to `limit`), not just the first — needed for comparison
 * questions ("A跟B比較", "2330和2454哪個好") that name more than one company
 * at once. Still checked longest-name-first (same pool ordering as
 * findSymbolByName) so a specific name is preferred over a shorter one that
 * happens to also be a substring, and results are deduped by symbol.
 *
 * Also tracks which character ranges of the text have already been claimed
 * by a longer match, and skips any shorter name whose only occurrence falls
 * entirely inside an already-claimed range — without this, "聯發科比較"
 * matches BOTH "聯發科"(2454) and "聯發"(1459, a real but unrelated textile
 * company, "聯發紡織") purely because "聯發" is a substring of "聯發科",
 * turning a two-stock comparison into an incorrect three-stock one. Only
 * checks the first occurrence of each name; a name that appears again
 * elsewhere in the text outside any claimed range is a rare enough phrasing
 * that this doesn't try to handle it specially.
 */
export function findAllSymbolsByName(text: string, limit: number): UniverseEntry[] {
  const lowerText = text.toLowerCase();
  const results: UniverseEntry[] = [];
  const seen = new Set<string>();
  const claimed: Array<[number, number]> = [];
  // Terms are already sorted longest-first across every entry (see
  // nameLookupTerms), so a company's shorter alternate spellings are simply
  // later entries in the same flat list rather than an inner loop — the
  // longest unclaimed match anywhere in the text always wins.
  for (const { term, entry } of getNameLookupTerms()) {
    if (results.length >= limit) break;
    if (seen.has(entry.symbol)) continue;
    const start = lowerText.indexOf(term);
    if (start === -1) continue;
    const end = start + term.length;
    if (claimed.some(([s, e]) => start < e && end > s)) continue;
    seen.add(entry.symbol);
    claimed.push([start, end]);
    results.push(entry);
  }
  return results;
}

/**
 * 「使用者在搜尋框打了幾個字，有哪些股票對得上？」——跟上面兩個函式方向相反。
 *
 * findSymbolByName/findAllSymbolsByName 問的是「這段文字（一整句問句）裡面有沒有
 * 包含某家公司的名字」，所以是 `使用者文字.includes(公司名)`；搜尋框要的是反過來的
 * 「公司名裡面有沒有包含使用者打的這幾個字」（`公司名.includes(使用者輸入)`）——
 * 打「台灣」要列出台灣大、台灣高鐵、台灣精材…，而不是去找一家剛好就叫「台灣」的
 * 公司（那樣會一檔都找不到）。這兩種比對不能互相取代，所以另外寫一個。
 *
 * 排序（分數小的排前面）刻意讓「打得越精準的越上面」：
 *   0 代號完全相同 / 公司名完全相同（打 2330 或「台積電」）
 *   1 代號開頭相同（打 233 → 2330、2337…）
 *   2 公司名開頭相同（打「台積」→ 台積電）
 *   3 公司名中間包含（打「電」→ 台達電、中華電…）
 * 同分再讓台股排在美股前面（使用者主力是台股），最後照代號排，確保同一組輸入
 * 每次回傳的順序都一樣（不會因為底層清單重抓而跳動）。
 *
 * 比對用 matchCandidates()，所以美股的中文俗名（特斯拉、輝達…）跟去掉 Inc./Corp.
 * 的簡稱一樣都查得到，跟 AI 問答那邊認得的名稱範圍一致。
 */
/** 呼叫前必須先 `await ensureTwUniverseWarm()`，理由同 `findInUniverse()` 上方的說明。 */
export function searchUniverseByQuery(query: string, limit: number): UniverseEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ entry: UniverseEntry; score: number }> = [];
  const seen = new Set<string>();
  for (const entry of [...twFullCompanySnapshot, ...US_UNIVERSE]) {
    const key = `${entry.market}:${entry.symbol.toUpperCase()}`;
    if (seen.has(key)) continue;
    const symbol = entry.symbol.toLowerCase();
    let score = -1;
    const consider = (candidateScore: number) => {
      if (score === -1 || candidateScore < score) score = candidateScore;
    };
    if (symbol === q) consider(0);
    else if (symbol.startsWith(q)) consider(1);
    for (const candidate of matchCandidates(entry)) {
      const name = candidate.toLowerCase();
      if (name === q) consider(0);
      else if (name.startsWith(q)) consider(2);
      else if (name.includes(q)) consider(3);
    }
    if (score === -1) continue;
    seen.add(key);
    scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.entry.market !== b.entry.market) return a.entry.market === "TW" ? -1 : 1;
    return a.entry.symbol.localeCompare(b.entry.symbol);
  });
  return scored.slice(0, limit).map((s) => s.entry);
}

/** market==="TW" 時呼叫前必須先 `await ensureTwUniverseWarm()`，理由同
 *  `findInUniverse()` 上方的說明；market==="US" 讀的是靜態內建清單，不受影響。 */
export function sectorsFor(market: Market): string[] {
  const pool = market === "TW" ? twUniverseSnapshot : US_UNIVERSE;
  const set = new Set(pool.map((e) => e.sector));
  return Array.from(set).sort();
}
