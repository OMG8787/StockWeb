import { kvEnabled, redis } from "@/lib/data/kv";
import type { WatchlistItem } from "@/lib/watchlist";

// Cross-device watchlist storage for signed-in users, keyed by their account UserId (lib/auth). Was keyed by Google
// account email. Reuses the same optional Redis connection as the shared
// data cache (lib/data/kv.ts) — when it isn't configured, syncAvailable is
// false and callers fall back to the browser's localStorage-only watchlist,
// so signing in still works, it just won't sync across devices.
export const watchlistSyncAvailable = kvEnabled;

function keyFor(userId: string): string {
  return `watchlist:user:${userId}`;
}

export async function getServerWatchlist(userId: string): Promise<WatchlistItem[]> {
  if (!redis) return [];
  try {
    const items = await redis.get<WatchlistItem[]>(keyFor(userId));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export async function setServerWatchlist(userId: string, items: WatchlistItem[]): Promise<boolean> {
  if (!redis) return false;
  try {
    await redis.set(keyFor(userId), items);
    return true;
  } catch {
    return false;
  }
}
