import { NextRequest, NextResponse } from "next/server";
import { sessionFrom } from "@/lib/auth/server";
import { getServerWatchlist, setServerWatchlist, watchlistSyncAvailable } from "@/lib/watchlistStore";
import type { WatchlistItem } from "@/lib/watchlist";
import { isValidSaleDate, sanitizeSales } from "@/lib/soldRecords";

// The stored value is whatever the client PUTs, so it is bounded here
// rather than trusted: without a cap a signed-in client could park an
// arbitrarily large blob in shared Redis under its own key, and every
// later GET would have to read it back.
const MAX_ITEMS = 200;
const MAX_FIELD_LENGTH = 100;

function isWatchlistItem(v: unknown): v is WatchlistItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    o.symbol.length > 0 &&
    o.symbol.length <= MAX_FIELD_LENGTH &&
    (o.market === "TW" || o.market === "US") &&
    typeof o.name === "string" &&
    o.name.length <= MAX_FIELD_LENGTH
  );
}

function finitePositive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Keeps only the recognised fields, so nothing else a client sends is persisted. */
function normalize(item: WatchlistItem): WatchlistItem {
  const sales = sanitizeSales(item.sales);
  return {
    symbol: item.symbol,
    market: item.market,
    name: item.name,
    costBasis: finitePositive(item.costBasis),
    shares: finitePositive(item.shares),
    ...(isValidSaleDate(item.buyDate) ? { buyDate: item.buyDate, buyDateSrc: item.buyDateSrc === "auto" ? "auto" : "user" } : {}),
    ...(sales.length > 0 ? { sales } : {}),
  };
}

// 以帳號內部編號（UserId）當儲存鍵；舊版 Google 登入用 email 存的資料不會自動搬移。
export async function GET(req: NextRequest) {
  const userId = sessionFrom(req)?.uid;
  if (!userId) return NextResponse.json({ error: "未登入" }, { status: 401 });
  if (!watchlistSyncAvailable) {
    return NextResponse.json({ items: [], syncAvailable: false });
  }
  const items = await getServerWatchlist(userId);
  return NextResponse.json({ items, syncAvailable: true });
}

export async function PUT(req: NextRequest) {
  const userId = sessionFrom(req)?.uid;
  if (!userId) return NextResponse.json({ error: "未登入" }, { status: 401 });
  if (!watchlistSyncAvailable) {
    return NextResponse.json({ error: "尚未設定共用儲存，無法跨裝置同步" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.items)) return NextResponse.json({ error: "格式錯誤" }, { status: 400 });
  if (body.items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `關注清單最多 ${MAX_ITEMS} 檔` }, { status: 400 });
  }
  const items: WatchlistItem[] = body.items.filter(isWatchlistItem).map(normalize);

  const ok = await setServerWatchlist(userId, items);
  if (!ok) return NextResponse.json({ error: "儲存失敗，請稍後再試" }, { status: 503 });
  return NextResponse.json({ items });
}
