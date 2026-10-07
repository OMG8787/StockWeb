import { getStore, type Row } from "@/lib/auth/store";
import { taipeiNow } from "@/lib/auth/accounts";
import { hasHolding, watchGroupOf, type WatchlistItem } from "@/lib/watchlist";
import { isValidSaleDate, sanitizeSales } from "@/lib/soldRecords";

/**
 * 每個帳號的關注清單與庫存（持股、成本、買進日、賣出紀錄），存在帳號同一份 Google 試算表的
 * Holdings 分頁，一檔股票一列（2026-10-07 使用者要求「記錄帳戶存股狀況在試算表、關注清單跟庫存
 * 綁定帳號」；原本存 Redis `watchlist:<email>`）。瀏覽器 localStorage 仍是畫面讀寫的地方，
 * WatchlistSync 負責登入時合併、之後有變動就整份推上來。
 */
export const watchlistSyncAvailable = true;

const STATUS_LABEL = { held: "持有中", watch: "關注", sold: "已賣出" } as const;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toItem(r: Row): WatchlistItem | null {
  if (!r.Symbol || (r.Market !== "TW" && r.Market !== "US")) return null;
  let sales: WatchlistItem["sales"];
  try {
    sales = r.Sales ? sanitizeSales(JSON.parse(r.Sales)) : undefined;
  } catch {
    sales = undefined;
  }
  const order = num(r.Order);
  return {
    symbol: r.Symbol,
    market: r.Market,
    name: r.StockName ?? "",
    costBasis: num(r.CostBasis),
    shares: num(r.Shares),
    ...(order !== undefined ? { order } : {}),
    ...(isValidSaleDate(r.BuyDate) ? { buyDate: r.BuyDate, buyDateSrc: r.BuyDateSrc === "auto" ? "auto" : "user" } : {}),
    ...(sales && sales.length > 0 ? { sales } : {}),
  };
}

function toRow(item: WatchlistItem, owner: { userId: string; account: string; name: string }, now: string): Row {
  const group = watchGroupOf(item);
  return {
    ID: `${owner.userId}:${item.market}:${item.symbol}`,
    Account: owner.account,
    UserName: owner.name,
    Market: item.market,
    Symbol: item.symbol,
    StockName: item.name,
    HoldStatus: hasHolding(item) ? STATUS_LABEL.held : STATUS_LABEL[group === "sold" ? "sold" : "watch"],
    Shares: item.shares !== undefined ? String(item.shares) : "",
    CostBasis: item.costBasis !== undefined ? String(item.costBasis) : "",
    BuyDate: item.buyDate ?? "",
    SalesCount: item.sales?.length ? String(item.sales.length) : "",
    UpdatedAt: now,
    BuyDateSrc: item.buyDate ? (item.buyDateSrc ?? "user") : "",
    Order: item.order !== undefined ? String(item.order) : "",
    Sales: item.sales?.length ? JSON.stringify(item.sales) : "",
    UserId: owner.userId,
  };
}

export async function getServerWatchlist(userId: string): Promise<WatchlistItem[]> {
  const [rows] = (await getStore().batch([{ op: "read", table: "Holdings" }])) as Row[][];
  return rows
    .filter((r) => r.UserId === userId)
    .map(toItem)
    .filter((x): x is WatchlistItem => x !== null);
}

export async function setServerWatchlist(
  owner: { userId: string; account: string; name: string },
  items: WatchlistItem[],
): Promise<boolean> {
  const now = taipeiNow();
  await getStore().batch([
    { op: "replaceWhere", table: "Holdings", col: "UserId", value: owner.userId, rows: items.map((i) => toRow(i, owner, now)) },
  ]);
  return true;
}
