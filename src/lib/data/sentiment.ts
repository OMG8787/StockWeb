import { kvEnabled, redis } from "./kv";
import { getMarketStatus } from "@/lib/marketStatus";
import { recordServerQuota, reserveAdanosCall } from "./adanosQuota";

/**
 * 美股「社群情緒」（Adanos Market Sentiment API：Reddit／X／財經新聞的討論熱度與多空比例）。
 *
 * 額度極少（免費每週期250次，見 adanosQuota.ts），所以設計成：
 *  - 只打「trending」批次端點：一次呼叫回傳該來源近7日討論最熱的最多100檔（實測 Reddit 100檔、
 *    X 約50檔、新聞約50檔），不對每檔個股各打一次；查不到的冷門股照實顯示「不在熱門討論榜」。
 *  - 三個來源輪流：每次只刷新「最久沒更新」的那一個來源，一次刷新＝1次呼叫。
 *  - 節奏靠跨實例的 Redis 鎖（SET NX EX 40分鐘）自然限流：美股盤中6.5小時約10次/天，
 *    每個來源約2小時更新一次。不進 warm-cache、不排 cron，只在有人看美股個股頁/問AI時順手觸發。
 *  - 只在美股盤中、正式環境（VERCEL_ENV=production，或本機明確設 ADANOS_ALLOW_LOCAL=1）才呼叫；
 *    其他時間只讀長效快照（14天）並標示資料時間。
 *  - 缺金鑰：完全不呼叫、回傳 null，呼叫端照舊。
 */

export type SentimentSource = "reddit" | "x" | "news";

export const SENTIMENT_SOURCES: SentimentSource[] = ["reddit", "x", "news"];

export const SENTIMENT_SOURCE_LABEL: Record<SentimentSource, string> = {
  reddit: "Reddit",
  x: "X（Twitter）",
  news: "財經新聞",
};

/** 一檔股票在某個來源的近7日情緒 */
export interface SentimentRow {
  /** 討論熱度 0~100（Adanos buzz score） */
  buzz: number;
  /** 討論熱度趨勢：近3日 vs 前3日（不是股價趨勢） */
  trend: "rising" | "falling" | "stable" | null;
  /** 提及次數 */
  mentions: number;
  /** 平均情緒 -1（偏空）~ +1（偏多） */
  score: number | null;
  bullishPct: number | null;
  bearishPct: number | null;
  /** 在該來源熱門榜的名次（1起算） */
  rank: number;
}

export interface SourceSnapshot {
  /** 抓取時間 epoch ms */
  fetchedAt: number;
  /** 統計區間起日（UTC，YYYY-MM-DD），迄日為抓取當天 */
  from: string;
  /** 熱門榜總檔數 */
  listSize: number;
  rows: Record<string, SentimentRow>;
}

export interface StockSentiment {
  symbol: string;
  /** 各來源資料；該來源有快照但這檔不在熱門榜時是 null，來源完全沒快照時不出現 */
  sources: Partial<Record<SentimentSource, { row: SentimentRow | null; fetchedAt: number; from: string; listSize: number }>>;
}

const BASE_URL = "https://api.adanos.org";
const PATHS: Record<SentimentSource, string> = {
  reddit: "/reddit/stocks/v1/trending",
  x: "/x/stocks/v1/trending",
  news: "/news/stocks/v1/trending",
};
const PERIOD_DAYS = 7;
const TREND_LIMIT = 100;
/** 兩次呼叫之間的最短間隔（跨實例鎖的存活時間）：6.5小時 ÷ 10 次 ≈ 40 分鐘 */
const REFRESH_INTERVAL_SEC = 40 * 60;
const SNAPSHOT_TTL_SEC = 14 * 86400;
const MEMORY_FRESH_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 6000;

const snapKey = (s: SentimentSource) => `adanos:snap:${s}`;
const LOCK_KEY = "adanos:refresh-lock";

const memSnap = new Map<SentimentSource, { snap: SourceSnapshot | null; readAt: number }>();
let memLockUntil = 0;
let lastLockAttempt = 0;

function apiKey(): string | undefined {
  const k = process.env.ADANOS_API_KEY?.trim();
  return k ? k : undefined;
}

/** 是否允許在這個環境真的打上游（預覽環境、一般本機開發都不打，避免燒額度） */
function callsAllowedHere(): boolean {
  if (process.env.VERCEL_ENV === "production") return true;
  return !process.env.VERCEL_ENV && process.env.ADANOS_ALLOW_LOCAL === "1";
}

export function isSentimentConfigured(): boolean {
  return Boolean(apiKey());
}

async function readSnapshot(source: SentimentSource): Promise<SourceSnapshot | null> {
  const m = memSnap.get(source);
  if (m && Date.now() - m.readAt < MEMORY_FRESH_MS) return m.snap;
  let snap: SourceSnapshot | null = m?.snap ?? null;
  if (kvEnabled && redis) {
    try {
      snap = (await redis.get<SourceSnapshot>(snapKey(source))) ?? null;
    } catch {
      // Redis 暫時讀不到：沿用記憶體裡的舊快照
    }
  }
  memSnap.set(source, { snap, readAt: Date.now() });
  return snap;
}

async function writeSnapshot(source: SentimentSource, snap: SourceSnapshot): Promise<void> {
  memSnap.set(source, { snap, readAt: Date.now() });
  if (kvEnabled && redis) {
    try {
      await redis.set(snapKey(source), snap, { ex: SNAPSHOT_TTL_SEC });
    } catch {
      // best-effort
    }
  }
}

/** 跨實例鎖：40 分鐘內只有一個請求能拿到「這輪可以呼叫」的資格 */
async function acquireRefreshLock(): Promise<boolean> {
  // 同一個實例 60 秒內只搶一次鎖，避免盤中每次美股頁瀏覽都多打一個 Redis 指令
  if (Date.now() - lastLockAttempt < 60_000) return false;
  lastLockAttempt = Date.now();
  if (kvEnabled && redis) {
    try {
      const r = await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: REFRESH_INTERVAL_SEC });
      return r === "OK";
    } catch {
      return false;
    }
  }
  if (Date.now() < memLockUntil) return false;
  memLockUntil = Date.now() + REFRESH_INTERVAL_SEC * 1000;
  return true;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 純函式：把 trending 回應轉成以代號為 key 的表（只收美股代號格式，略過 AB.PA、6594 這類海外代號） */
export function parseTrending(body: unknown): { rows: Record<string, SentimentRow>; listSize: number } {
  const rows: Record<string, SentimentRow> = {};
  if (!Array.isArray(body)) return { rows, listSize: 0 };
  body.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const ticker = typeof o.ticker === "string" ? o.ticker.toUpperCase() : "";
    if (!/^[A-Z]{1,6}$/.test(ticker) || rows[ticker]) return;
    const trend = o.trend === "rising" || o.trend === "falling" || o.trend === "stable" ? o.trend : null;
    rows[ticker] = {
      buzz: num(o.buzz_score) ?? 0,
      trend,
      mentions: num(o.mentions) ?? 0,
      score: num(o.sentiment_score),
      bullishPct: num(o.bullish_pct),
      bearishPct: num(o.bearish_pct),
      rank: i + 1,
    };
  });
  return { rows, listSize: body.length };
}

function periodFrom(now: Date): string {
  return new Date(now.getTime() - (PERIOD_DAYS - 1) * 86400_000).toISOString().slice(0, 10);
}

async function fetchTrending(source: SentimentSource, key: string, now: Date): Promise<SourceSnapshot | null> {
  const from = periodFrom(now);
  const url = `${BASE_URL}${PATHS[source]}?limit=${TREND_LIMIT}&from=${from}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "X-API-Key": key }, signal: controller.signal, cache: "no-store" });
    await recordServerQuota(res.headers, res.status, now);
    if (!res.ok) {
      console.warn(`[sentiment] Adanos ${source} HTTP ${res.status}`);
      return null;
    }
    const { rows, listSize } = parseTrending(await res.json());
    if (listSize === 0) return null;
    return { fetchedAt: now.getTime(), from, listSize, rows };
  } catch (e) {
    console.warn(`[sentiment] Adanos ${source} 失敗：${e instanceof Error ? e.name : "unknown"}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 決定這輪要刷新哪個來源：最久沒更新（或從來沒有）的那個 */
function pickStaleSource(snaps: Record<SentimentSource, SourceSnapshot | null>): SentimentSource {
  let best: SentimentSource = SENTIMENT_SOURCES[0];
  let bestAt = Infinity;
  for (const s of SENTIMENT_SOURCES) {
    const at = snaps[s]?.fetchedAt ?? 0;
    if (at < bestAt) {
      best = s;
      bestAt = at;
    }
  }
  return best;
}

async function readAllSnapshots(): Promise<Record<SentimentSource, SourceSnapshot | null>> {
  const [reddit, x, news] = await Promise.all(SENTIMENT_SOURCES.map(readSnapshot));
  return { reddit, x, news };
}

/**
 * 視情況刷新一個來源（最多 1 次上游呼叫）。所有條件都滿足才會呼叫：有金鑰、允許的環境、
 * 美股盤中、拿到 40 分鐘跨實例鎖、用量護欄放行。
 */
async function maybeRefresh(snaps: Record<SentimentSource, SourceSnapshot | null>, now: Date): Promise<void> {
  const key = apiKey();
  if (!key || !callsAllowedHere()) return;
  if (getMarketStatus("US", now) !== "open") return;
  if (!(await acquireRefreshLock())) return;
  const reserve = await reserveAdanosCall(now);
  if (!reserve.ok) {
    console.warn(`[sentiment] 用量護欄擋下 Adanos 呼叫：${reserve.reason}`);
    return;
  }
  const source = pickStaleSource(snaps);
  const snap = await fetchTrending(source, key, now);
  if (snap) {
    await writeSnapshot(source, snap);
    snaps[source] = snap;
  }
}

/** 美股代號 → Adanos 代號（BRK-B／BRK.B → BRK；Adanos 不分股份類別） */
function adanosTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/[-.].*$/, "");
}

/**
 * 查一檔美股的社群情緒。缺金鑰或三個來源都沒有任何快照時回傳 null（呼叫端整塊不顯示/不帶入）。
 * 呼叫者必須自己確認是美股——台股不該呼叫。
 */
export async function getUsStockSentiment(symbol: string, now: Date = new Date()): Promise<StockSentiment | null> {
  if (!apiKey()) return null;
  const snaps = await readAllSnapshots();
  await maybeRefresh(snaps, now).catch(() => undefined);
  const ticker = adanosTicker(symbol);
  const sources: StockSentiment["sources"] = {};
  for (const s of SENTIMENT_SOURCES) {
    const snap = snaps[s];
    if (!snap) continue;
    sources[s] = { row: snap.rows[ticker] ?? null, fetchedAt: snap.fetchedAt, from: snap.from, listSize: snap.listSize };
  }
  if (Object.keys(sources).length === 0) return null;
  return { symbol: symbol.toUpperCase(), sources };
}

// ---- 共用判讀（畫面與 AI 文字用同一套門檻，避免兩邊講法不一致） ----

/** 提及次數低於這個數視為樣本太小 */
export const SMALL_SAMPLE_MENTIONS = 20;

export type SentimentLean = "bullish" | "bearish" | "neutral" | "unknown";

/** 偏多/偏空：看多比例減看空比例的差距 ≥10 個百分點才算，否則中性 */
export function sentimentLean(row: SentimentRow): SentimentLean {
  if (row.bullishPct == null || row.bearishPct == null) {
    if (row.score == null) return "unknown";
    return row.score >= 0.15 ? "bullish" : row.score <= -0.15 ? "bearish" : "neutral";
  }
  const diff = row.bullishPct - row.bearishPct;
  return diff >= 10 ? "bullish" : diff <= -10 ? "bearish" : "neutral";
}

export const LEAN_LABEL: Record<SentimentLean, string> = {
  bullish: "偏多",
  bearish: "偏空",
  neutral: "中性",
  unknown: "無法判斷",
};

export function buzzLabel(buzz: number): string {
  return buzz >= 60 ? "高" : buzz >= 35 ? "中" : "低";
}

export const TREND_LABEL: Record<NonNullable<SentimentRow["trend"]>, string> = {
  rising: "升溫",
  falling: "降溫",
  stable: "持平",
};

/** epoch ms → 台北時間「10/01 22:40」 */
export function formatSentimentTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}
