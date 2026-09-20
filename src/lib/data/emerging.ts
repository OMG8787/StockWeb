import https from "node:https";
import tls from "node:tls";
import type { Candle, ChartRange, Earnings, Quote } from "./types";
import type { UniverseEntry } from "./universe";
import { TW_INDUSTRY_NAMES } from "./twse";
import { fetchTpexJson, TWCA_SSL_SUB_CA_PEM } from "./tpex";
import { fetchUsCandles } from "./us";

/**
 * 興櫃 (Emerging Stock Market / "ESB" in TPEx's own endpoint naming) data
 * layer — the third Taiwanese equity board, alongside 上市 (twse.ts) and
 * 上櫃 (tpex.ts). Same operator as 上櫃 (證券櫃檯買賣中心 / TPEx), but a
 * genuinely different market, so this is its own module rather than a
 * branch inside tpex.ts.
 *
 * WHY THIS MARKET DOESN'T FIT THE NORMAL OHLC SHAPE (read before changing
 * anything here — this is not an implementation shortcut, it's what the
 * market actually is):
 *
 * 興櫃 is NOT a central-limit-order-book auction market. It trades by
 * negotiation (議價) through recommending securities dealers (推薦證券商),
 * either by clicking a dealer's posted quote in TPEx's electronic system
 * (電腦議價點選) or by negotiating off-system (系統外議價). Consequences
 * that this module has to represent honestly:
 *
 *  - There is NO 開盤價 and NO 收盤價 as a market-wide concept. TPEx's own
 *    published emerging tables only carry 最高/最低/均價/最近成交價 —
 *    confirmed by reading TPEx's own column headers on
 *    /zh-tw/esb/trading/info/stock-pricing.html. So Quote.open is null for
 *    every emerging stock (see types.ts — `open` is nullable precisely for
 *    this market), never a stand-in copied from another field.
 *  - The reference price a day's change is measured against is the PREVIOUS
 *    DAY'S AVERAGE PRICE (前日均價), not a previous close — TPEx computes
 *    its own published 漲跌 that way and this module matches it exactly
 *    (verified against 366 rows of a real snapshot: 0 mismatches between
 *    TradePrice - PreAverage and TPEx's own published change). Quote's field
 *    is still called `prevClose` for type compatibility with the other two
 *    markets, but `prevCloseLabel` tells the UI to display it as 前日均價.
 *  - There is NO daily price limit (漲跌幅限制) on 興櫃, so a ±30% day is
 *    normal here and would be impossible on 上市/上櫃. This is the main
 *    reason emerging stocks are deliberately kept OUT of the capped screening
 *    universe used by rankings/搜尋頁/技術訊號 (see universe.ts's
 *    capUniverse) — they would dominate every 漲跌幅 ranking on a site whose
 *    audience reads those rankings as "今天漲最多的股票".
 *  - Liquidity is thin: in a real whole-market snapshot 18 of 361 stocks had
 *    NO trade at all that day. Those are surfaced as "今日尚無成交" via
 *    Quote.priceNote with change/percent of 0 and the 前日均價 shown as the
 *    price, never as a fabricated trade.
 *
 * DATA SOURCES (all free, no key, all first-party TPEx):
 *  - mis.tpex.org.tw ("興櫃股票市況報導網站", TPEx's own real-time quote
 *    site — the 興櫃 counterpart of mis.twse.com.tw, which twse.ts/tpex.ts
 *    already rely on): Quote.asmx/GETQ20 (one symbol) and Quote.asmx/GETQ30
 *    (whole market in one request). TPEx's openapi 當日行情表 itself points
 *    at this site for "即時交易狀況", stating the openapi table is only
 *    rebuilt once a minute.
 *  - www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R: 興櫃公司基本資料
 *    (the company listing / universe).
 *  - www.tpex.org.tw/openapi/v1/t187ap05_R: 興櫃公司每月營業收入.
 *  - www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_U_ci: 興櫃公司綜合損益表
 *    (一般業) — quarterly EPS.
 *  - Charts: Yahoo's `<code>.TWO` daily bars (see fetchEmergingCandles for
 *    why that source, and for the cross-check that proved its numbers are
 *    TPEx's real ones and not synthesised).
 *
 * NOT AVAILABLE for 興櫃 at all (so the corresponding getters return
 * null/empty rather than pretending): 本益比/殖利率/股價淨值比 (TPEx
 * publishes these only for 上櫃), 三大法人買賣超, 融資融券 (興櫃 has no
 * margin trading by regulation), 每日重大訊息 openapi feed.
 */

// Same geo/CDN-split TLS problem as tpex.ts (see its TWCA_SSL_SUB_CA_PEM
// comment for the full root-cause write-up): from outside Taiwan — i.e.
// from Vercel, always — TPEx's hosts can serve a chain missing the TWCA SSL
// intermediate. Both www.tpex.org.tw (used via fetchTpexJson) and
// mis.tpex.org.tw are TPEx-operated hosts presenting TWCA certificates
// (confirmed: mis.tpex.org.tw's leaf is issued by "TWCA SSL Certification
// Authority", the very intermediate that goes missing), so this module uses
// the same additive trust fix for its own direct requests rather than
// waiting to be broken in production the way the 上櫃 build was.
const emergingHttpsAgent = new https.Agent({
  ca: [...tls.rootCertificates, TWCA_SSL_SUB_CA_PEM],
  keepAlive: true,
});

const MIS_TPEX_ORIGIN = "https://mis.tpex.org.tw";

/**
 * mis.tpex.org.tw's quote service is an ASP.NET .asmx endpoint that only
 * answers to POST with form-encoded parameters and returns XML (not JSON) —
 * unlike every other data source in this codebase. Kept as a tiny hand-rolled
 * request helper for the same reason tpex.ts hand-rolls its own: the global
 * `fetch`/undici stack gives no per-call way to supply the extra CA above.
 */
function misTpexPost(path: string, form: Record<string, string>, timeoutMs: number): Promise<string> {
  const body = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${MIS_TPEX_ORIGIN}${path}`,
      {
        method: "POST",
        agent: emergingHttpsAgent,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body).toString(),
          "User-Agent": "Mozilla/5.0 (compatible; StockRadar/1.0)",
          // This service is the backend of mis.tpex.org.tw's own pages;
          // sending the matching Referer keeps the request shaped like the
          // site's own (same approach twse.ts/tpex.ts take with MIS).
          Referer: `${MIS_TPEX_ORIGIN}/IB120STK.aspx`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`mis.tpex ${path} returned HTTP ${res.statusCode}`));
            return;
          }
          resolve(text);
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`mis.tpex request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Minimal tag reader for these small, flat, machine-generated XML payloads —
 *  no XML parser is a dependency of this project, and pulling one in for two
 *  fixed response shapes would be heavier than the job requires. */
function xmlTag(source: string, tag: string): string | undefined {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : undefined;
}

/** TPEx writes "-" (and sometimes an empty element) for "no value today" —
 *  e.g. every field of a stock that simply had no trade. Those must become
 *  undefined, never 0: a 0 here would render as a real price of NT$0. */
function emergingNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-") return undefined;
  const n = parseFloat(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * "2026/09/18" + "16:55" (the source's own trade day and statistics time, in
 * Taipei time) -> an ISO instant. Using the FEED's timestamp rather than
 * `new Date()` (which is what twse.ts/tpex.ts do) is deliberate here: an
 * emerging stock can legitimately go a whole day without a trade, so
 * "when was this data actually from" is information the user genuinely needs
 * in order to judge what they're looking at, and stamping it with the moment
 * we happened to fetch it would hide exactly that. Falls back to now only if
 * the feed's own fields are unparseable.
 */
function taipeiStampToIso(tradeDay: string | undefined, time: string | undefined): string {
  const dayMatch = tradeDay?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!dayMatch) return new Date().toISOString();
  const [, y, m, d] = dayMatch;
  const timeMatch = time?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hh = timeMatch ? pad(parseInt(timeMatch[1], 10)) : "00";
  const mm = timeMatch ? timeMatch[2] : "00";
  const ss = timeMatch?.[3] ?? "00";
  // +08:00 is Taiwan's fixed offset year-round (no DST), so this is exact.
  const iso = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`);
  return Number.isNaN(iso.getTime()) ? new Date().toISOString() : iso.toISOString();
}

/** 興櫃 codes are 4 digits (occasionally with a trailing letter for foreign
 *  issuers). The whole-market endpoint also carries 開放式基金 ("T1001Y") and
 *  黃金現貨 ("AU9901") rows, which are not stocks and must not end up in a
 *  stock universe or a stock quote map. */
function isEmergingStockCode(code: string | undefined): code is string {
  return !!code && /^\d{4}[A-Z]?$/.test(code.trim());
}

const NO_TRADE_NOTE = "今日尚無成交（興櫃是議價交易，冷門股常常整天沒有成交），顯示的是前日均價";
const PREV_CLOSE_LABEL = "前日均價";

interface EmergingQuoteParts {
  symbol: string;
  name: string;
  /** 最近一筆議價成交價；整天沒成交時 undefined。 */
  tradePrice?: number;
  /** 前日均價 —— 興櫃漲跌的計算基準（沒有「昨收」這種東西）。 */
  prevAverage?: number;
  high?: number;
  low?: number;
  /** 當日成交總股數（股，不是張——已與 TPEx 歷史行情表的「成交股數」欄位核對一致）。 */
  totalVolume?: number;
  updatedAt: string;
}

/**
 * 「今天沒有成交」在這個資料源裡有 **兩種完全不同的寫法**，必須兩種都擋掉：
 * 全市場快照（GETQ30）寫 `-`，單檔查詢（GETQ20）卻寫數字 `0` / `0.0000`
 * ——同一個交易所、同一天、同一檔股票，兩支 API 表示法不一樣。
 *
 * 這是實測抓到的真實 bug：2760 巨宇翔當天完全沒有成交，單檔查詢因此回傳
 * TradePrice=0、TradeStatisticHigh/Low=0.0000，程式若只擋 `-`，就會算出
 * 「成交價 0 元、跌幅 -100%」這種完全錯誤又嚇人的數字端到使用者面前（而且
 * 正好是本站最不能犯的那種錯：憑空生出一個不存在的價格）。股票價格不可能是
 * 0 元，所以價格類欄位一律要求「大於 0」才採用，否則視為沒有這個數字。
 * 成交量/金額則不套這條規則——那些欄位的 0 是真的 0。
 */
function positivePrice(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

function buildEmergingQuote(rawParts: EmergingQuoteParts): Quote | null {
  const parts: EmergingQuoteParts = {
    ...rawParts,
    tradePrice: positivePrice(rawParts.tradePrice),
    prevAverage: positivePrice(rawParts.prevAverage),
    high: positivePrice(rawParts.high),
    low: positivePrice(rawParts.low),
  };
  const { prevAverage, tradePrice } = parts;
  // With neither a trade nor a reference price there is genuinely nothing to
  // show — omit the stock rather than invent a number (this codebase's
  // standing rule).
  if (prevAverage == null && tradePrice == null) return null;

  const traded = tradePrice != null;
  const price = tradePrice ?? prevAverage!;
  const reference = prevAverage ?? tradePrice!;
  const change = traded && prevAverage != null ? price - prevAverage : 0;

  return {
    symbol: parts.symbol,
    market: "TW",
    name: parts.name || parts.symbol,
    price: round2(price),
    change: round2(change),
    changePercent: traded && prevAverage ? round2((change / prevAverage) * 100) : 0,
    // 興櫃 has no opening price at all (see this file's header) — null, never
    // a copy of another field.
    open: null,
    high: parts.high != null ? round2(parts.high) : null,
    low: parts.low != null ? round2(parts.low) : null,
    prevClose: round2(reference),
    volume: parts.totalVolume ?? 0,
    currency: "TWD",
    updatedAt: parts.updatedAt,
    board: "emerging",
    prevCloseLabel: PREV_CLOSE_LABEL,
    priceNote: traded ? undefined : NO_TRADE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Single-symbol real-time quote (GETQ20 — what mis.tpex.org.tw's own
 * 個股行情 page calls). Preferred over slicing the whole-market snapshot for
 * a single stock because it additionally carries the feed's own
 * TradeStatisticTime, giving an honest per-stock "as of" timestamp.
 */
export async function fetchEmergingQuote(stockNo: string): Promise<Quote> {
  const xml = await misTpexPost("/Quote.asmx/GETQ20", { SymbolID: stockNo }, 5000);
  const symbol = xmlTag(xml, "SymbolID");
  if (!symbol) throw new Error(`No emerging quote for ${stockNo}`);
  const quote = buildEmergingQuote({
    symbol,
    name: xmlTag(xml, "SymbolName") ?? stockNo,
    tradePrice: emergingNumber(xmlTag(xml, "TradePrice")),
    prevAverage: emergingNumber(xmlTag(xml, "PreAverage")),
    high: emergingNumber(xmlTag(xml, "TradeStatisticHigh")),
    low: emergingNumber(xmlTag(xml, "TradeStatisticLow")),
    totalVolume: emergingNumber(xmlTag(xml, "TradeStatisticTtlVol")),
    updatedAt: taipeiStampToIso(xmlTag(xml, "TradeDay"), xmlTag(xml, "TradeStatisticTime")),
  });
  if (!quote) throw new Error(`No emerging quote for ${stockNo}`);
  return quote;
}

/**
 * Whole-market snapshot in ONE request (GETQ30 with an empty CatID = 全部),
 * giving the same win tpex.ts gets from its own whole-market snapshot: no
 * matter how many emerging symbols the caller wants, upstream sees a single
 * call. Unlike GETQ20 this response has no per-stock time field, only a
 * market-wide TradeDay, so quotes built here are stamped with that day.
 */
export async function fetchEmergingQuotesSnapshot(): Promise<Map<string, Quote>> {
  const xml = await misTpexPost("/Quote.asmx/GETQ30", { CatID: "" }, 9000);
  const tradeDay = xmlTag(xml, "TradeDay");
  const map = new Map<string, Quote>();
  for (const [, block] of xml.matchAll(/<Q30List>([\s\S]*?)<\/Q30List>/g)) {
    const symbol = xmlTag(block, "SymbolID");
    if (!isEmergingStockCode(symbol)) continue;
    const quote = buildEmergingQuote({
      symbol: symbol.trim(),
      name: xmlTag(block, "SymbolName") ?? symbol,
      tradePrice: emergingNumber(xmlTag(block, "TradePrice")),
      prevAverage: emergingNumber(xmlTag(block, "PreAverage")),
      high: emergingNumber(xmlTag(block, "TradeStatisticHigh")),
      low: emergingNumber(xmlTag(block, "TradeStatisticLow")),
      totalVolume: emergingNumber(xmlTag(block, "TradeTtlVol")),
      updatedAt: taipeiStampToIso(tradeDay, undefined),
    });
    if (quote) map.set(quote.symbol, quote);
  }
  if (map.size === 0) throw new Error("Emerging whole-market snapshot came back empty");
  return map;
}

// ---------------------------------------------------------------------------
// Historical daily candles (for charts)
// ---------------------------------------------------------------------------

/**
 * Charts come from Yahoo's `<code>.TWO` daily bars rather than TPEx's own
 * 興櫃個股歷史行情 endpoint, and that choice was made from the data, not for
 * convenience:
 *
 * TPEx's own per-stock history
 * (`/www/zh-tw/emerging/historical?code=&date=YYYY/MM&response=json`, one
 * calendar month per call — confirmed working) publishes ONLY 成交股數/
 * 成交金額/最高/最低/均價/筆數, split across the two negotiation channels.
 * It has no open and no close, so a candle built from it could only ever be
 * a flat line at 均價 with invented open/close — precisely the fabrication
 * this codebase refuses to do.
 *
 * Yahoo, by contrast, does carry real first-trade/last-trade prices for
 * emerging stocks. Cross-checked live for 7893 睿信 across a full month
 * before adopting it: Yahoo's high, low and volume match TPEx's official
 * published figures EXACTLY, day for day (e.g. 2026/09/18 high 153 / low 148
 * / volume 9,929 shares; 2026/09/01 high 145 / low 142.5 / volume 8,531),
 * and Yahoo's close equals TPEx's own published 最近成交價 for the day (153
 * on 2026/09/18) — i.e. Yahoo is republishing TPEx's real trade data with the
 * first/last prints added, not modelling anything. Verified `7893.TW` 404s
 * while `7893.TWO` resolves, so emerging stocks live under the same `.TWO`
 * suffix Yahoo uses for 上櫃.
 *
 * Known tradeoff, recorded honestly: this is the same class of dependency as
 * the site's existing US data and TW intraday charts (an undocumented Yahoo
 * endpoint that could change without notice). If it ever breaks, emerging
 * charts degrade to "資料暫缺" — quotes, which come from TPEx directly, are
 * unaffected.
 */
export async function fetchEmergingCandles(stockNo: string, range: ChartRange): Promise<Candle[]> {
  return fetchUsCandles(`${stockNo}.TWO`, range);
}

// ---------------------------------------------------------------------------
// Monthly revenue
// ---------------------------------------------------------------------------

interface EmergingRevenueRow {
  公司代號: string;
  資料年月: string;
  "營業收入-去年同月增減(%)": string;
}

/** 興櫃公司每月營業收入彙總表. Note the endpoint name has NO `mopsfin_`
 *  prefix (it is `t187ap05_R`, not `mopsfin_t187ap05_R`) unlike its 上櫃
 *  counterpart — confirmed live; the prefixed spelling 404s. Field names are
 *  the same Chinese keys TWSE and TPEx both use. */
export async function fetchEmergingMonthlyRevenueAll(): Promise<Map<string, Earnings>> {
  const rows = await fetchTpexJson<EmergingRevenueRow[]>("https://www.tpex.org.tw/openapi/v1/t187ap05_R");
  const map = new Map<string, Earnings>();
  for (const row of rows) {
    const yoy = parseFloat(row["營業收入-去年同月增減(%)"]);
    if (!row.公司代號 || !Number.isFinite(yoy)) continue;
    const yearMonth = row.資料年月;
    const period =
      yearMonth?.length >= 5
        ? `${parseInt(yearMonth.slice(0, -2), 10) + 1911}年${parseInt(yearMonth.slice(-2), 10)}月`
        : undefined;
    map.set(row.公司代號.trim(), { monthlyRevenueYoyPercent: round2(yoy), monthlyRevenuePeriod: period });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Quarterly EPS
// ---------------------------------------------------------------------------

interface EmergingQuarterlyRow {
  年度: string;
  季別: string;
  SecuritiesCompanyCode: string;
  [key: string]: string;
}

/**
 * 興櫃公司綜合損益表(一般業). Field naming is a third variant again — this
 * one mixes CHINESE period keys (年度/季別, like TWSE) with an ENGLISH code
 * key (SecuritiesCompanyCode, like TPEx), confirmed live. EPS is located by
 * searching for a key containing 每股盈餘 rather than hardcoded, same
 * defensive approach as tpex.ts.
 *
 * Same known gap as the 上市/上櫃 equivalents: only the 一般業 statement is
 * read, so 金融業/證券期貨業/金控業/保險業/異業 emerging companies have no
 * EPS here (TPEx publishes those under separate `_U_basi`/`_U_bd`/`_U_fh`/
 * `_U_ins`/`_U_mim` endpoints). Missing EPS shows as missing, not as zero.
 */
export async function fetchEmergingQuarterlyEpsAll(): Promise<Map<string, Earnings>> {
  const rows = await fetchTpexJson<EmergingQuarterlyRow[]>(
    "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_U_ci"
  );
  const map = new Map<string, Earnings>();
  if (rows.length === 0) return map;
  const epsKey = Object.keys(rows[0]).find((k) => k.includes("每股盈餘"));
  if (!epsKey) return map;
  for (const row of rows) {
    const eps = parseFloat(row[epsKey]);
    if (!row.SecuritiesCompanyCode || !Number.isFinite(eps)) continue;
    map.set(row.SecuritiesCompanyCode.trim(), {
      quarterlyEps: round2(eps),
      quarterlyEpsPeriod: `${row.年度}年Q${row.季別}`,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Company listing / universe
// ---------------------------------------------------------------------------

interface EmergingCompanyRow {
  SecuritiesCompanyCode: string;
  CompanyAbbreviation: string;
  SecuritiesIndustryCode: string;
  "Paidin.Capital.NTDollars": string;
}

/**
 * 興櫃公司基本資料 — the official emerging-board company listing (~363
 * companies). Uses the same two-digit national industry classification table
 * as 上市/上櫃 (verified: 7893 睿信電子 = "28" -> 電子零組件業, matching the
 * industry name TPEx's own monthly-revenue feed prints for the same company),
 * so TW_INDUSTRY_NAMES is shared rather than duplicated.
 *
 * Sorted by paid-in capital descending for the same reason tpex.ts does it —
 * consistent, meaningful ordering that puts the substantial companies first —
 * even though, unlike 上櫃, emerging entries are not subject to a screening
 * cap today (see universe.ts).
 */
export async function fetchEmergingListedCompanies(): Promise<UniverseEntry[]> {
  const rows = await fetchTpexJson<EmergingCompanyRow[]>(
    "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R"
  );
  return rows
    .filter((r) => isEmergingStockCode(r.SecuritiesCompanyCode?.trim()) && r.CompanyAbbreviation)
    .sort(
      (a, b) => (parseFloat(b["Paidin.Capital.NTDollars"]) || 0) - (parseFloat(a["Paidin.Capital.NTDollars"]) || 0)
    )
    .map((r) => ({
      symbol: r.SecuritiesCompanyCode.trim(),
      market: "TW" as const,
      name: r.CompanyAbbreviation.trim(),
      sector: TW_INDUSTRY_NAMES[r.SecuritiesIndustryCode?.trim() ?? ""] ?? "未分類",
      currency: "TWD",
      exchange: "Emerging" as const,
    }));
}
