import type { Market } from "@/lib/data";
import { breakEvenPrice, computeHoldingPnl, investedAmount } from "@/lib/portfolio";
import { hasHolding, hasSoldState, type BuyDateSource, type WatchlistItem } from "@/lib/watchlist";
import { isValidSaleDate, MAX_SALES_PER_ITEM, newSaleId, SALE_FIELDS, type SaleField, type SaleRecord } from "@/lib/soldRecords";

/**
 * 關注清單的匯出／匯入檔格式（純函式，不碰 DOM／localStorage，方便單元測試）。
 *
 * 編碼：匯出為 **UTF-16LE＋BOM（FF FE）、Tab 分隔**。原因（2026-10-05 使用者實際遇到）：
 * 較舊的 Excel 不認 UTF-8 BOM，會把檔案當 Big5 讀，中文全成亂碼，而且 UTF-8 多位元組被
 * 當 Big5 時會吃掉後面的引號，連欄位都會錯位。UTF-16LE＋BOM＋Tab 是 Excel 全版本雙擊都能
 * 正確開啟的格式。匯入則 UTF-16LE/BE、UTF-8（有／無 BOM）都能讀，分隔符（Tab／逗號／分號）
 * 自動判斷，所以舊版 UTF-8 逗號 CSV 也能匯入。
 *
 * 欄位：前 13 欄是給人看的表（含現價、損益等即時數字，匯入時忽略），之後 3 欄是還原用：
 *   格式版本（目前 v3）／清單順序（order）／僅關注手動排序（該市場的僅關注清單是否被手動排過，1 或空白）。
 * 沒有這 3 欄的是舊版檔，靠代碼＋名稱＋持股欄位還原，順序依檔案列順序。
 *
 * v3（2026-10-06 加「已賣出」）：多一種列「狀態＝賣出紀錄」——每筆賣出紀錄一列（同代碼同市場，一檔可多列），
 * 用最後 7 欄帶賣出日期／股數／買進價／賣出價／賣出後剩餘股數／使用者改過的欄位（日期+股數+買進價+賣出價 的子集，
 * 沒列到的是自動帶入的估計值）／已確認（1 或空白）。股票本身的那一列照舊（狀態＝持有中／已賣出／僅關注，
 * 已賣出＝持有股數 0 且購買價格保留）。v2／舊版檔沒有這些欄位，匯入時視為沒有賣出紀錄（舊檔裡的賣出價一律不存在，
 * 所以不會有「舊值被當成使用者值」的問題）。
 *
 * 買進日（2026-10-06，仍是 v3；只在最後多加 3 欄，舊檔沒有這些欄＝沒有買進日、舊版網站讀新檔會直接忽略多的欄）：
 * 「買進日期」（持有中那列，YYYY-MM-DD）、「買進日期來源」（估計＝自動記的、使用者＝親手改過）、
 * 「賣出買進日期」（賣出紀錄列，賣出當時持有那筆的買進日）。
 */

export const CSV_FORMAT_VERSION = "v3";
export const CSV_MAX_BYTES = 500 * 1024;
export const CSV_MAX_ROWS = 1000;
const SALE_ROW_STATUS = "賣出紀錄";
const BUY_DATE_SRC_CODE: Record<BuyDateSource, string> = { auto: "估計", user: "使用者" };
const FIELD_CODE: Record<SaleField, string> = { date: "日期", shares: "股數", buyPrice: "買進價", sellPrice: "賣出價" };
export const CSV_ENCODING_HINT = "無法辨識檔案編碼（可能是 Big5／ANSI 編碼的 CSV）。請改用本網站「匯出 CSV」產生的檔案，或另存為 UTF-8 CSV 後再匯入。";

const TW_SYMBOL = /^\d{4}[0-9A-Z]{0,2}$/;
const US_SYMBOL = /^[A-Z]{1,5}([.-][A-Z])?$/;

export interface WatchlistExportItem {
  market: Market;
  symbol: string;
  name: string;
  volume?: number | null;
  price?: number | null;
  changePercent?: number | null;
  costBasis?: number;
  shares?: number;
  order?: number;
  sales?: SaleRecord[];
  buyDate?: string;
  buyDateSrc?: BuyDateSource;
}

const HEADER = [
  "市場", "代碼", "名稱", "成交量", "股價", "漲跌幅(%)", "狀態",
  "持有股數", "購買價格", "損益平衡價", "投資金額", "損益", "損益(%)",
  "格式版本", "清單順序", "僅關注手動排序",
  "賣出日期", "賣出股數", "賣出買進價", "賣出價", "賣出後剩餘股數", "賣出使用者改過欄位", "賣出已確認",
  "買進日期", "買進日期來源", "賣出買進日期",
];

function cell(v: unknown): string {
  const s = String(v ?? "").replace(/[\t\r\n]+/g, " ");
  return s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 產生匯出內容（Tab 分隔、CRLF，不含 BOM；編碼交給 encodeUtf16LeWithBom）。 */
export function buildWatchlistCsv(
  items: WatchlistExportItem[],
  manualUnheld: Partial<Record<Market, boolean>>
): string {
  const rows: unknown[][] = [];
  for (const i of items) {
    const held = hasHolding(i);
    const sold = hasSoldState(i);
    const breakEven = held ? breakEvenPrice(i.costBasis!, i.shares!, i.market) : null;
    const invested = held ? investedAmount(i.costBasis!, i.shares!, i.market) : null;
    // 報價暫缺的檔股價／損益留空：空白＝沒有這筆資料，填 0 會被試算表當成真的 0。
    const { pnl, pnlPercent } =
      held && i.price != null
        ? computeHoldingPnl(i.price, i.costBasis!, i.shares!, i.market)
        : { pnl: null, pnlPercent: null };
    const mk = i.market === "TW" ? "台股" : "美股";
    rows.push([
      mk,
      i.symbol,
      i.name,
      i.volume ?? "",
      i.price ?? "",
      i.changePercent ?? "",
      held ? "持有中" : sold ? "已賣出" : "僅關注",
      held ? i.shares! : sold ? 0 : "",
      held || sold ? i.costBasis! : "",
      breakEven ?? "",
      invested ?? "",
      pnl ?? "",
      pnlPercent ?? "",
      CSV_FORMAT_VERSION,
      i.order ?? "",
      !held && manualUnheld[i.market] ? "1" : "",
      "", "", "", "", "", "", "",
      held && isValidSaleDate(i.buyDate) ? i.buyDate : "",
      held && isValidSaleDate(i.buyDate) ? BUY_DATE_SRC_CODE[i.buyDateSrc === "auto" ? "auto" : "user"] : "",
      "",
    ]);
    // 賣出紀錄一律全部匯出（含價格已清掉、目前不顯示的），往返才不會掉資料。
    for (const r of i.sales ?? []) {
      rows.push([
        mk, i.symbol, i.name, "", "", "", SALE_ROW_STATUS, "", "", "", "", "", "",
        CSV_FORMAT_VERSION, "", "",
        r.date,
        r.shares,
        r.buyPrice ?? "",
        r.sellPrice ?? "",
        r.remaining,
        SALE_FIELDS.filter((f) => r.user?.includes(f)).map((f) => FIELD_CODE[f]).join("+"),
        r.confirmed ? "1" : "",
        "", "",
        r.buyDate ?? "",
      ]);
    }
  }
  return [HEADER, ...rows].map((r) => r.map(cell).join("\t")).join("\r\n");
}

/** 字串 → UTF-16LE 位元組（開頭 FF FE）。TextEncoder 只支援 UTF-8，所以自己轉。 */
export function encodeUtf16LeWithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

export type DecodeResult = { ok: true; text: string } | { ok: false; error: string };

/** 位元組 → 文字：UTF-16LE/BE（看 BOM）、UTF-8（有／無 BOM）。其他（如 Big5）回錯誤。 */
export function decodeWatchlistFile(bytes: Uint8Array): DecodeResult {
  if (bytes.length > CSV_MAX_BYTES) {
    return { ok: false, error: `檔案太大（上限 ${Math.round(CSV_MAX_BYTES / 1024)}KB）` };
  }
  try {
    let text: string;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (text.includes("�")) return { ok: false, error: CSV_ENCODING_HINT };
    return { ok: true, text: text.replace(/^﻿/, "") };
  } catch {
    return { ok: false, error: CSV_ENCODING_HINT };
  }
}

/** 看第一行（引號外）哪個分隔符最多；平手時 Tab > 逗號 > 分號。 */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { "\t": 0, ",": 0, ";": 0 };
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && (ch === "\n" || ch === "\r")) break;
    else if (!inQuote && ch in counts) counts[ch]++;
  }
  let best = "\t";
  for (const d of ["\t", ",", ";"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/** RFC4180 風格解析（引號、雙引號跳脫、欄內換行、CRLF／LF／CR）。 */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuote = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuote = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvRowIssue {
  /** 檔案裡的列號（1 起算，含標題列） */
  line: number;
  symbol: string;
  reason: string;
}

export interface ParsedWatchlistCsv {
  items: WatchlistItem[];
  /** 各市場的僅關注清單是否要視為「手動排序過」 */
  manualUnheld: Partial<Record<Market, boolean>>;
  version: "v3" | "v2" | "legacy";
  invalid: CsvRowIssue[];
  /** 不影響匯入、但值得告知的狀況（持股資料不完整被略過、重複代碼等） */
  warnings: CsvRowIssue[];
}

export type ParseResult = ({ ok: true } & ParsedWatchlistCsv) | { ok: false; error: string };

function parseNum(raw: string, delim: string): number | null {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  if (s === "") return null;
  if (delim === ";" && /^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  s = s.replace(/(?<=\d),(?=\d{3}(\D|$))/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : null;
}

/** 檔案裡有任何一列格式版本是 v3 就是新格式。 */
function v3File(versionCells: string[]): boolean {
  return versionCells.some((v) => v.toLowerCase() === "v3");
}

function cleanName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
}

function marketFromCell(raw: string): Market | null {
  const s = raw.trim().toUpperCase();
  if (s === "台股" || s === "TW" || s === "TWSE") return "TW";
  if (s === "美股" || s === "US") return "US";
  return null;
}

const SYMBOL_HEADERS = ["代碼", "代號", "SYMBOL"];

/** 解析已解碼的文字。不信任內容：只做字串／數字處理與白名單檢查。 */
export function parseWatchlistCsv(text: string): ParseResult {
  const delim = detectDelimiter(text);
  const all = parseDelimited(text.replace(/^﻿/, ""), delim);
  const headerIdx = all.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIdx < 0) return { ok: false, error: "檔案是空的" };
  const header = all[headerIdx].map((c) => c.replace(/^﻿/, "").trim());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h.toUpperCase()));
  const cSymbol = col(SYMBOL_HEADERS);
  if (cSymbol < 0) return { ok: false, error: "找不到「代碼」欄位，這不是本網站匯出的關注清單 CSV" };
  const cMarket = col(["市場"]);
  const cName = col(["名稱"]);
  const cShares = col(["持有股數"]);
  const cCost = col(["購買價格"]);
  const cVersion = col(["格式版本"]);
  const cOrder = col(["清單順序"]);
  const cManual = col(["僅關注手動排序"]);
  const cStatus = col(["狀態"]);
  const cSaleDate = col(["賣出日期"]);
  const cSaleShares = col(["賣出股數"]);
  const cSaleBuy = col(["賣出買進價"]);
  const cSaleSell = col(["賣出價"]);
  const cSaleRemain = col(["賣出後剩餘股數"]);
  const cSaleUser = col(["賣出使用者改過欄位"]);
  const cSaleConfirmed = col(["賣出已確認"]);
  const cBuyDate = col(["買進日期"]);
  const cBuyDateSrc = col(["買進日期來源"]);
  const cSaleBuyDate = col(["賣出買進日期"]);

  const dataRows = all
    .slice(headerIdx + 1)
    .map((r, k) => ({ r, line: headerIdx + 2 + k }))
    .filter(({ r }) => r.some((c) => c.trim() !== ""));
  if (dataRows.length > CSV_MAX_ROWS) {
    return { ok: false, error: `列數太多（${dataRows.length} 列，上限 ${CSV_MAX_ROWS} 列）` };
  }

  let version: "v3" | "v2" | "legacy" = "legacy";
  if (cVersion >= 0) {
    const v = dataRows.map(({ r }) => (r[cVersion] ?? "").trim()).find((x) => x !== "") ?? CSV_FORMAT_VERSION;
    if (/^v\d+$/i.test(v) && Number(v.slice(1)) > Number(CSV_FORMAT_VERSION.slice(1))) {
      return { ok: false, error: `檔案格式版本（${v}）比本網站支援的新，請先重新整理頁面更新網站` };
    }
    version = v3File(dataRows.map(({ r }) => (r[cVersion] ?? "").trim())) ? "v3" : "v2";
  }

  const invalid: CsvRowIssue[] = [];
  const warnings: CsvRowIssue[] = [];
  const byKey = new Map<string, WatchlistItem>();
  const manualUnheld: Partial<Record<Market, boolean>> = {};
  const salesByKey = new Map<string, SaleRecord[]>();
  const saleOnlyItems = new Map<string, WatchlistItem>();

  for (const { r, line } of dataRows) {
    const symbol = (r[cSymbol] ?? "").trim().toUpperCase().replace(/^["']|["']$/g, "");
    const shown = symbol.slice(0, 12);
    if (!symbol) {
      invalid.push({ line, symbol: "", reason: "代碼是空的" });
      continue;
    }
    const declared = cMarket >= 0 ? marketFromCell(r[cMarket] ?? "") : null;
    const guessed: Market | null = TW_SYMBOL.test(symbol) ? "TW" : US_SYMBOL.test(symbol) ? "US" : null;
    const market = declared ?? guessed;
    if (!market) {
      invalid.push({
        line,
        symbol: shown,
        reason: /^\d{1,3}$/.test(symbol) ? "代號格式不符（Excel 可能吃掉了前導 0）" : "代號格式不符",
      });
      continue;
    }
    if (!(market === "TW" ? TW_SYMBOL : US_SYMBOL).test(symbol)) {
      invalid.push({ line, symbol: shown, reason: `代號格式與市場（${market === "TW" ? "台股" : "美股"}）不符` });
      continue;
    }
    const item: WatchlistItem = { symbol, market, name: (cName >= 0 ? cleanName(r[cName] ?? "") : "") || symbol };
    if (version === "v3" && cStatus >= 0 && (r[cStatus] ?? "").trim() === SALE_ROW_STATUS) {
      const date = (cSaleDate >= 0 ? r[cSaleDate] ?? "" : "").trim();
      const sShares = cSaleShares >= 0 ? parseNum(r[cSaleShares] ?? "", delim) : null;
      if (!isValidSaleDate(date) || sShares == null || sShares <= 0) {
        invalid.push({ line, symbol: shown, reason: "賣出紀錄的日期（YYYY-MM-DD）或股數不正確" });
        continue;
      }
      const userCell = cSaleUser >= 0 ? r[cSaleUser] ?? "" : "";
      const rec: SaleRecord = {
        id: newSaleId(line),
        date,
        shares: sShares,
        buyPrice: (cSaleBuy >= 0 ? parseNum(r[cSaleBuy] ?? "", delim) : null) ?? undefined,
        buyDate: cSaleBuyDate >= 0 && isValidSaleDate((r[cSaleBuyDate] ?? "").trim()) ? (r[cSaleBuyDate] ?? "").trim() : undefined,
        sellPrice: (cSaleSell >= 0 ? parseNum(r[cSaleSell] ?? "", delim) : null) ?? undefined,
        remaining: Math.max(0, (cSaleRemain >= 0 ? parseNum(r[cSaleRemain] ?? "", delim) : null) ?? 0),
        user: SALE_FIELDS.filter((f) => userCell.includes(FIELD_CODE[f])),
        confirmed: cSaleConfirmed >= 0 && (r[cSaleConfirmed] ?? "").trim() === "1" ? true : undefined,
      };
      const key = `${market}:${symbol}`;
      salesByKey.set(key, [...(salesByKey.get(key) ?? []), rec]);
      if (!saleOnlyItems.has(key)) saleOnlyItems.set(key, item);
      continue;
    }
    const shares = cShares >= 0 ? parseNum(r[cShares] ?? "", delim) : null;
    const cost = cCost >= 0 ? parseNum(r[cCost] ?? "", delim) : null;
    if (shares != null && shares > 0 && cost != null && cost >= 0) {
      item.shares = shares;
      item.costBasis = cost;
      const bd = cBuyDate >= 0 ? (r[cBuyDate] ?? "").trim() : "";
      if (isValidSaleDate(bd)) {
        item.buyDate = bd;
        item.buyDateSrc = cBuyDateSrc >= 0 && (r[cBuyDateSrc] ?? "").trim() === BUY_DATE_SRC_CODE.auto ? "auto" : "user";
      }
    } else if (version === "v3" && shares === 0 && cost != null && cost > 0) {
      // 已賣出：股數 0、購買價格保留
      item.shares = 0;
      item.costBasis = cost;
    } else if ((shares != null && shares > 0) !== (cost != null && cost > 0) && (shares != null || cost != null)) {
      warnings.push({ line, symbol: shown, reason: "持股資料不完整（只有股數或只有購買價格），僅匯入為關注" });
    }
    if (version !== "legacy" && cOrder >= 0) {
      const o = parseNum(r[cOrder] ?? "", delim);
      if (o != null && Number.isInteger(o)) item.order = o;
    }
    if (version !== "legacy" && cManual >= 0 && (r[cManual] ?? "").trim() === "1" && !hasHolding(item)) {
      manualUnheld[market] = true;
    }
    const key = `${market}:${symbol}`;
    if (byKey.has(key)) {
      warnings.push({ line, symbol: shown, reason: "代碼重複，以後面那列為準" });
      byKey.delete(key);
    }
    byKey.set(key, item);
  }

  // 賣出紀錄掛回該檔（沒有對應的股票列＝只有賣出紀錄列，也補成一檔僅關注，不丟資料）
  for (const [key, recs] of salesByKey) {
    const target = byKey.get(key) ?? saleOnlyItems.get(key)!;
    target.sales = recs.slice(0, MAX_SALES_PER_ITEM);
    if (!byKey.has(key)) byKey.set(key, target);
  }
  const items = Array.from(byKey.values());
  if (version === "legacy") {
    // 舊版檔沒有順序欄：檔案列順序就是當時畫面上的顯示順序，各組（持有／僅關注 × 市場）依列序編號，
    // 僅關注清單一併視為「已手動排序」，才不會匯入後又被打回產業排序。
    const counters = new Map<string, number>();
    for (const it of items) {
      const g = `${hasHolding(it) ? "H" : "U"}`; // 持有組不分市場（與畫面一致）
      const gk = g === "H" ? g : `${g}${it.market}`;
      const n = counters.get(gk) ?? 0;
      it.order = n;
      counters.set(gk, n + 1);
      if (g === "U") manualUnheld[it.market] = true;
    }
  }
  return { ok: true, items, manualUnheld, version, invalid, warnings };
}
