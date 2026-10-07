import { peekCached, writeCached } from "./cache";
import type { Candle } from "./types";

/**
 * 已經結束的月份，日K不會再變：成功抓到就長期快取（同一實例記憶體＋Redis 45 天）。
 * 2026-10-08 模擬倉「全市場前 N 名」要一次掃上百檔一年日K（每檔 13 個月份請求），
 * 原本過去月份只在單一實例記憶體留 30 分鐘，Vercel 每次排程冷啟動都要全部重抓、必定被限流；
 * 改成存進 Redis 後，每檔每天只需要抓「本月」一個請求。上市（twse.ts）、上櫃（tpex.ts）共用。
 * 空陣列（那個月沒交易，例如還沒上市）也快取，避免一直重抓。
 */
const TTL_MS = 45 * 24 * 60 * 60_000;
const MEMORY_MAX = 3000;
const memory = new Map<string, Candle[]>();

export async function closedMonthCandles(key: string, load: () => Promise<Candle[]>): Promise<Candle[]> {
  const k = `closed-month:v1:${key}`;
  const mem = memory.get(k);
  if (mem) return mem;
  const hit = await peekCached<Candle[]>(k).catch(() => undefined);
  if (hit) {
    remember(k, hit);
    return hit;
  }
  const candles = await load();
  remember(k, candles);
  await writeCached(k, candles, TTL_MS).catch(() => {});
  return candles;
}

function remember(k: string, candles: Candle[]) {
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(k, candles);
}

/** 這個月份是不是已經結束（台北時間的本月之前） */
export function isClosedYm(year: number, month: number, now: { year: number; month: number }): boolean {
  return year * 100 + month < now.year * 100 + now.month;
}
