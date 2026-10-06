import type { Market } from "@/lib/data";
import { computeHoldingPnl } from "@/lib/portfolio";

/**
 * 關注清單「已賣出」分組的純函式（2026-10-06 使用者要求：持有中的股數歸零→移到已賣出，
 * 用來檢討「賣掉的選擇對或不對」）。這個檔案不碰 localStorage／DOM，方便單元測試；
 * lib/watchlist.ts（儲存）、CSV 匯出入、WatchlistTable／SoldTable（畫面）、AI 的已賣出區塊
 * （ai/grounding/soldHoldings.ts）全部共用這裡同一組定義與算法。
 *
 * 損益口徑（唯一來源）：
 * - 已實現損益＝lib/portfolio.ts 的 computeHoldingPnl(賣出價, 買進價, 股數)——跟持有中的損益
 *   同一套算法（台股已計入買進手續費、賣出手續費與證交稅，各自捨去到整數元；美股不計）。
 * - 「若沒賣」損益＝同一個函式改用現價（假設現在以現價賣出、同樣扣成本），所以兩者可直接相減比較。
 * - 「賣出後漲跌%」＝(現價−賣出價)÷賣出價，純價差不扣成本（這是「賣出後股價往哪走」的直覺指標）；
 *   「若沒賣差額」＝(現價−賣出價)×股數，同樣是純價差。漲＝賣早了、跌＝賣對了。
 */

/** 一筆賣出紀錄（全部賣出或部分賣出各一筆）。 */
export interface SaleRecord {
  /** 本機產生的唯一 id（編輯／刪除用，不對外有意義） */
  id: string;
  /** 賣出日期（台北，YYYY-MM-DD） */
  date: string;
  /** 賣出股數（>0） */
  shares: number;
  /** 買進價（賣出當時的購買價格）；缺＝不知道，算不出已實現損益 */
  buyPrice?: number;
  /** 買進日期（YYYY-MM-DD，台北；賣出當時持有中那筆的買進日，緊跟著買進價保留；缺＝當時沒有記錄買進日）。 */
  buyDate?: string;
  /** 賣出價；缺＝賣出當下抓不到報價、等使用者補填 */
  sellPrice?: number;
  /** 這筆賣出之後還剩幾股（>0＝部分賣出；0＝全部賣出） */
  remaining: number;
  /**
   * 「自動記錄」那一刻的時間戳（ms）。使用者在股數欄一個數字一個數字刪改時，短時間內的連續變動
   * 合併成同一筆（見 applySharesChange）；使用者手動改過任何欄位後就清掉，之後不再合併。
   */
  autoAt?: number;
  /**
   * 使用者親手改過的欄位（2026-10-06 追加規格：「以我改完後的數值為準，改前的可能數值會是錯的」）。
   * 沒列在這裡的欄位＝自動帶入的估計值（賣出價＝記錄當下的現價、日期＝台北今天、股數＝歸零前差額、
   * 買進價＝當時購買價格）；任何自動流程（連續改股數合併、改日期重抓收盤價、補現價）都不可覆蓋
   * 列在這裡的欄位。
   */
  user?: SaleField[];
  /** 使用者按了「確認」（或四個欄位都親手改過）→ 已確認，估計提示消失。 */
  confirmed?: boolean;
}

export type SaleField = "date" | "shares" | "buyPrice" | "sellPrice";
export const SALE_FIELDS: SaleField[] = ["date", "shares", "buyPrice", "sellPrice"];

export function isUserField(rec: Pick<SaleRecord, "user">, f: SaleField): boolean {
  return rec.user?.includes(f) === true;
}

/** 已確認＝使用者按過確認，或四個欄位都親手改過；已確認的紀錄才算「可信數字」。 */
export function isSaleConfirmed(rec: Pick<SaleRecord, "user" | "confirmed">): boolean {
  return rec.confirmed === true || SALE_FIELDS.every((f) => isUserField(rec, f));
}

/** 還有沒被使用者確認的（自動帶入）欄位。 */
export function autoFieldsOf(rec: Pick<SaleRecord, "user">): SaleField[] {
  return SALE_FIELDS.filter((f) => !isUserField(rec, f));
}

export const SALE_ESTIMATE_NOTE = "賣出價為當下現價估計，請改成實際成交價";

/** 連續改股數時合併成同一筆賣出紀錄的時間窗。 */
export const SALE_COALESCE_MS = 30_000;
/** 每檔最多保留幾筆賣出紀錄（防止 localStorage／同步資料無限長大）。 */
export const MAX_SALES_PER_ITEM = 50;

export const SALE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidSaleDate(s: unknown): s is string {
  if (typeof s !== "string" || !SALE_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 整理從 localStorage／CSV／伺服器讀回來的資料：丟掉不合格的、補齊必要欄位、限制筆數。 */
export function sanitizeSales(raw: unknown): SaleRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: SaleRecord[] = [];
  for (const r of raw.slice(0, MAX_SALES_PER_ITEM)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!isValidSaleDate(o.date)) continue;
    if (typeof o.shares !== "number" || !Number.isFinite(o.shares) || o.shares <= 0) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    out.push({
      id: typeof o.id === "string" && o.id.length > 0 && o.id.length <= 40 ? o.id : newSaleId(out.length),
      date: o.date,
      shares: o.shares,
      buyPrice: num(o.buyPrice),
      buyDate: isValidSaleDate(o.buyDate) ? o.buyDate : undefined,
      sellPrice: num(o.sellPrice),
      remaining: num(o.remaining) ?? 0,
      autoAt: typeof o.autoAt === "number" && Number.isFinite(o.autoAt) ? o.autoAt : undefined,
      user: Array.isArray(o.user) ? SALE_FIELDS.filter((f) => (o.user as unknown[]).includes(f)) : undefined,
      confirmed: o.confirmed === true ? true : undefined,
    });
  }
  return out;
}

let idCounter = 0;
export function newSaleId(salt: number = 0): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}${salt.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

interface HoldingState {
  shares?: number;
  costBasis?: number;
  /** 持有中那筆的買進日（賣出時連同買進價記進賣出紀錄） */
  buyDate?: string;
  sales?: SaleRecord[];
}

/**
 * 股數從 prevShares 變成 newShares 時，回傳更新後的賣出紀錄陣列。
 * - 減少（newShares < prevShares）：新增一筆（全部賣出＝remaining 0；部分賣出＝remaining>0），
 *   賣出價預設為 ctx.price（抓不到就留空）、日期為 ctx.today、買進價為歸零前的購買價格。
 * - 若上一筆是 SALE_COALESCE_MS 內自動記下、且剩餘股數正好等於目前股數（＝同一輪連續編輯），
 *   改成「調整那一筆」而不是再開新的：一個數字一個數字刪、或先降再升回來都不會留下零碎紀錄；
 *   股數回到或超過原本（>= 該筆賣出前的股數）就把那筆整個拿掉。
 * - 增加或不變、且沒有可合併的紀錄：原樣回傳。
 */
export function applySharesChange(
  state: HoldingState,
  newShares: number,
  ctx: { price?: number | null; today: string; now: number }
): SaleRecord[] {
  const sales = state.sales ?? [];
  const prev = state.shares != null && state.shares > 0 ? state.shares : 0;
  const last = sales[sales.length - 1];
  if (last?.autoAt != null && ctx.now - last.autoAt <= SALE_COALESCE_MS && last.remaining === prev && newShares !== prev) {
    const original = last.shares + last.remaining;
    const sold = original - newShares;
    if (sold <= 0) return sales.slice(0, -1);
    const price = last.sellPrice ?? (ctx.price != null && ctx.price > 0 ? ctx.price : undefined);
    return [...sales.slice(0, -1), { ...last, shares: sold, remaining: newShares, sellPrice: price }];
  }
  if (prev > 0 && newShares < prev) {
    const rec: SaleRecord = {
      id: newSaleId(sales.length),
      date: ctx.today,
      shares: prev - newShares,
      buyPrice: state.costBasis != null && state.costBasis > 0 ? state.costBasis : undefined,
      buyDate: isValidSaleDate(state.buyDate) ? state.buyDate : undefined,
      sellPrice: ctx.price != null && ctx.price > 0 ? ctx.price : undefined,
      remaining: newShares,
      autoAt: ctx.now,
    };
    return [...sales, rec].slice(-MAX_SALES_PER_ITEM);
  }
  return sales;
}

export type SaleVerdict = "early" | "right" | "flat";

export interface SaleMetrics {
  /** 已實現損益（金額，已扣交易成本）；缺買進價或賣出價＝null */
  realizedPnl: number | null;
  realizedPct: number | null;
  /** 賣出後漲跌%（現價相對賣出價，純價差）；缺現價或賣出價＝null */
  afterSellPct: number | null;
  /** 若沒賣的價差金額＝(現價−賣出價)×股數（純價差） */
  heldDiff: number | null;
  /** 若沒賣、以現價賣出的損益（已扣交易成本，與 realizedPnl 同口徑） */
  ifHeldPnl: number | null;
  ifHeldPct: number | null;
  /** 賣早了（賣出後漲）／賣對了（賣出後跌）／持平 */
  verdict: SaleVerdict | null;
  /** 賣出至今天數（日曆天；日期不合格＝null） */
  days: number | null;
}

/** 依賣出日期決定抓多長的日K（getChart 的 range，剛好涵蓋到賣出日）。 */
export function chartRangeForDate(saleDate: string, today: string): "1m" | "3m" | "6m" | "1y" | "2y" | "5y" | "10y" {
  const d = daysBetween(saleDate, today) ?? 0;
  if (d <= 22) return "1m";
  if (d <= 80) return "3m";
  if (d <= 170) return "6m";
  if (d <= 350) return "1y";
  if (d <= 700) return "2y";
  if (d <= 1750) return "5y";
  return "10y";
}

/** 賣出日（含）之前最近一個交易日的收盤價；日K 沒涵蓋到、或賣出日在最早一根 K 之前＝null。 */
export function closeOnOrBefore(candles: { time: string; close: number }[], saleDate: string): { close: number; day: string } | null {
  let best: { close: number; day: string } | null = null;
  for (const c of candles) {
    const day = c.time.slice(0, 10);
    if (day <= saleDate && c.close > 0 && (!best || day > best.day)) best = { close: c.close, day };
  }
  if (!best) return null;
  // 賣出日距最近一根 K 超過 10 天＝日K 很可能沒涵蓋到那段，不冒用。
  const gap = daysBetween(best.day, saleDate);
  return gap != null && gap <= 10 ? best : null;
}

export function daysBetween(fromDay: string, toDay: string): number | null {
  if (!isValidSaleDate(fromDay) || !isValidSaleDate(toDay)) return null;
  const a = new Date(`${fromDay}T00:00:00Z`).getTime();
  const b = new Date(`${toDay}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** 賣出後漲跌的文字判定：漲＝賣早了、跌＝賣對了（0.005% 以內視為持平）。 */
export function saleVerdictOf(afterSellPct: number | null): SaleVerdict | null {
  if (afterSellPct == null) return null;
  if (Math.abs(afterSellPct) < 0.005) return "flat";
  return afterSellPct > 0 ? "early" : "right";
}

export const SALE_VERDICT_LABEL: Record<SaleVerdict, string> = { early: "賣早了", right: "賣對了", flat: "持平" };

export function computeSaleMetrics(
  rec: Pick<SaleRecord, "date" | "shares" | "buyPrice" | "sellPrice">,
  price: number | null | undefined,
  market: Market,
  today: string
): SaleMetrics {
  const sell = rec.sellPrice != null && rec.sellPrice > 0 ? rec.sellPrice : null;
  const buy = rec.buyPrice != null && rec.buyPrice >= 0 ? rec.buyPrice : null;
  const cur = price != null && price > 0 ? price : null;
  const realized = sell != null && buy != null ? computeHoldingPnl(sell, buy, rec.shares, market) : null;
  const ifHeld = cur != null && buy != null ? computeHoldingPnl(cur, buy, rec.shares, market) : null;
  const afterSellPct = sell != null && cur != null ? ((cur - sell) / sell) * 100 : null;
  return {
    realizedPnl: realized?.pnl ?? null,
    realizedPct: realized?.pnlPercent ?? null,
    afterSellPct,
    heldDiff: sell != null && cur != null ? (cur - sell) * rec.shares : null,
    ifHeldPnl: ifHeld?.pnl ?? null,
    ifHeldPct: ifHeld?.pnlPercent ?? null,
    verdict: saleVerdictOf(afterSellPct),
    days: daysBetween(rec.date, today),
  };
}

/** 排序：賣出日期新→舊；同日依代號、再依原本順序。 */
export function sortSalesNewestFirst<T extends { date: string }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.date < b.r.date ? 1 : a.r.date > b.r.date ? -1 : a.i - b.i))
    .map((x) => x.r);
}

/** 評等紀錄裡跟賣出日有關的最小欄位（RatingLogEntry 的子集）。 */
export interface RatingAtSaleEntry {
  symbol: string;
  day: string;
  at: string;
  label: string;
  holdingLabel: string;
}

/** 賣出日當天、或之前最近一筆的本站評等；都沒有＝null（畫面顯示「無紀錄」）。同一天取最後一筆。 */
export function pickRatingAtSale<T extends RatingAtSaleEntry>(entries: T[], symbol: string, saleDate: string): T | null {
  const sym = symbol.toUpperCase();
  let best: T | null = null;
  for (const e of entries) {
    if (e.symbol.toUpperCase() !== sym || e.day > saleDate) continue;
    if (!best || e.day > best.day || (e.day === best.day && e.at > best.at)) best = e;
  }
  return best;
}

/** 往前最多找幾天（日曆天）的評等紀錄。 */
export const SALE_RATING_LOOKBACK_DAYS = 10;
/** 本站評等紀錄從這天開始才有（更早的賣出一律「無紀錄」，不去打 API）。 */
export const RATING_LOG_START_DAY = "2026-10-05";

export function ratingWindowFor(saleDate: string): { from: string; to: string } {
  const from = new Date(new Date(`${saleDate}T00:00:00Z`).getTime() - SALE_RATING_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { from: from < RATING_LOG_START_DAY ? RATING_LOG_START_DAY : from, to: saleDate };
}

/** 是否可能有紀錄（賣出日在評等紀錄開始日之後）。 */
export function mayHaveRatingLog(saleDate: string): boolean {
  return saleDate >= RATING_LOG_START_DAY;
}

/** 這檔目前是否要在「已賣出」分組顯示賣出紀錄：必須還有購買價格（價格清掉＝回到未持有，紀錄保留但不顯示）。 */
export function visibleSales(item: { costBasis?: number; sales?: SaleRecord[] }): SaleRecord[] {
  return item.costBasis != null && item.costBasis > 0 && item.sales && item.sales.length > 0 ? item.sales : [];
}
