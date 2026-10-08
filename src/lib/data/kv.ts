import { Redis } from "@upstash/redis";
import { RuntimeKv } from "./runtimeKv";
import { DurableKv } from "./durableKv";

// Shared cache used so TTLs are actually shared across Vercel's serverless instances instead of
// each one keeping its own process-local copy (see cache.ts). Entirely optional: without it,
// callers fall back to the in-memory cache and the app behaves exactly as before.
//
// 來源優先順序（2026-10-08 使用者決定不用 Redis）：
// 1. 有設定 Upstash Redis（KV_REST_API_URL／UPSTASH_REDIS_REST_URL）就用 Redis。
// 2. 在 Vercel 上（process.env.VERCEL）改用 Vercel Runtime Cache（免費方案也有、跨實例共用；
//    見 runtimeKv.ts——它是快取、可能被淘汰）；評等紀錄、學習紀錄、AI 模擬組合等永久紀錄
//    同時存 Google 試算表（durableKv.ts）。
// 3. 本機開發：都沒有（維持原本的純記憶體行為；要測可設 USE_RUNTIME_CACHE=1）。
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const useRuntimeCache = !(url && token) && (Boolean(process.env.VERCEL) || process.env.USE_RUNTIME_CACHE === "1");

/** 本站用到的 Redis 指令子集（Upstash Redis 與 RuntimeKv 都符合） */
export type KvClient = RuntimeKv;

export const kvBackend: "redis" | "runtime-cache" | "none" = url && token ? "redis" : useRuntimeCache ? "runtime-cache" : "none";
export const kvEnabled = kvBackend !== "none";
export const redis: KvClient | null =
  kvBackend === "redis"
    ? (new Redis({ url: url!, token: token! }) as unknown as KvClient)
    : kvBackend === "runtime-cache"
      ? // 有 Google 試算表時，永久紀錄類的鍵同時存試算表（durableKv.ts）；沒有就只有快取
        process.env.AUTH_GAS_URL
        ? new DurableKv()
        : new RuntimeKv()
      : null;
