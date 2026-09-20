import type { Market } from "@/lib/data";

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
    return Array.isArray(parsed) ? parsed : [];
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

/**
 * Sets or clears the cost-basis/shares on an existing watchlist entry.
 * `undefined` for either field clears it (e.g. typing a field back to empty
 * should drop that field, not persist a stale value). A share count of 0 is
 * treated the same as clearing it — "0 shares" isn't a real position, and a
 * user expects that to mean "I no longer hold this" — which also clears the
 * now-meaningless 購買價格 along with it, rather than leaving a stale price
 * on file for a position that no longer exists. No-ops if the symbol isn't
 * actually being watched — this edits a holding, it doesn't add one.
 *
 * Filling in (or clearing) a holding can move the item between the 持有/
 * 僅關注 groups — when that happens its `order` is reset to the end of
 * whichever group it's now entering, so it doesn't carry over a position
 * that was only ever meaningful relative to its old group's siblings.
 * Staying in the same group (e.g. just correcting a typo in 購買價格)
 * leaves its existing order untouched.
 */
export function updateHolding(
  symbol: string,
  market: Market,
  holding: { costBasis?: number; shares?: number }
) {
  const list = getWatchlist();
  const idx = list.findIndex((i) => i.symbol === symbol && i.market === market);
  if (idx < 0) return;
  const next = [...list];
  const wasHeld = hasHolding(next[idx]);
  const shares = holding.shares != null && holding.shares > 0 ? holding.shares : undefined;
  const costBasis = shares != null ? holding.costBasis : undefined;
  const willBeHeld = hasHolding({ shares, costBasis });
  const order = wasHeld === willBeHeld ? next[idx].order : nextOrderFor(next, willBeHeld);
  next[idx] = { ...next[idx], costBasis, shares, order };
  save(next);
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
