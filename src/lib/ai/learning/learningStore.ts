import { kvEnabled, redis } from "@/lib/data/kv";
import { fetchUsCandles } from "@/lib/data/us";
import { resolveTwExchange } from "@/lib/data/symbols";
import { ensureTwUniverseWarm } from "@/lib/data/universe";
import type { Candle } from "@/lib/data/types";
import { getTwTradingPhase, taipeiDayKey } from "@/lib/pollingSchedule";
import { readRatingLog, type RatingLogEntry } from "../ratingLog";
import { LESSONS } from "../lessons";
import { featureBases, similarKey } from "./features";
import { validateLessons, type LessonValidation } from "./lessonMatch";
import { getTaiexCandles } from "./regimeData";
import { computeOutcome, REWARD_HORIZONS } from "./reward";
import { buildSimilarTable, type SimilarTable } from "./similar";
import { reviewCases, summarizeByCode, type CodeHorizonStat, type ReviewCase } from "./summary";
import type { EvalRecord } from "./types";
import { computeBasisStats, LEARNED_WEIGHTS_ENABLED, toWeightTable, WEIGHT_MIN_SAMPLES, type BasisStat, type WeightTable } from "./weights";

/**
 * 每日學習工作（有 I/O）：評等紀錄 → 滿 1／5／20 個交易日算獎勵 → 彙總（依據權重、相似案例、教訓驗證、成績看板）→ Redis。
 *
 * 觸發：/api/cron/warm-cache 每次都呼叫 runLearningUpdate()，但只有「台股收盤後到隔天開盤前」、而且當天還沒做完時
 * 才真的執行（Redis 旗標），所以實際上一天一次；/api/cron/learning?force=1 可手動觸發。
 * Active CPU：每次最多處理 LEARNING_MAX_SYMBOLS_PER_RUN 檔的日K（Yahoo，一檔一個請求），彙總是幾百～幾千筆的
 * 簡單加總；結果存 Redis，看板與 AI 問答只讀彙總，不現場計算。
 * 只算台股（獎勵以加權指數為基準）。
 */

export const LEARNING_KEY_PREFIX = "learning:v1:";
const EVAL_KEY_PREFIX = `${LEARNING_KEY_PREFIX}eval:`;
const SUMMARY_KEY = `${LEARNING_KEY_PREFIX}summary`;
const SIMILAR_KEY = `${LEARNING_KEY_PREFIX}similar`;
const WEIGHTS_KEY = `${LEARNING_KEY_PREFIX}weights`;
const DONE_KEY_PREFIX = `${LEARNING_KEY_PREFIX}done:`;
const LOCK_KEY = `${LEARNING_KEY_PREFIX}lock`;
const TTL_SECONDS = 400 * 86_400;

/** 評等紀錄開始的日期（彙總時從這天讀起，不必掃 400 天）。 */
export const LEARNING_START_DAY = "2026-10-05";
/** 往回多少日曆天內的紀錄還要補算（20 個交易日≈28 日曆天，加國定假日緩衝）。 */
export const LEARNING_PENDING_LOOKBACK_DAYS = 45;
/** 每次最多抓幾檔日K（控制 Active CPU 與上游請求量；沒做完下次繼續）。 */
export const LEARNING_MAX_SYMBOLS_PER_RUN = 30;
/** 讀彙總的記憶體快取。 */
const READ_TTL_MS = 10 * 60_000;

export interface LearningSummary {
  generatedAt: string;
  /** 已算過至少一個期間的紀錄筆數 */
  evaluated: number;
  /** 各期間已滿的筆數 */
  matured: Record<string, number>;
  byCode: CodeHorizonStat[];
  basisStats: BasisStat[];
  reviewCases: ReviewCase[];
  lessons: LessonValidation[];
  weightsEnabled: boolean;
  weightMinSamples: number;
}

const DAY_MS = 86_400_000;
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

async function readEvalDays(days: string[]): Promise<Map<string, Record<string, EvalRecord>>> {
  const out = new Map<string, Record<string, EvalRecord>>();
  if (!redis || days.length === 0) return out;
  const p = redis.pipeline();
  for (const d of days) p.hgetall(`${EVAL_KEY_PREFIX}${d}`);
  const res = (await p.exec()) as Array<Record<string, unknown> | null>;
  days.forEach((d, i) => {
    const h = res[i];
    if (!h) return;
    out.set(d, Object.fromEntries(Object.entries(h).map(([k, v]) => [k, parse<EvalRecord>(v)])));
  });
  return out;
}

/** 讀區間內已算過獎勵的紀錄（舊到新）。 */
export async function readEvalRecords(from: string = LEARNING_START_DAY, to: string = taipeiDayKey()): Promise<EvalRecord[]> {
  if (!kvEnabled || !redis) return [];
  const m = await readEvalDays(daysBetween(from < LEARNING_START_DAY ? LEARNING_START_DAY : from, to));
  return [...m.values()].flatMap((h) => Object.values(h)).sort((a, b) => a.at.localeCompare(b.at));
}

/** 一檔的 3 個月日K（Yahoo，一次請求；同一次執行每檔只抓一次，不寫快取）。 */
async function dailyCandles(symbol: string): Promise<Candle[]> {
  await ensureTwUniverseWarm();
  const ex = resolveTwExchange(symbol);
  const order = ex === "TPEx" || ex === "Emerging" ? ["TWO", "TW"] : ["TW", "TWO"];
  for (const suf of order) {
    try {
      const cs = await fetchUsCandles(`${symbol}.${suf}`, "3m");
      if (cs.length > 0) return cs;
    } catch {
      // 換另一個後綴
    }
  }
  return [];
}

function toEval(e: RatingLogEntry, prev: EvalRecord | undefined): EvalRecord {
  return {
    at: e.at,
    day: e.day,
    sym: e.symbol,
    name: e.name,
    code: e.code,
    price: e.price,
    rg: e.rg ?? null,
    bases: featureBases(e.feat, e.facets, e.chaseHits, e.ai?.delta),
    ...(e.feat ? { f: e.feat } : {}),
    sk: similarKey(e.feat, e.rg),
    o: prev?.o ?? {},
    ...(e.ai ? { ai: { code: e.ai.code, delta: e.ai.delta } } : {}),
  };
}

const fullyDone = (r: EvalRecord | undefined) => !!r && REWARD_HORIZONS.every((h) => r.o[String(h) as "1"] != null);

export interface LearningRunResult {
  status: "skipped" | "partial" | "done" | "disabled";
  reason?: string;
  updated?: number;
  pendingSymbols?: number;
  evaluated?: number;
}

/**
 * 跑一次學習工作。`force`：不檢查時段與「今天已做完」旗標（手動觸發用）。
 */
export async function runLearningUpdate(opts: { force?: boolean; now?: Date } = {}): Promise<LearningRunResult> {
  if (!kvEnabled || !redis) return { status: "disabled", reason: "沒有 Redis" };
  const now = opts.now ?? new Date();
  const today = taipeiDayKey(now);
  const phase = getTwTradingPhase(now);
  if (!opts.force) {
    if (phase === "intraday" || phase === "after-hours-fixed") return { status: "skipped", reason: "台股交易時段，收盤後才算" };
    if (await redis.get(`${DONE_KEY_PREFIX}${today}`)) return { status: "skipped", reason: "今天已算過" };
  }
  const locked = await redis.set(LOCK_KEY, now.toISOString(), { nx: true, ex: 300 });
  if (!locked) return { status: "skipped", reason: "另一個執行中" };
  try {
    // 今天還沒收盤（含手動 force）時，今天那根日K是盤中數字，不能拿來結算。
    const todayClosed = !(phase === "pre-open" || phase === "intraday" || phase === "after-hours-fixed");
    const settled = (bars: Candle[]) => (todayClosed ? bars : bars.filter((c) => c.time.slice(0, 10) < today));
    const from = addDays(today, -LEARNING_PENDING_LOOKBACK_DAYS);
    const logs = (await readRatingLog(from < LEARNING_START_DAY ? LEARNING_START_DAY : from, today)).filter((e) => e.market === "TW");
    const pendDays = [...new Set(logs.map((e) => e.day))];
    const existing = await readEvalDays(pendDays);
    // 只挑「下一個缺的期間已經可能滿期」的紀錄（平日數當上限，國定假日頂多多抓幾次），避免每次都重抓還沒滿期的。
    const pending = logs.filter((e) => {
      const prev = existing.get(e.day)?.[`${e.symbol}#${e.code}`];
      const next = REWARD_HORIZONS.find((h) => !prev?.o[String(h) as "1"]);
      return next != null && weekdaysAfter(e.day, today, e.session === "開盤前", todayClosed) >= next;
    });
    // 收盤後同一天前幾次已經抓過的代號（抓不到日K或還沒滿期）不再重抓，讓其他代號輪得到（盤中手動 force 不記）。
    const triedKey = `${LEARNING_KEY_PREFIX}tried:${today}`;
    const tried = new Set(todayClosed ? (((await redis.smembers(triedKey).catch(() => [])) as string[]) ?? []) : []);
    const symbols = [...new Set(pending.map((e) => e.symbol))].filter((s) => !tried.has(s));
    const batch = new Set(symbols.slice(0, LEARNING_MAX_SYMBOLS_PER_RUN));
    const index = settled(await getTaiexCandles());
    const writes = new Map<string, Record<string, string>>();
    let updated = 0;
    if (index.length > 0) {
      const candleMap = new Map<string, Candle[]>();
      for (const sym of batch) candleMap.set(sym, settled(await dailyCandles(sym).catch(() => [] as Candle[])));
      if (todayClosed && batch.size > 0) {
        await redis.sadd(triedKey, ...([...batch] as [string, ...string[]]));
        await redis.expire(triedKey, 2 * 86_400);
      }
      for (const e of pending) {
        const stock = candleMap.get(e.symbol);
        if (!stock || stock.length === 0) continue;
        const field = `${e.symbol}#${e.code}`;
        const rec = toEval(e, existing.get(e.day)?.[field]);
        let changed = false;
        for (const h of REWARD_HORIZONS) {
          const k = String(h) as "1" | "5" | "20";
          if (rec.o[k]) continue;
          const o = computeOutcome({ code: e.code, price: e.price, day: e.day, preOpen: e.session === "開盤前" }, stock, index, h);
          if (o) {
            rec.o[k] = o;
            changed = true;
          }
        }
        if (!changed) continue;
        updated++;
        const w = writes.get(e.day) ?? {};
        w[field] = JSON.stringify(rec);
        writes.set(e.day, w);
      }
      if (writes.size > 0) {
        const p = redis.pipeline();
        for (const [day, fields] of writes) {
          p.hset(`${EVAL_KEY_PREFIX}${day}`, fields);
          p.expire(`${EVAL_KEY_PREFIX}${day}`, TTL_SECONDS);
        }
        await p.exec();
      }
    }
    const remaining = symbols.length - batch.size;
    const evaluated = await rebuildAggregates(today);
    if (remaining <= 0 && index.length > 0) await redis.set(`${DONE_KEY_PREFIX}${today}`, "1", { ex: 2 * 86_400 });
    return { status: remaining > 0 ? "partial" : "done", updated, pendingSymbols: remaining, evaluated, ...(index.length ? {} : { reason: "加權指數日K抓不到，這次沒算獎勵" }) };
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

async function rebuildAggregates(today: string): Promise<number> {
  const records = await readEvalRecords(LEARNING_START_DAY, today);
  const basisStats = computeBasisStats(records, today);
  const matured: Record<string, number> = {};
  for (const h of REWARD_HORIZONS) matured[h] = records.filter((r) => r.o[String(h) as "1"]).length;
  const summary: LearningSummary = {
    generatedAt: new Date().toISOString(),
    evaluated: records.length,
    matured,
    byCode: summarizeByCode(records),
    basisStats,
    reviewCases: reviewCases(records),
    lessons: validateLessons(records, LESSONS),
    weightsEnabled: LEARNED_WEIGHTS_ENABLED,
    weightMinSamples: WEIGHT_MIN_SAMPLES,
  };
  const p = redis!.pipeline();
  p.set(SUMMARY_KEY, JSON.stringify(summary), { ex: TTL_SECONDS });
  p.set(SIMILAR_KEY, JSON.stringify(buildSimilarTable(records)), { ex: TTL_SECONDS });
  p.set(WEIGHTS_KEY, JSON.stringify(toWeightTable(basisStats)), { ex: TTL_SECONDS });
  await p.exec();
  return records.length;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  if (!kvEnabled || !redis) return fallback;
  const v = await redis.get(key).catch(() => null);
  return v == null ? fallback : parse<T>(v);
}

/** 成績看板讀的彙總（還沒跑過學習工作是 null）。 */
export function readLearningSummary(): Promise<LearningSummary | null> {
  return readJson<LearningSummary | null>(SUMMARY_KEY, null);
}

const memo = new Map<string, { at: number; value: Promise<unknown> }>();
/** 只放記憶體的小快取（彙總一天才變一次，不必再寫回 Redis）。 */
function memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** AI 問答相似案例用的小表（記憶體快取 10 分鐘）。 */
export function readSimilarTable(): Promise<SimilarTable> {
  return memoized(SIMILAR_KEY, () => readJson<SimilarTable>(SIMILAR_KEY, {}));
}

/** 目前啟用的依據權重表（LEARNED_WEIGHTS_ENABLED 打開後評等才會讀）。 */
export function readWeightTable(): Promise<WeightTable> {
  return memoized(WEIGHTS_KEY, () => readJson<WeightTable>(WEIGHTS_KEY, {}));
}

/** 評等日之後到今天（含今天收盤與否）有幾個平日——交易日數的上限（不扣國定假日）。 */
export function weekdaysAfter(day: string, today: string, preOpen: boolean, todayClosed: boolean): number {
  let n = 0;
  for (let d = preOpen ? day : addDays(day, 1); d <= today; d = addDays(d, 1)) {
    if (d === today && !todayClosed) break;
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
