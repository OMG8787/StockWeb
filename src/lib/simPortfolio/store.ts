import { kvEnabled, redis } from "@/lib/data/kv";
import type { SimState } from "./types";

/**
 * AI 模擬投資組合的 Redis 存取（一個 JSON key，執行一次＝讀 1～2 次、寫 1 次；Upstash 免費每月 50 萬指令，
 * 一天 3 個時點只用到幾十個指令）。沒有 Redis 時整個功能停用（不能用記憶體假裝，換執行個體就不見）。
 */
export const SIM_STATE_KEY = "sim-portfolio:v1:state";
/** 執行中鎖（同一時點只跑一次；跑完由 state.doneSlots 擋，鎖只防同時兩個請求）。 */
const SIM_LOCK_KEY = "sim-portfolio:v1:lock";
const SIM_LOCK_SECONDS = 240;

export const simStoreEnabled = kvEnabled;

export async function readSimState(): Promise<SimState | null> {
  if (!redis) return null;
  const v = await redis.get<SimState | string>(SIM_STATE_KEY);
  if (v == null) return null;
  return typeof v === "string" ? (JSON.parse(v) as SimState) : v;
}

export async function writeSimState(state: SimState): Promise<void> {
  if (!redis) throw new Error("沒有 Redis");
  await redis.set(SIM_STATE_KEY, JSON.stringify(state));
  memo = { at: Date.now(), state };
}

export async function acquireSimLock(): Promise<boolean> {
  if (!redis) return false;
  return (await redis.set(SIM_LOCK_KEY, new Date().toISOString(), { nx: true, ex: SIM_LOCK_SECONDS })) === "OK";
}

export async function releaseSimLock(): Promise<void> {
  if (!redis) return;
  await redis.del(SIM_LOCK_KEY).catch(() => undefined);
}

/** 頁面讀取用的記憶體快取（每個執行個體 60 秒，避免每次輪詢都打 Redis）。 */
const SIM_READ_MEMO_MS = 60_000;
let memo: { at: number; state: SimState | null } | null = null;

export async function readSimStateCached(): Promise<SimState | null> {
  if (memo && Date.now() - memo.at < SIM_READ_MEMO_MS) return memo.state;
  const state = await readSimState();
  memo = { at: Date.now(), state };
  return state;
}
