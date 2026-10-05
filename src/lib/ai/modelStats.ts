import { after } from "next/server";
import { kvEnabled, redis } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";

/**
 * 各模型的輕量計數（成績看板「各模型」區塊用）：AI 問答回答數、👍／👎／📝回報數。
 * Redis 一天一個 hash `ai-model-stats:v1:{台北日期}`，field＝`{模型id}|{事件}`，每次事件一個 pipeline（HINCRBY＋EXPIRE，一次 HTTP）。
 * fail open、在回應送出後才寫。
 */

export const MODEL_STATS_KEY_PREFIX = "ai-model-stats:v1:";
const TTL_SECONDS = 120 * 86_400;
export type ModelEvent = "answer" | "fallback" | "up" | "down" | "report";
const EVENTS: ModelEvent[] = ["answer", "fallback", "up", "down", "report"];

export function recordModelEvent(modelId: string | null | undefined, event: ModelEvent): void {
  if (!kvEnabled || !redis) return;
  const id = (modelId || (event === "fallback" ? "none" : "")).slice(0, 80).replace(/\|/g, "/");
  if (!id) return;
  const key = `${MODEL_STATS_KEY_PREFIX}${taipeiDayKey()}`;
  const task = async () => {
    try {
      await redis!.pipeline().hincrby(key, `${id}|${event}`, 1).expire(key, TTL_SECONDS).exec();
    } catch {
      // fail open
    }
  };
  try {
    after(task);
  } catch {
    void task();
  }
}

export interface ModelStatRow {
  model: string;
  answer: number;
  up: number;
  down: number;
  report: number;
}

/** 彙總最近 `days` 天（含今天）各模型的計數；`fallback`（AI 全部失敗走備援文字）以 model＝none 列出。 */
export async function readModelStats(days = 30, now: Date = new Date()): Promise<ModelStatRow[]> {
  if (!kvEnabled || !redis) return [];
  const keys: string[] = [];
  for (let i = 0; i < days; i++) keys.push(`${MODEL_STATS_KEY_PREFIX}${taipeiDayKey(new Date(now.getTime() - i * 86_400_000))}`);
  const p = redis.pipeline();
  for (const k of keys) p.hgetall(k);
  const res = (await p.exec()) as Array<Record<string, unknown> | null>;
  return aggregateModelStats(res);
}

/** 純邏輯（有測試）：把每天的 hash 加總成各模型一列，依回答數多到少。 */
export function aggregateModelStats(hashes: Array<Record<string, unknown> | null>): ModelStatRow[] {
  const map = new Map<string, ModelStatRow>();
  for (const h of hashes) {
    if (!h) continue;
    for (const [field, v] of Object.entries(h)) {
      const i = field.lastIndexOf("|");
      const model = field.slice(0, i);
      const ev = field.slice(i + 1) as ModelEvent;
      if (!EVENTS.includes(ev)) continue;
      const row = map.get(model) ?? { model, answer: 0, up: 0, down: 0, report: 0 };
      const n = Number(v) || 0;
      if (ev === "fallback") row.answer += n;
      else row[ev] += n;
      map.set(model, row);
    }
  }
  return [...map.values()].sort((a, b) => b.answer - a.answer);
}
