import { after } from "next/server";
import { getIndices, getMaterialAnnouncements } from "@/lib/data";
import { kvEnabled, redis } from "@/lib/data/kv";
import { fetchNews } from "@/lib/data/news";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { callAiProviders } from "./provider";
import { buildRatingLogEntry, RATING_LOG_KEY_PREFIX, type RatingLogEntry, type RatingSource } from "./ratingLog";
import { describeSiteRating, type RatingCode } from "./siteRating";
import type { StockRatingResult } from "./stockRating";
import { describeExperience } from "./learning/experienceText";
import { REGIME_LABEL } from "./learning/regime";
import { parseAiJudgments, type AiJudgment } from "./learning/aiAdjust";

/**
 * AI 判斷層（學習循環第二階段，有 I/O）：程式評等產生後，讓 AI 依新聞、產業、大盤情緒、相似案例、教訓，
 * 對程式評等「調升一級／維持／調降一級」並給一句理由（JSON），寫進評等紀錄的 `ai` 欄位，供冠軍／挑戰者比較。
 *
 * 零花費與免費額度（CLAUDE.md 最高原則）：
 * - 只在評等「實際被使用」時呼叫：今日建議名單（getActionBrief）、個股問答（ask → buildStockGrounding）。
 * - 每檔每個台北日最多一次 AI 判斷（Redis＋記憶體快取到當天結束）；多檔一起判斷時合成一次 AI 呼叫。
 * - 只判斷台股（獎勵、冠軍／挑戰者都以加權指數為基準，美股判斷了也無法評分）。
 * - 失敗（逾時、額度、格式錯）就維持程式評等，並記 30 分鐘失敗冷卻，不連續重試。
 * - 用既有 callAiProviders（temperature 0.2，見 types.ts AI_TEMPERATURE）。
 *
 * 判斷結果不改變使用者看到的結論（AI_ADJUST_AFFECTS_CONCLUSION=false），只多一行「AI 看法」。
 */

const JUDGE_KEY_PREFIX = "ai-judge:v1:";
const JUDGE_TTL_SECONDS = 30 * 3600;
const JUDGE_FAIL_COOLDOWN_MS = 30 * 60_000;
/** 一次 AI 呼叫最多判斷幾檔（今日建議名單最多 6 檔）。 */
export const AI_JUDGE_BATCH_MAX = 6;

type Stored = AiJudgment | { failed: true };

const memory = new Map<string, { value: Stored; until: number }>();
const inflight = new Map<string, Promise<Map<string, AiJudgment>>>();

const keyOf = (sym: string, day: string) => `${JUDGE_KEY_PREFIX}${day}:${sym}`;

async function readStored(keys: string[]): Promise<Map<string, Stored>> {
  const out = new Map<string, Stored>();
  const missing: string[] = [];
  for (const k of keys) {
    const hit = memory.get(k);
    if (hit && hit.until > Date.now()) out.set(k, hit.value);
    else missing.push(k);
  }
  if (missing.length > 0 && kvEnabled && redis) {
    try {
      const vals = (await redis.mget(...missing)) as Array<unknown>;
      missing.forEach((k, i) => {
        const v = vals[i];
        if (v == null) return;
        const parsed = (typeof v === "string" ? JSON.parse(v) : v) as Stored;
        out.set(k, parsed);
        memory.set(k, { value: parsed, until: Date.now() + 10 * 60_000 });
      });
    } catch {
      // fail open
    }
  }
  return out;
}

async function writeStored(entries: Array<[string, Stored]>, ttlMs: number): Promise<void> {
  for (const [k, v] of entries) memory.set(k, { value: v, until: Date.now() + ttlMs });
  if (!kvEnabled || !redis || entries.length === 0) return;
  try {
    const p = redis.pipeline();
    for (const [k, v] of entries) p.set(k, JSON.stringify(v), { ex: Math.ceil(ttlMs / 1000) });
    await p.exec();
  } catch {
    // fail open
  }
}

const AI_JUDGE_SYSTEM = [
  "你是台股研究網站的「AI 判斷層」。每檔股票本站已經用程式算好【本站綜合評等】（建議買進／建議等回檔再買／建議先不要買），你的工作只是判斷：根據附上的新聞、重大訊息、產業外部因子、大盤情緒、相似案例統計、相關教訓，這個程式評等要「調升一級（up）／維持（keep）／調降一級（down）」。",
  "原則：預設維持（keep）。只有在附上的資料裡有程式評分沒考慮到的明確證據時才調整（例如重大利空新聞、相關教訓的負向證據、大盤明顯轉弱、相似案例 5 日表現極差／極好且樣本數足夠）。程式已經考慮過的技術面、法人買賣超、估值、財報數字，不可再拿來當調整理由。",
  "reason 一句（≤50字、台灣繁體中文），必須引用資料裡的一個具體事實或數字；不可編造資料沒有的事。confidence 為「高／中／低」：證據越具體、越多來源同向越高。",
  '只能回傳一個 JSON 陣列，不要其他文字或 markdown：[{"symbol":"2330","adjust":"up|keep|down","reason":"…","confidence":"高|中|低"}]，每檔一個元素。',
].join("\n");

async function describeForJudge(r: StockRatingResult): Promise<string> {
  const [announcements, news, experience] = await Promise.all([
    getMaterialAnnouncements(r.symbol, r.market).catch(() => []),
    fetchNews(`${r.name} ${r.symbol}`, 8).catch(() => []),
    describeExperience(r).catch(() => [] as string[]),
  ]);
  const facets = r.facets.map((f) => `${f.name}【${f.verdict}】${f.detail}`).join("；");
  const sf = r.features?.sf;
  return [
    `### ${r.name}(${r.symbol})`,
    describeSiteRating(r.name, r.symbol, r.rating),
    `程式評分面向：${facets}`,
    `產業外部因子：${sf === "+" ? "偏利多" : sf === "-" ? "偏利空" : "無明顯方向／無資料"}`,
    `重大訊息：${announcements.slice(0, 3).map((a) => `${a.date} ${a.subject.slice(0, 60)}`).join("；") || "無"}`,
    `近期新聞標題：${news.slice(0, 5).map((n) => n.title).join("；") || "無"}`,
    ...experience,
  ].join("\n");
}

async function judgeBatch(rs: StockRatingResult[], day: string): Promise<Map<string, AiJudgment>> {
  const indices = await getIndices().catch(() => []);
  const regime = rs.find((r) => r.regime)?.regime;
  const market = [
    `大盤：${indices.map((i) => `${i.name} ${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%`).join("、") || "無資料"}`,
    regime ? `台股市況（加權指數 vs 60日均線）：${REGIME_LABEL[regime]}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const blocks = await Promise.all(rs.map(describeForJudge));
  const result = await callAiProviders(AI_JUDGE_SYSTEM, [{ role: "user", content: `${market}\n\n${blocks.join("\n\n")}` }], {
    timeoutMs: 20000,
    totalBudgetMs: 25000,
    maxOutputTokens: 300 + rs.length * 200,
    simpleTask: true,
    // 每日批次、價值高：非 lite 思考模型（每日配額，用完退回 lite，見 gemini.ts）。
    geminiTier: "premium",
  });
  const bases = new Map<string, RatingCode>(rs.map((r) => [r.symbol.toUpperCase(), r.rating.code]));
  const parsed = result.usedAi ? parseAiJudgments(result.answer, bases, new Date(), result.model ?? result.provider) : new Map<string, AiJudgment>();
  const ok: Array<[string, Stored]> = [];
  const failed: Array<[string, Stored]> = [];
  for (const r of rs) {
    const sym = r.symbol.toUpperCase();
    const j = parsed.get(sym);
    if (j) ok.push([keyOf(sym, day), j]);
    else failed.push([keyOf(sym, day), { failed: true }]);
  }
  if (!result.usedAi) console.warn("[ai-judge] AI 判斷失敗，維持程式評等：", result.failureReason);
  await Promise.all([writeStored(ok, JUDGE_TTL_SECONDS * 1000), writeStored(failed, JUDGE_FAIL_COOLDOWN_MS)]);
  return parsed;
}

/**
 * 取得多檔的 AI 判斷（快取命中直接回；沒有的合成一次 AI 呼叫）。只判斷台股；失敗的不在回傳 Map 裡。
 * `source`：第一次判斷時把 `ai` 寫進當天的評等紀錄（回應送出後才寫）。
 */
export async function getAiJudgments(rs: StockRatingResult[], source: RatingSource): Promise<Map<string, AiJudgment>> {
  const day = taipeiDayKey();
  const tw = rs.filter((r) => r.market === "TW");
  const out = new Map<string, AiJudgment>();
  if (tw.length === 0) return out;
  const stored = await readStored(tw.map((r) => keyOf(r.symbol.toUpperCase(), day)));
  const todo: StockRatingResult[] = [];
  for (const r of tw) {
    const sym = r.symbol.toUpperCase();
    const v = stored.get(keyOf(sym, day));
    if (v && !("failed" in v)) out.set(sym, v);
    else if (!v) todo.push(r);
  }
  const batch = todo.slice(0, AI_JUDGE_BATCH_MAX);
  if (batch.length === 0) return out;
  const flightKey = `${day}|${batch.map((r) => r.symbol).sort().join(",")}`;
  let p = inflight.get(flightKey);
  if (!p) {
    p = judgeBatch(batch, day).finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
    const byS = new Map(batch.map((r) => [r.symbol.toUpperCase(), r]));
    void p.then((m) => {
      for (const [sym, j] of m) {
        const r = byS.get(sym);
        if (r) attachAiToRatingLog(r, j, source);
      }
    }).catch(() => undefined);
  }
  const fresh = await p.catch(() => new Map<string, AiJudgment>());
  for (const [k, v] of fresh) out.set(k, v);
  return out;
}

/** 單檔版本（個股問答用），等不到 `waitMs` 就先回 null，判斷照樣在背景完成並快取。 */
export async function getAiJudgment(r: StockRatingResult, source: RatingSource, waitMs = 12_000): Promise<AiJudgment | null> {
  if (r.market !== "TW") return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs));
  const res = await Promise.race([getAiJudgments([r], source).then((m) => m.get(r.symbol.toUpperCase()) ?? null), timeout]).catch(
    () => null
  );
  return res;
}

/** 把 AI 判斷寫進當天評等紀錄的 `ai` 欄位（紀錄還沒寫就連同程式評等一起寫）。fail open。 */
function attachAiToRatingLog(r: StockRatingResult, j: AiJudgment, source: RatingSource): void {
  if (!kvEnabled || !redis || j.baseCode !== r.rating.code) return;
  const task = async () => {
    const entry = buildRatingLogEntry(r, source);
    const key = `${RATING_LOG_KEY_PREFIX}${entry.day}`;
    const field = `${entry.symbol}#${entry.code}`;
    const ai = { code: j.code, delta: j.delta, reason: j.reason, confidence: j.confidence, ...(j.model ? { model: j.model } : {}) };
    try {
      const existing = (await redis!.hget(key, field)) as RatingLogEntry | string | null;
      if (existing == null) {
        await redis!.hsetnx(key, field, JSON.stringify({ ...entry, ai }));
      } else {
        const e = (typeof existing === "string" ? JSON.parse(existing) : existing) as RatingLogEntry;
        if (!e.ai) await redis!.hset(key, { [field]: JSON.stringify({ ...e, ai }) });
      }
    } catch (err) {
      console.warn("[ai-judge] 寫入評等紀錄 ai 欄位失敗（略過）:", err);
    }
  };
  try {
    after(task);
  } catch {
    void task().catch(() => undefined);
  }
}
