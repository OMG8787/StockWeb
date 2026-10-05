import type { Market } from "@/lib/data";
import {
  getManualUnheldOrderFlags,
  getWatchlist,
  hasHolding,
  replaceWatchlist,
  setManualUnheldOrderFlags,
  type WatchlistItem,
} from "@/lib/watchlist";
import type { ParsedWatchlistCsv } from "@/lib/watchlistCsv";

export type ImportMode = "replace" | "merge";

const BACKUP_PREFIX = "stockradar:watchlist-backup-";
const MAX_BACKUPS = 3;

interface Backup {
  at: number;
  list: WatchlistItem[];
  flags: Partial<Record<Market, boolean>>;
}

function backupKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(BACKUP_PREFIX)) keys.push(k);
    }
    return keys.sort((a, b) => Number(b.slice(BACKUP_PREFIX.length)) - Number(a.slice(BACKUP_PREFIX.length)));
  } catch {
    return [];
  }
}

export function hasImportBackup(): boolean {
  return backupKeys().length > 0;
}

function saveBackup(): void {
  try {
    const at = Date.now();
    const b: Backup = { at, list: getWatchlist(), flags: getManualUnheldOrderFlags() };
    window.localStorage.setItem(`${BACKUP_PREFIX}${at}`, JSON.stringify(b));
    for (const k of backupKeys().slice(MAX_BACKUPS)) window.localStorage.removeItem(k);
  } catch {
    // 備份失敗（容量／無痕）不阻擋匯入
  }
}

/** 還原最近一次匯入前的清單（用掉那份備份）。回傳是否成功。 */
export function restoreLastImportBackup(): boolean {
  const key = backupKeys()[0];
  if (!key) return false;
  try {
    const b = JSON.parse(window.localStorage.getItem(key) ?? "") as Backup;
    if (!Array.isArray(b.list)) return false;
    setManualUnheldOrderFlags(b.flags ?? {});
    replaceWatchlist(b.list);
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** 合併：目前清單保留；相同代碼的持股／名稱以匯入檔為準（位置沿用原本，若換組則排到該組最後）；新代碼排到各組最後。純函式，方便測試。 */
export function mergeWatchlists(
  current: WatchlistItem[],
  imported: WatchlistItem[]
): WatchlistItem[] {
  const keyOf = (i: WatchlistItem) => `${i.market}:${i.symbol}`;
  const next = current.map((i) => ({ ...i }));
  const nextOrder = (held: boolean, market?: Market) => {
    // 持有組不分市場；僅關注組各市場獨立，但共用同一欄位，取同組最大值＋1 即可
    const sib = next.filter((i) => hasHolding(i) === held && (held || i.market === market));
    return sib.length === 0 ? 0 : Math.max(...sib.map((i) => i.order ?? 0)) + 1;
  };
  // 依匯入檔內原本的 order 排序後再接到尾端，保留匯入檔內部的相對順序
  const sorted = [...imported].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const imp of sorted) {
    const idx = next.findIndex((i) => keyOf(i) === keyOf(imp));
    if (idx >= 0) {
      const old = next[idx];
      const sameGroup = hasHolding(old) === hasHolding(imp);
      next[idx] = { ...imp, order: sameGroup ? old.order : nextOrder(hasHolding(imp), imp.market) };
    } else {
      next.push({ ...imp, order: nextOrder(hasHolding(imp), imp.market) });
    }
  }
  return next;
}

/** 寫入 localStorage（先備份目前清單）。 */
export function applyWatchlistImport(parsed: ParsedWatchlistCsv, mode: ImportMode): void {
  saveBackup();
  if (mode === "replace") {
    setManualUnheldOrderFlags(parsed.manualUnheld);
    replaceWatchlist(parsed.items.map((i) => ({ ...i })));
    return;
  }
  const flags = { ...getManualUnheldOrderFlags() };
  for (const m of ["TW", "US"] as Market[]) if (parsed.manualUnheld[m]) flags[m] = true;
  setManualUnheldOrderFlags(flags);
  replaceWatchlist(mergeWatchlists(getWatchlist(), parsed.items));
}
