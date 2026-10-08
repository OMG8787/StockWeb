import { fetchMisRows, misTradeTimeIso } from "./twse";

/**
 * 台股即時五檔（2026-10-08 使用者要求：當沖很短暫，五檔要每 5 秒刷新）。
 * 資料來源跟報價一樣是證交所 MIS（上市 tse_、上櫃 otc_ 同一支 API）：
 * b／g＝委買價／委買量（張），a／f＝委賣價／委賣量，各最多 5 檔、以 "_" 分隔，第一檔是最佳價。
 *
 * 同一時間（同一個 instance）多個請求的代號會合併成一次 MIS 請求，並快取 3 秒，
 * 避免每 5 秒輪詢 × 多檔 × 多人把 MIS 打到限流。
 */

export interface DepthLevel {
  price: number;
  /** 張 */
  volume: number;
}

export interface OrderBook {
  symbol: string;
  name: string;
  /** 最近成交價（沒有就 null） */
  price: number | null;
  prevClose: number | null;
  bids: DepthLevel[];
  asks: DepthLevel[];
  /** 五檔委買量合計（張） */
  bidTotal: number;
  askTotal: number;
  /** 資料時間（ISO） */
  time?: string;
}

interface DepthRow {
  c: string;
  n?: string;
  z?: string;
  y?: string;
  b?: string;
  g?: string;
  a?: string;
  f?: string;
  d?: string;
  t?: string;
  tlong?: string;
  trade?: { z?: string };
}

const CACHE_MS = 3000;
const BATCH_WAIT_MS = 30;
const MAX_PER_REQUEST = 40;

function levels(prices: string | undefined, volumes: string | undefined): DepthLevel[] {
  const p = (prices ?? "").split("_");
  const v = (volumes ?? "").split("_");
  const out: DepthLevel[] = [];
  for (let i = 0; i < Math.min(5, p.length); i++) {
    const price = parseFloat(p[i]);
    const volume = parseInt(v[i], 10);
    // 漲跌停鎖住時另一側是 "-"，或價格是 0 的佔位值
    if (Number.isFinite(price) && price > 0) out.push({ price, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return out;
}

const num = (s: string | undefined) => {
  const v = parseFloat(s ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** MIS 一列 → 五檔（純函式，測試用） */
export function rowToOrderBook(row: DepthRow): OrderBook {
  const bids = levels(row.b, row.g);
  const asks = levels(row.a, row.f);
  return {
    symbol: row.c,
    name: row.n || row.c,
    price: num(row.z) ?? num(row.trade?.z),
    prevClose: num(row.y),
    bids,
    asks,
    bidTotal: bids.reduce((s, l) => s + l.volume, 0),
    askTotal: asks.reduce((s, l) => s + l.volume, 0),
    time: misTradeTimeIso(row),
  };
}

const cache = new Map<string, { at: number; book: OrderBook | null }>();
let pending: { symbols: Set<string>; promise: Promise<void> } | null = null;

async function fetchBatch(symbols: string[]): Promise<void> {
  for (let i = 0; i < symbols.length; i += MAX_PER_REQUEST) {
    const chunk = symbols.slice(i, i + MAX_PER_REQUEST);
    // 不確定上市或上櫃：兩種都問，MIS 只會回存在的那個
    const exCh = chunk.flatMap((s) => [`tse_${s}.tw`, `otc_${s}.tw`]).join("|");
    const at = Date.now();
    try {
      // 偶爾會逾時或回空：重試一次
      const rows = await fetchMisRows<DepthRow>(exCh, 4000, { retryStale: true }).catch(() => fetchMisRows<DepthRow>(exCh, 4000, { retryStale: true }));
      const got = new Map(rows.filter((r) => r.c).map((r) => [r.c, rowToOrderBook(r)]));
      for (const s of chunk) cache.set(s, { at, book: got.get(s) ?? null });
    } catch {
      // 這次抓不到：不寫快取，下次再試
    }
  }
}

/** 取得多檔台股的即時五檔；抓不到的代號不會出現在結果裡 */
export async function getOrderBooks(symbols: string[]): Promise<Map<string, OrderBook>> {
  const want = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => /^[0-9A-Z]{4,6}$/.test(s)))];
  const now = Date.now();
  const stale = want.filter((s) => {
    const c = cache.get(s);
    return !c || now - c.at > CACHE_MS;
  });
  if (stale.length) {
    // 很短的時間內進來的請求合併成一次（例如即時提醒同時判斷 20 檔，每檔各自要五檔）
    if (!pending) {
      const batch = { symbols: new Set<string>(), promise: Promise.resolve() };
      batch.promise = new Promise<void>((r) => setTimeout(r, BATCH_WAIT_MS)).then(() => {
        pending = null;
        return fetchBatch([...batch.symbols]);
      });
      pending = batch;
    }
    for (const s of stale) pending.symbols.add(s);
    await pending.promise;
  }
  const out = new Map<string, OrderBook>();
  for (const s of want) {
    const book = cache.get(s)?.book;
    if (book) out.set(s, book);
  }
  return out;
}

export async function getOrderBook(symbol: string): Promise<OrderBook | null> {
  return (await getOrderBooks([symbol])).get(symbol.trim().toUpperCase()) ?? null;
}
