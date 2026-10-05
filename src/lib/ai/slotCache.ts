import { after } from "next/server";
import { peekCached, writeCached } from "@/lib/data/cache";
import { kvEnabled, redis } from "@/lib/data/kv";
import type { ScheduleSlot } from "./aiSchedule";

/**
 * 「依時點重寫」的快取（有 I/O）：今日建議／快報只在 aiSchedule.ts 的時點用較強模型重寫一次，
 * 其間一律沿用最近一次成功的版本（`${prefix}:latest`）。
 *
 * - 目前時點已經寫好 → 直接回。
 * - 還沒寫好、但有上一版 → 先回上一版，重寫交給 after()（回應送出後跑完；warm-cache 每 5 分鐘觸發一次，
 *   沒有訪客時也會照時點產生）。跨執行個體用 Redis 鎖（SET NX）避免同一時點重寫兩次。
 * - 完全沒有任何版本（第一次部署）→ 現場等重寫。
 * - AI 失敗（usedAi=false）只記 SLOT_FAILED_RETRY_TTL_MS，下一次 warm-cache 再試；有上一版時照樣顯示上一版。
 */

export const SLOT_VALUE_TTL_MS = 36 * 3600_000;
export const SLOT_FAILED_RETRY_TTL_MS = 5 * 60_000;
export const SLOT_LATEST_TTL_MS = 7 * 86400_000;
const SLOT_LOCK_TTL_SEC = 150;

const inflight = new Map<string, Promise<unknown>>();

async function acquireLock(key: string): Promise<boolean> {
  if (!kvEnabled || !redis) return true;
  try {
    return (await redis.set(`lock:${key}`, "1", { nx: true, ex: SLOT_LOCK_TTL_SEC })) === "OK";
  } catch {
    return true;
  }
}

async function releaseLock(key: string): Promise<void> {
  if (kvEnabled && redis) await redis.del(`lock:${key}`).catch(() => {});
}

export async function slotCached<T extends { usedAi: boolean }>(
  prefix: string,
  slot: ScheduleSlot,
  load: () => Promise<T>,
  opts: { forceRefresh?: boolean } = {}
): Promise<T> {
  const key = `${prefix}:${slot.key}`;
  const latestKey = `${prefix}:latest`;

  const generate = (): Promise<T | undefined> => {
    const running = inflight.get(key) as Promise<T | undefined> | undefined;
    if (running) return running;
    const p = (async () => {
      if (!(await acquireLock(key))) return undefined;
      try {
        const v = await load();
        await writeCached(key, v, v.usedAi ? SLOT_VALUE_TTL_MS : SLOT_FAILED_RETRY_TTL_MS);
        if (v.usedAi) await writeCached(latestKey, v, SLOT_LATEST_TTL_MS);
        return v;
      } finally {
        await releaseLock(key);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  if (!opts.forceRefresh) {
    const [current, latest] = await Promise.all([peekCached<T>(key), peekCached<T>(latestKey)]);
    if (current && (current.usedAi || !latest)) return current;
    if (current && latest) return latest; // 這個時點 AI 失敗、等重試期間：沿用上一版成功的
    if (latest) {
      try {
        after(() => generate().then(() => undefined));
      } catch {
        void generate(); // 不在 request scope（例如測試或腳本）
      }
      return latest;
    }
  }
  const fresh = await generate();
  if (fresh) return fresh;
  // 別的執行個體正在寫：等一下再讀，還沒有就現場算（不寫快取，避免重複）。
  return (await peekCached<T>(key)) ?? (await peekCached<T>(latestKey)) ?? load();
}
