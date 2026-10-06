import type { Market } from "@/lib/data";
import { applySharesChange, isUserField, isValidSaleDate, sanitizeSales, SALE_FIELDS, type SaleField, type SaleRecord } from "@/lib/soldRecords";
import { taipeiDayKey } from "@/lib/pollingSchedule";

export interface WatchlistItem {
  symbol: string;
  market: Market;
  name: string;
  /** Average cost per share, in the stock's own currency (TWD for TW, USD for US). Optional — a plain watch-only entry has neither this nor `shares`. */
  costBasis?: number;
  /** Shares held, in the same per-share unit the quote price is already denominated in (not 張). */
  shares?: number;
  /** Manual drag-and-drop position, relative only to other items in the same
   *  group (see `hasHolding` below) — a held item's order is never compared
   *  against a watch-only item's. Missing/undefined sorts as 0, which keeps
   *  pre-existing entries (added before this field existed) in their
   *  original insertion order until the user actually drags something. */
  order?: number;
  /**
   * 賣出紀錄（2026-10-06「已賣出」分組）：持有中的股數歸零或減少時自動記下，也可在網站上修改／刪除。
   * 購買價格被清掉（回到未持有）時紀錄仍保留在資料裡，只是不顯示（見 soldRecords.visibleSales）。
   */
  sales?: SaleRecord[];
}

/** An entry counts as "held" once it has a real (>0) share count and a cost
 *  basis on file — a plain watch-only entry has neither. Shares must be
 *  strictly positive, not just present: a user reported setting 持有股數
 *  back to 0 and expecting that to mean "I don't hold this anymore", and a
 *  0 share count can never itself be a real position. This is the single
 *  definition of the 持有/僅關注 split used both to decide which of the two
 *  drag-and-drop groups an item renders in and to auto-move it between them
 *  the moment its holding info is filled in or cleared. */
export function hasHolding(item: Pick<WatchlistItem, "costBasis" | "shares">): boolean {
  return item.costBasis != null && item.shares != null && item.shares > 0;
}

/**
 * 「已賣出」狀態（2026-10-06 使用者要求）：股數被明確改成 0、購買價格仍保留（>0）、且有賣出紀錄。
 * 三組的唯一定義：持有中＝hasHolding；已賣出＝hasSoldState；其餘＝僅關注（未持有）。
 * 價格也清掉（或清成 0）→ 不再符合，回到未持有；已賣出的股數再改成 >0 → 回到持有中。
 */
export function hasSoldState(item: Pick<WatchlistItem, "costBasis" | "shares" | "sales">): boolean {
  return item.shares === 0 && item.costBasis != null && item.costBasis > 0 && (item.sales?.length ?? 0) > 0;
}

export type WatchGroup = "held" | "sold" | "unheld";
export function watchGroupOf(item: Pick<WatchlistItem, "costBasis" | "shares" | "sales">): WatchGroup {
  return hasHolding(item) ? "held" : hasSoldState(item) ? "sold" : "unheld";
}

const STORAGE_KEY = "stockradar:watchlist";
export const WATCHLIST_CHANGED_EVENT = "stockradar:watchlist-changed";

/**
 * 「僅關注（未持有）」那一組有沒有被使用者親手排過順序，依市場分開記錄
 * （`{"TW":true,"US":true}`）。
 *
 * 為什麼需要這個旗標：`order` 欄位本身分不出「使用者刻意排成這樣」跟
 * 「只是照加入清單的先後自動編號」——每檔新加入的股票都會拿到一個 order
 * （見 nextOrderFor），所以光看 order 有沒有值是問不出答案的。有了這個旗標，
 * 僅關注清單才能做到使用者要的行為：**還沒手動排過就預設依細分產業分組排列**
 * （見 lib/fineIndustry.ts），**一旦手動拖曳過就完全尊重使用者排的順序**，
 * 不會每次重新整理又被打回產業排序。
 *
 * 刻意存在跟清單本身不同的 key：它是「這台裝置上的排序偏好」，不是清單資料的
 * 一部分，所以登入後跟伺服器同步清單（replaceWatchlist）時不會被覆蓋，也不會
 * 因為同步進來別台裝置的清單就莫名其妙變成「排過了」。
 *
 * 依市場分開的理由：台股/美股是兩個分頁、兩張表，在台股那張表拖曳不該讓美股
 * 那張表跟著從產業排序切換成別的順序（使用者會覺得自己沒碰過的清單無故重排）。
 */
const UNHELD_MANUAL_ORDER_KEY = "stockradar:watchlist-unheld-manual-order";

function readManualOrderFlags(): Partial<Record<Market, boolean>> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UNHELD_MANUAL_ORDER_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 讀出各市場的「僅關注手動排序」旗標（匯出／備份用）。 */
export function getManualUnheldOrderFlags(): Partial<Record<Market, boolean>> {
  return { ...readManualOrderFlags() };
}

/** 整組覆寫旗標（匯入／復原用）。不發事件——呼叫端緊接著 replaceWatchlist 會發。 */
export function setManualUnheldOrderFlags(flags: Partial<Record<Market, boolean>>): void {
  try {
    window.localStorage.setItem(UNHELD_MANUAL_ORDER_KEY, JSON.stringify(flags));
  } catch {
    // localStorage 不可用——維持原狀
  }
}

/** 這個市場的「僅關注」清單是否已被使用者手動排過（拖曳或按過排序按鈕）。 */
export function hasManualUnheldOrder(market: Market): boolean {
  return readManualOrderFlags()[market] === true;
}

/** 記下「使用者親手排過這個市場的僅關注清單」，之後一律照 `order` 顯示。 */
export function markManualUnheldOrder(market: Market): void {
  try {
    window.localStorage.setItem(
      UNHELD_MANUAL_ORDER_KEY,
      JSON.stringify({ ...readManualOrderFlags(), [market]: true })
    );
    window.dispatchEvent(new Event(WATCHLIST_CHANGED_EVENT));
  } catch {
    // localStorage 不可用（無痕模式/被封鎖）——就當作沒排過，維持產業排序即可
  }
}

function safeParse(raw: string | null): WatchlistItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WatchlistItem[]).map(normalizeItemSales) : [];
  } catch {
    return [];
  }
}

// Cache the parsed list keyed by the raw string, so repeated calls return
// the same array reference when storage hasn't actually changed — required
// for useSyncExternalStore, which otherwise treats a fresh reference as a
// change on every render and can loop.
let cachedRaw: string | null = null;
let cachedList: WatchlistItem[] = [];

export function getWatchlist(): WatchlistItem[] {
  if (typeof window === "undefined") return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = safeParse(raw);
  }
  return cachedList;
}

function save(items: WatchlistItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new Event(WATCHLIST_CHANGED_EVENT));
  } catch {
    // localStorage unavailable (private mode, blocked) — fail silently
  }
}

export function isWatched(symbol: string, market: Market): boolean {
  return getWatchlist().some((i) => i.symbol === symbol && i.market === market);
}

/** Lowest `order` that puts a new entry after every existing item in the
 *  same group (held vs. watch-only) — 0 when the group is currently empty. */
function nextOrderFor(list: WatchlistItem[], held: boolean): number {
  const siblings = list.filter((i) => hasHolding(i) === held);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((i) => i.order ?? 0)) + 1;
}

export function toggleWatch(item: WatchlistItem): boolean {
  const list = getWatchlist();
  const idx = list.findIndex((i) => i.symbol === item.symbol && i.market === item.market);
  if (idx >= 0) {
    const next = [...list];
    next.splice(idx, 1);
    save(next);
    return false;
  }
  // A freshly-starred stock never arrives with holding info already filled
  // in, so it always starts in the watch-only group.
  save([...list, { ...item, order: nextOrderFor(list, false) }]);
  return true;
}

/** Overwrites the whole list — used when merging in a signed-in account's server-side watchlist. */
export function replaceWatchlist(items: WatchlistItem[]) {
  save(items);
}

export interface HoldingUpdateContext {
  /** 股數減少時要記成賣出價的即時報價；抓不到（null／undefined）就留空等使用者補填。 */
  price?: number | null;
  /** 台北今天（YYYY-MM-DD），預設現在；測試用。 */
  today?: string;
  /** 現在時間（ms），預設 Date.now()；測試用。 */
  now?: number;
}

/**
 * updateHolding 的純函式版本（不碰 localStorage，單元測試用）：回傳更新後的整份清單；
 * 找不到該檔就原樣回傳同一個陣列。
 *
 * 規則（2026-10-06 加入「已賣出」）：
 * - 股數 >0：持有中（購買價格照填；沒填價格＝尚未算持有）。
 * - 股數明確 0：購買價格仍 >0 → 保留股數 0 與價格＝已賣出（有賣出紀錄才顯示在已賣出分組）；
 *   價格也空白／0 → 整檔清空回到未持有（賣出紀錄保留在資料裡，但價格再填回去前不顯示）。
 * - 股數空白（undefined）：視為整個清空（跟過去一樣連購買價格一起清），不記賣出。
 * - 股數從 N 減少到 M（含 0）：新增（或合併）一筆賣出紀錄，見 soldRecords.applySharesChange。
 * 換組（持有中／已賣出／未持有）時 `order` 重排到新組最後，同組內改價格不動順序。
 */
export function applyHoldingUpdate(
  list: WatchlistItem[],
  symbol: string,
  market: Market,
  holding: { costBasis?: number; shares?: number },
  ctx: HoldingUpdateContext = {}
): WatchlistItem[] {
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0) return list;
  const next = [...list];
  const prev = next[idx];
  const wasGroup = watchGroupOf(prev);
  const hasPositiveCost = holding.costBasis != null && holding.costBasis > 0;

  let shares: number | undefined;
  let costBasis: number | undefined;
  if (holding.shares != null && holding.shares > 0) {
    shares = holding.shares;
    costBasis = holding.costBasis;
  } else if (holding.shares === 0 && hasPositiveCost) {
    shares = 0;
    costBasis = holding.costBasis;
  } else {
    shares = undefined;
    costBasis = undefined;
  }

  // 賣出紀錄：股數從正數降下來（含歸零，連同「價格也一起清掉」的情況）才記。
  const newSharesForSale = holding.shares != null && holding.shares >= 0 ? holding.shares : null;
  let sales = prev.sales;
  if (newSharesForSale != null) {
    const updated = applySharesChange(
      { shares: prev.shares, costBasis: prev.costBasis, sales: prev.sales },
      newSharesForSale,
      { price: ctx.price, today: ctx.today ?? taipeiDayKey(), now: ctx.now ?? Date.now() }
    );
    if (updated !== (prev.sales ?? [])) sales = updated;
  }

  const draft: WatchlistItem = { ...prev, costBasis, shares, order: prev.order };
  if (sales !== undefined) draft.sales = sales;
  if (draft.sales && draft.sales.length === 0) delete draft.sales;
  const willGroup = watchGroupOf(draft);
  // 持有中組與其他組分開排序（跟過去一樣）；已賣出／未持有共用「非持有」的 order 空間。
  const order = (wasGroup === "held") === (willGroup === "held") ? prev.order : nextOrderFor(next, willGroup === "held");
  next[idx] = { ...draft, order };
  return next;
}

/**
 * Sets or clears the cost-basis/shares on an existing watchlist entry
 * (規則見 applyHoldingUpdate)。No-ops if the symbol isn't actually being
 * watched — this edits a holding, it doesn't add one. `ctx.price` 是股數
 * 減少時要記成賣出價的即時報價（呼叫端手上有報價就傳）。
 */
export function updateHolding(
  symbol: string,
  market: Market,
  holding: { costBasis?: number; shares?: number },
  ctx: HoldingUpdateContext = {}
) {
  const list = getWatchlist();
  const next = applyHoldingUpdate(list, symbol, market, holding, ctx);
  if (next !== list) save(next);
}

export interface SalePatch {
  date?: string;
  shares?: number;
  buyPrice?: number | null;
  sellPrice?: number | null;
}

/** 純函式版：修改某一筆賣出紀錄（欄位 null＝清空；日期／股數不合格的欄位忽略）。改過的欄位記為 user（之後任何自動流程都不可覆蓋）；手動改過就不再被自動合併。 */
export function applySalePatch(list: WatchlistItem[], symbol: string, market: Market, saleId: string, patch: SalePatch): WatchlistItem[] {
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0) return list;
  const sales = list[idx].sales ?? [];
  const sIdx = sales.findIndex((s) => s.id === saleId);
  if (sIdx < 0) return list;
  const cur = sales[sIdx];
  const rec: SaleRecord = { ...cur, autoAt: undefined };
  const user = new Set<SaleField>(cur.user ?? []);
  if (patch.date !== undefined && isValidSaleDate(patch.date)) {
    rec.date = patch.date;
    user.add("date");
  }
  if (patch.shares !== undefined && Number.isFinite(patch.shares) && patch.shares > 0) {
    rec.shares = patch.shares;
    user.add("shares");
  }
  if (patch.buyPrice !== undefined) {
    rec.buyPrice = patch.buyPrice != null && Number.isFinite(patch.buyPrice) && patch.buyPrice >= 0 ? patch.buyPrice : undefined;
    // 清空＝回到「沒有值」，不算使用者確認過的數字
    if (rec.buyPrice != null) user.add("buyPrice");
    else user.delete("buyPrice");
  }
  if (patch.sellPrice !== undefined) {
    rec.sellPrice = patch.sellPrice != null && Number.isFinite(patch.sellPrice) && patch.sellPrice >= 0 ? patch.sellPrice : undefined;
    if (rec.sellPrice != null) user.add("sellPrice");
    else user.delete("sellPrice");
  }
  rec.user = SALE_FIELDS.filter((f) => user.has(f));
  const nextSales = [...sales];
  nextSales[sIdx] = rec;
  const next = [...list];
  next[idx] = { ...list[idx], sales: nextSales };
  return next;
}

/**
 * 純函式版：自動流程（改日期後重抓收盤價）要補賣出價時用。**只有賣出價不是使用者填的、且日期仍是當初要查的那天**
 * 才會寫入；使用者的值一律不動（競態保護：重抓期間使用者又改了價或日期，這次結果作廢）。
 */
export function applyAutoSellPrice(
  list: WatchlistItem[],
  symbol: string,
  market: Market,
  saleId: string,
  price: number,
  forDate: string
): WatchlistItem[] {
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0 || !(price > 0)) return list;
  const sales = list[idx].sales ?? [];
  const sIdx = sales.findIndex((s) => s.id === saleId);
  if (sIdx < 0) return list;
  const cur = sales[sIdx];
  if (isUserField(cur, "sellPrice") || cur.date !== forDate || cur.sellPrice === price) return list;
  const nextSales = [...sales];
  nextSales[sIdx] = { ...cur, sellPrice: price, autoAt: undefined };
  const next = [...list];
  next[idx] = { ...list[idx], sales: nextSales };
  return next;
}

/** 純函式版：使用者按「確認」＝這筆的數字就以現在畫面為準（需要有賣出價才能確認）。 */
export function applySaleConfirm(list: WatchlistItem[], symbol: string, market: Market, saleId: string): WatchlistItem[] {
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0) return list;
  const sales = list[idx].sales ?? [];
  const sIdx = sales.findIndex((s) => s.id === saleId);
  if (sIdx < 0 || sales[sIdx].sellPrice == null || sales[sIdx].confirmed === true) return list;
  const nextSales = [...sales];
  nextSales[sIdx] = { ...sales[sIdx], confirmed: true, autoAt: undefined };
  const next = [...list];
  next[idx] = { ...list[idx], sales: nextSales };
  return next;
}

export function confirmSale(symbol: string, market: Market, saleId: string) {
  const list = getWatchlist();
  const next = applySaleConfirm(list, symbol, market, saleId);
  if (next !== list) save(next);
}

export function setAutoSellPrice(symbol: string, market: Market, saleId: string, price: number, forDate: string) {
  const list = getWatchlist();
  const next = applyAutoSellPrice(list, symbol, market, saleId, price, forDate);
  if (next !== list) save(next);
}

export function updateSale(symbol: string, market: Market, saleId: string, patch: SalePatch) {
  const list = getWatchlist();
  const next = applySalePatch(list, symbol, market, saleId, patch);
  if (next !== list) save(next);
}

/** 純函式版：刪除一筆賣出紀錄。 */
export function applySaleDelete(list: WatchlistItem[], symbol: string, market: Market, saleId: string): WatchlistItem[] {
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0 || !(list[idx].sales ?? []).some((s) => s.id === saleId)) return list;
  const next = [...list];
  const sales = (list[idx].sales ?? []).filter((s) => s.id !== saleId);
  const { sales: _drop, ...rest } = list[idx];
  void _drop;
  next[idx] = sales.length > 0 ? { ...rest, sales } : rest;
  return next;
}

export function deleteSale(symbol: string, market: Market, saleId: string) {
  const list = getWatchlist();
  const next = applySaleDelete(list, symbol, market, saleId);
  if (next !== list) save(next);
}

/** 讀回來的清單做一次整理（賣出紀錄欄位檢查）；沒有 sales 的項目原樣不動。 */
export function normalizeItemSales(item: WatchlistItem): WatchlistItem {
  if (item.sales === undefined) return item;
  const sales = sanitizeSales(item.sales);
  const { sales: _drop, ...rest } = item;
  void _drop;
  return sales.length > 0 ? { ...rest, sales } : rest;
}

/**
 * Persists a new relative order for a set of items that all belong to the
 * same group (all held, or all watch-only) — called once a drag-and-drop
 * reorder gesture ends. Items not included keep their existing order;
 * mixing items from both groups into one call would incorrectly compare
 * their positions against each other, so callers must only ever pass one
 * group's items at a time.
 */
export function reorderGroup(orderedItems: WatchlistItem[]): void {
  const list = getWatchlist();
  const next = [...list];
  orderedItems.forEach((item, index) => {
    const idx = next.findIndex((i) => i.symbol === item.symbol && i.market === item.market);
    if (idx >= 0) next[idx] = { ...next[idx], order: index };
  });
  save(next);
}
