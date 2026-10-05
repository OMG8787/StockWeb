import { after } from "next/server";
import { kvEnabled, redis } from "@/lib/data/kv";
import { taipeiDayKey } from "@/lib/pollingSchedule";

/**
 * 今日市場快報存檔（2026-10-05 使用者要求：快報同時作為 AI 學習資料）。
 *
 * 儲存：Redis 每天一個 key `brief-archive:v1:{台北日期}`，value＝JSON，保留 400 天。
 * 寫入頻率（Upstash 免費額度）：快報每 10 分鐘最多重算一次，不能每次都寫，所以一天最多寫 2 次——
 *  - pre：當天第一份成功的 AI 快報（台北時間 17:00 以前）；
 *  - post：台北時間 17:00 以後的第一份（三大法人資料多在 15:30~17:00 才齊，這份比較接近「當天定稿」，會覆蓋 pre）。
 * 判斷靠「先 GET 現有存檔」：同一個執行個體記過的 slot 放記憶體，連 GET 都省。
 * fail open：沒有 Redis、讀寫失敗都安靜略過，不影響快報回應；用 after() 在回應送出後才寫。
 */

export const BRIEF_ARCHIVE_KEY_PREFIX = "brief-archive:v1:";
const BRIEF_ARCHIVE_TTL_SECONDS = 400 * 86_400;
/** 台北時間幾點以後算「收盤後定稿」slot。 */
export const BRIEF_ARCHIVE_POST_HOUR = 17;

export type BriefArchiveSlot = "pre" | "post";

export interface BriefArchiveEntry {
  /** 台北日期 YYYY-MM-DD（以產生時間換算） */
  date: string;
  slot: BriefArchiveSlot;
  generatedAt: string;
  /** 模型 id（例如 gemini-2.5-flash），沒有時為 null */
  model: string | null;
  /** 當時台股市況（多頭／空頭／盤整），抓不到為 null */
  regime: string | null;
  /** 快報全文 */
  text: string;
  /** 當時餵給 AI 的參考資料（讓之後能對照「資料 → 結論」學因果），讀取 API 預設不回傳 */
  grounding?: string;
}

/** 純邏輯：這個時間點屬於哪個 slot。 */
export function briefArchiveSlot(now: Date): BriefArchiveSlot {
  const taipeiHour = new Date(now.getTime() + 8 * 3_600_000).getUTCHours();
  return taipeiHour >= BRIEF_ARCHIVE_POST_HOUR ? "post" : "pre";
}

/** 純邏輯：已有的存檔（可能 null）遇到新的快報時要不要寫。沒有存檔→寫；現有是 pre、新的是 post→寫（覆蓋）；其餘不寫。 */
export function shouldWriteBriefArchive(existing: Pick<BriefArchiveEntry, "slot"> | null, newSlot: BriefArchiveSlot): boolean {
  if (!existing) return true;
  return existing.slot === "pre" && newSlot === "post";
}

/** 同一個執行個體已經處理過（寫過或確認不需要寫）的 `{日期}#{slot}`，省下重複 GET。 */
const handled = new Set<string>();

async function writeIfNeeded(entry: BriefArchiveEntry): Promise<void> {
  if (!redis) return;
  const memo = `${entry.date}#${entry.slot}`;
  if (handled.has(memo)) return;
  try {
    const key = `${BRIEF_ARCHIVE_KEY_PREFIX}${entry.date}`;
    const raw = await redis.get<BriefArchiveEntry | string>(key);
    const existing = raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as BriefArchiveEntry) : null;
    if (shouldWriteBriefArchive(existing, entry.slot)) {
      await redis.set(key, JSON.stringify(entry), { ex: BRIEF_ARCHIVE_TTL_SECONDS });
    }
    handled.add(memo);
    // post 已處理過，pre 也不用再看了
    if (entry.slot === "post") handled.add(`${entry.date}#pre`);
  } catch (err) {
    console.warn("[brief-archive] 寫入失敗（略過）:", err);
  }
}

/** 存一份成功的 AI 快報（不等待、不丟錯）。 */
export function archiveBrief(input: { text: string; generatedAt: string; model: string | null; regime: string | null; grounding: string }): void {
  if (!kvEnabled) return;
  const at = new Date(input.generatedAt);
  const entry: BriefArchiveEntry = {
    date: taipeiDayKey(at),
    slot: briefArchiveSlot(at),
    generatedAt: input.generatedAt,
    model: input.model,
    regime: input.regime,
    text: input.text,
    grounding: input.grounding,
  };
  const task = () => writeIfNeeded(entry);
  try {
    after(task);
  } catch {
    void task().catch(() => undefined);
  }
}

/** 讀取區間內的存檔（含頭尾，台北日期），舊到新；includeGrounding 預設 false 以免回傳過大。 */
export async function readBriefArchive(from: string, to: string, includeGrounding = false): Promise<BriefArchiveEntry[]> {
  if (!kvEnabled || !redis) return [];
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end && days.length < 400; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length === 0) return [];
  const p = redis.pipeline();
  for (const day of days) p.get(`${BRIEF_ARCHIVE_KEY_PREFIX}${day}`);
  const results = (await p.exec()) as Array<BriefArchiveEntry | string | null>;
  const out: BriefArchiveEntry[] = [];
  for (const v of results) {
    if (!v) continue;
    const e = (typeof v === "string" ? JSON.parse(v) : v) as BriefArchiveEntry;
    if (!e?.date) continue;
    if (!includeGrounding) delete e.grounding;
    out.push(e);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
