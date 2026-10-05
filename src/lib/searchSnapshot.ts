import { randomUUID } from "node:crypto";

/**
 * /api/search 的「已排序結果快照」，解決兩件事：
 * 1. 相同篩選＋排序的搜尋在伺服器端短暫共用同一份結果（FRESH_MS，盤中輪詢間隔 30 秒，
 *    所以不影響新鮮度）。
 * 2. 分頁一致性：第一頁回傳快照識別 id，「顯示更多」帶同一個 id，伺服器切同一份已排序
 *    結果——盤中價格變動不會讓第二頁和第一頁重複或漏股票。快照保留 RETAIN_MS；
 *    找不到（過期、或請求落在另一個 serverless instance）就整份重新排序並回新的 id，
 *    前端看到 id 不同就改重載已顯示的範圍。
 *
 * 刻意只用 process 記憶體、不走 cache.ts 的 Redis：key 含所有篩選參數（關鍵字逐字輸入
 * 都是新 key），每個結果約 375KB，寫進 Upstash 免費額度會很快吃掉指令數與頻寬（零花費原則）。
 */
const FRESH_MS = 10_000;
const RETAIN_MS = 120_000;
const MAX_SNAPSHOTS = 24;

interface Snapshot<T> {
  id: string;
  filterKey: string;
  at: number;
  items: Promise<T[]>;
}

const snapshots = new Map<string, Snapshot<unknown>>();

function evict(now: number) {
  for (const [id, s] of snapshots) if (now - s.at > RETAIN_MS) snapshots.delete(id);
  for (const id of snapshots.keys()) {
    if (snapshots.size <= MAX_SNAPSHOTS) break;
    snapshots.delete(id);
  }
}

export async function getSearchSnapshot<T>(
  filterKey: string,
  load: () => Promise<T[]>,
  requestedId?: string | null
): Promise<{ id: string; items: T[] }> {
  const now = Date.now();
  evict(now);

  // 帶了快照 id 且還在、篩選條件也一致 → 一定用它（保證分頁切同一份排序）。
  if (requestedId) {
    const s = snapshots.get(requestedId);
    if (s && s.filterKey === filterKey) return { id: s.id, items: (await s.items) as T[] };
  }

  // 沒帶 id（新的搜尋）：10 秒內同條件直接共用最新那份；帶了 id 但已不在則走到這裡重建。
  let latest: Snapshot<unknown> | undefined;
  for (const s of snapshots.values()) if (s.filterKey === filterKey && (!latest || s.at > latest.at)) latest = s;
  if (latest && now - latest.at <= FRESH_MS) return { id: latest.id, items: (await latest.items) as T[] };

  const snap: Snapshot<T> = { id: randomUUID(), filterKey, at: now, items: load() };
  snapshots.set(snap.id, snap as Snapshot<unknown>);
  try {
    return { id: snap.id, items: await snap.items };
  } catch (err) {
    snapshots.delete(snap.id); // 失敗不快取
    throw err;
  }
}

/** 測試用：清空所有快照。 */
export function clearSearchSnapshots() {
  snapshots.clear();
}
