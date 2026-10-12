import { kvEnabled, redis } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { getStockRating } from "./stockRating";

/**
 * AI 建議清單的變動紀錄（2026-10-12 使用者：「建議清單要有紀錄，不然跳太快，我未來沒辦法複查 AI 是否正確就會無法修改」）。
 *
 * 每次算出（輸入完整的）新名單，就跟上一份比對：新加入的記一筆「加入」（當時價位、評等、把握程度、操作計畫、理由），
 * 被移出的記一筆「移出」（移出時的評等結論與價位）。沒有變動不寫。使用者之後可以在「今日建議」頁的紀錄區回頭看
 * 每一檔是什麼時候進出、進場價多少、到現在漲跌多少，據此判斷 AI 建議準不準。
 *
 * 儲存：Redis list `action-list-log:v1`（每筆一個 JSON，一天頂多十幾筆；讀一次 LRANGE），
 * 最近一份名單 `action-list-log:v1:last`（比對用）。成本：每次名單重算多 1 個 GET；有變動才寫（RPUSH＋SET）。
 * fail open：沒有 Redis、讀寫失敗都安靜略過，不影響名單本身。
 */

export const ACTION_LOG_KEY = "action-list-log:v1";
export const ACTION_LOG_LAST_KEY = "action-list-log:v1:last";
const LOG_TTL_SECONDS = 400 * 86_400;
/** 讀取時最多回傳幾筆（最新的在前） */
export const ACTION_LOG_MAX_READ = 600;

export interface ActionListLogEntry {
  /** 台北日期 YYYY-MM-DD */
  day: string;
  /** 台北時間 HH:MM */
  time: string;
  /** ISO 時間 */
  at: string;
  event: "add" | "remove";
  symbol: string;
  name: string;
  /** 當時價位（加入＝評等計算價；移出＝移出時的現價）；沒有就 null */
  price: number | null;
  /** 當時本站評等字樣（加入＝建議買進…；移出＝新的結論，例如「先不要買」） */
  label: string;
  confidence?: string;
  plan?: string;
  reason?: string;
  /** 這次名單共幾檔、模式（今日建議／明日操作…） */
  listSize: number;
  mode: string;
}

interface PickInput {
  symbol: string;
  name: string;
  label: string;
  confidence?: string;
  plan?: string;
  reason?: string;
  price?: number;
}

interface LastSnapshot {
  at: string;
  picks: Array<{ symbol: string; name: string }>;
}

/** 純邏輯：新舊名單比對（代號大寫）。prev＝null 代表從來沒有紀錄：全部算加入。 */
export function diffActionList(prev: readonly string[] | null, next: readonly string[]): { added: string[]; removed: string[] } {
  const p = new Set((prev ?? []).map((s) => s.toUpperCase()));
  const n = new Set(next.map((s) => s.toUpperCase()));
  return { added: [...n].filter((s) => !p.has(s)), removed: [...p].filter((s) => !n.has(s)) };
}

function taipeiParts(now: Date): { day: string; time: string } {
  const t = new Date(now.getTime() + 8 * 3_600_000).toISOString();
  return { day: taipeiDayKey(now), time: t.slice(11, 16) };
}

/** 名單重算完（輸入完整）後呼叫：有進出就記下來。回傳這次寫了幾筆（測試用）。 */
export async function recordActionListChange(args: { picks: PickInput[]; mode: string; now?: Date }): Promise<number> {
  if (!kvEnabled || !redis) return 0;
  const now = args.now ?? new Date();
  try {
    const raw = await redis.get<LastSnapshot | string>(ACTION_LOG_LAST_KEY);
    const last = raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as LastSnapshot) : null;
    const { added, removed } = diffActionList(last?.picks.map((p) => p.symbol) ?? null, args.picks.map((p) => p.symbol));
    if (added.length === 0 && removed.length === 0) return 0;
    const { day, time } = taipeiParts(now);
    const base = { day, time, at: now.toISOString(), listSize: args.picks.length, mode: args.mode };
    const entries: ActionListLogEntry[] = [];
    for (const sym of added) {
      const p = args.picks.find((x) => x.symbol.toUpperCase() === sym)!;
      entries.push({ ...base, event: "add", symbol: p.symbol, name: p.name, price: p.price ?? null, label: p.label, confidence: p.confidence, plan: p.plan, reason: p.reason });
    }
    for (const sym of removed) {
      const old = last!.picks.find((x) => x.symbol.toUpperCase() === sym)!;
      // 移出原因與價位：查這檔現在的評等（走既有 10 分鐘評等快取）；查不到就只記「不在名單內」
      const r = await getStockRating(old.symbol, "TW").catch(() => null);
      entries.push({
        ...base,
        event: "remove",
        symbol: old.symbol,
        name: old.name,
        price: r?.price ?? null,
        label: r ? r.rating.label : "不在建議名單內（名額被取代或條件變動）",
        reason: r?.rating.reason,
      });
    }
    await redis.rpush(ACTION_LOG_KEY, ...entries.map((e) => JSON.stringify(e)));
    await redis.expire(ACTION_LOG_KEY, LOG_TTL_SECONDS);
    await redis.set(ACTION_LOG_LAST_KEY, { at: now.toISOString(), picks: args.picks.map((p) => ({ symbol: p.symbol, name: p.name })) }, { ex: LOG_TTL_SECONDS });
    return entries.length;
  } catch (err) {
    console.warn("[action-list-log] 記錄失敗（略過）:", err);
    return 0;
  }
}

/** 讀取紀錄（最新的在前，最多 ACTION_LOG_MAX_READ 筆） */
export async function readActionListLog(): Promise<ActionListLogEntry[]> {
  if (!kvEnabled || !redis) return [];
  const all = (await redis.lrange<unknown>(ACTION_LOG_KEY, 0, -1)) ?? [];
  const out: ActionListLogEntry[] = [];
  for (const v of all) {
    try {
      const e = (typeof v === "string" ? JSON.parse(v) : v) as ActionListLogEntry;
      if (e && e.symbol && e.event) out.push(e);
    } catch {
      // 壞掉的一筆略過
    }
  }
  return out.reverse().slice(0, ACTION_LOG_MAX_READ);
}
