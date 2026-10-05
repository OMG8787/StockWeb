import { fetchWithTimeout } from "@/lib/data/cache";
import { kvEnabled, redis } from "@/lib/data/kv";
import { AI_TEMPERATURE, type ChatTurn } from "./types";

// Google Gemini API (generativelanguage.googleapis.com) via plain REST call,
// so no extra SDK dependency is needed. Free tier: apply for a key at
// https://aistudio.google.com/apikey (no credit card required).
//
// Google retires model snapshots (and even "-latest" aliases) over time,
// and its ListModels endpoint can still list a model as
// generateContent-capable even after it's been retired for an account
// (observed: gemini-2.5-flash and gemini-2.0-flash both listed, both
// 404 in practice). So instead of trusting one guessed or listed name,
// we try candidates in order against the real generateContent endpoint
// and remember whichever one actually works.

interface ModelsListResponse {
  models?: Array<{
    name: string; // "models/gemini-x-y"
    supportedGenerationMethods?: string[];
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/**
 * ── 模型選擇（2026-10-05 實測，這把免費金鑰）──
 * - gemini-2.5-flash：ListModels 有列，但 generateContent 回 404「no longer available to new users」。
 * - gemini-flash-latest（＝gemini-3.8-flash）與其他非 lite 的 3.x flash：免費層「每模型每天 20 次」
 *   （quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier），而且是思考模型——思考 token 吃掉
 *   maxOutputTokens，gemini-3.5-flash 2/2 題「被輸出長度上限截斷」；尖峰時也常 503。
 * - gemini-flash-lite-latest（＝gemini-3.5-flash-lite）：正常、無思考、額度寬。
 * 所以分兩級：
 * - standard（AI 問答等量大的呼叫）：主力 lite；
 * - premium（每天少量、價值高：今日快報、今日建議／明日操作建議、AI 判斷層每日批次）：非 lite 思考模型，
 *   每個模型每天最多 GEMINI_PREMIUM_DAILY_CAP 次（Redis 計數、多模型輪替），用完或失敗就退回 lite。
 */
export type GeminiTier = "standard" | "premium";

/** standard 級偏好（依序）：lite。 */
export const GEMINI_STANDARD_PREFERRED = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
] as const;
/** premium 級偏好（依序）：非 lite 的 flash（思考模型）；沒列到的其他非 lite flash 接在後面。 */
export const GEMINI_PREMIUM_PREFERRED = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"] as const;
/** 免費層每個非 lite 模型每天 20 次；留 2 次安全邊際。計數日以太平洋時間為準（Google 配額在太平洋時間午夜重置）。 */
export const GEMINI_PREMIUM_DAILY_CAP = 18;
/** 思考模型的思考等級（Gemini 3 系列 generationConfig.thinkingConfig.thinkingLevel）。 */
export const GEMINI_THINKING_LEVEL = "low";
/** Gemini 2.5 系列用 thinkingBudget（token）。 */
export const GEMINI_THINKING_BUDGET = 1024;
/** 思考 token 也算進 maxOutputTokens：非 lite 模型呼叫時另外加這麼多，正文才不會被截斷。 */
export const GEMINI_THINKING_ALLOWANCE = 4096;
/** 不是一般文字生成用的模型（語音、圖片、向量、即時串流等），一律排除。 */
export const GEMINI_EXCLUDED_MODEL_PATTERN =
  /tts|image|embedding|vision|audio|live|aqa|robotics|computer-use|omni|transcribe|lyria|nano-banana|deep-research|antigravity/i;
export const GEMINI_LITE_PATTERN = /lite/i;

/** 非 lite 的 flash＝思考模型（要加 thinkingConfig、受每日配額限制）。 */
export function isGeminiThinkingModel(model: string): boolean {
  return /flash/i.test(model) && !GEMINI_LITE_PATTERN.test(model);
}

/**
 * 排序候選模型（純函式，有測試）。只留 flash 系列（pro 免費額度極少、gemma 品質不穩，不列入）。
 * standard：lite 偏好 → 其他 lite → 非 lite（受每日配額限制）；premium：非 lite 偏好 → 其他非 lite → lite。
 */
export function rankGeminiModels(names: string[], tier: GeminiTier = "standard"): string[] {
  const usable = [...new Set(names)].filter((n) => /flash/i.test(n) && !GEMINI_EXCLUDED_MODEL_PATTERN.test(n));
  const ordered = (pref: readonly string[], pool: string[]) => [
    ...pref.filter((m) => pool.includes(m)),
    ...pool.filter((m) => !pref.includes(m)),
  ];
  const lite = ordered(GEMINI_STANDARD_PREFERRED, usable.filter((n) => GEMINI_LITE_PATTERN.test(n)));
  const full = ordered(GEMINI_PREMIUM_PREFERRED, usable.filter((n) => !GEMINI_LITE_PATTERN.test(n)));
  return tier === "premium" ? [...full, ...lite] : [...lite, ...full];
}

// ── 404 的模型：記住、之後不再嘗試（記憶體＋Redis 30 天） ──
const DEAD_MODELS_KEY = "gemini:dead-models:v1";
const DEAD_MODELS_TTL_SEC = 30 * 86400;
const deadModels = new Set<string>();
let deadLoadedAt = 0;

async function loadDeadModels(): Promise<Set<string>> {
  if (kvEnabled && redis && Date.now() - deadLoadedAt > 10 * 60_000) {
    deadLoadedAt = Date.now();
    try {
      for (const m of (await redis.smembers(DEAD_MODELS_KEY)) ?? []) deadModels.add(String(m));
    } catch {
      /* fail open */
    }
  }
  return deadModels;
}

function markDead(model: string): void {
  deadModels.add(model);
  if (kvEnabled && redis) {
    const r = redis;
    void r
      .sadd(DEAD_MODELS_KEY, model)
      .then(() => r.expire(DEAD_MODELS_KEY, DEAD_MODELS_TTL_SEC))
      .catch(() => {});
  }
}

// ── 非 lite 模型每日配額 ──
function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}
const quotaKey = (model: string) => `gemini:calls:${pacificDay()}:${model}`;
const memQuota = new Map<string, number>();

/** 非 lite 模型先佔一次名額（INCR 原子操作）；超過上限回 false。Redis 失敗時退回記憶體計數。 */
async function reserveThinkingCall(model: string): Promise<boolean> {
  const key = quotaKey(model);
  if ((memQuota.get(key) ?? 0) > GEMINI_PREMIUM_DAILY_CAP) return false;
  let n: number;
  try {
    if (!kvEnabled || !redis) throw new Error("no kv");
    n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 2 * 86400);
  } catch {
    n = (memQuota.get(key) ?? 0) + 1;
    memQuota.set(key, n);
  }
  return n <= GEMINI_PREMIUM_DAILY_CAP;
}

/** 收到 429（今天額度用完）：把計數直接設滿，其他執行個體也不再嘗試。 */
function markExhausted(model: string): void {
  const key = quotaKey(model);
  memQuota.set(key, GEMINI_PREMIUM_DAILY_CAP + 1);
  if (kvEnabled && redis) void redis.set(key, GEMINI_PREMIUM_DAILY_CAP + 1, { ex: 2 * 86400 }).catch(() => {});
}

/** fetchWithTimeout 的錯誤訊息是「HTTP 404 for …: body」，從中取出狀態碼。 */
function httpStatusOf(err: unknown): number | null {
  const m = /HTTP (\d{3})/.exec(String(err instanceof Error ? err.message : err));
  return m ? Number(m[1]) : null;
}

// 每個金鑰＋等級最後一次成功的模型，多數請求直接用它、不重新探測。
const knownGoodModel = new Map<string, string>();
const MAX_CANDIDATES = 4;
/** ListModels 結果記 1 小時，不必每次探測都多打一次。 */
const MODEL_LIST_TTL_MS = 60 * 60_000;
let modelListCache: { at: number; keyId: string; names: string[] } | null = null;

async function listCandidateModels(apiKey: string, tier: GeminiTier): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  const keyId = apiKey.slice(-8);
  let names =
    modelListCache && modelListCache.keyId === keyId && Date.now() - modelListCache.at < MODEL_LIST_TTL_MS ? modelListCache.names : null;
  if (!names) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`;
    const res = await fetchWithTimeout(url, 6000);
    const data = (await res.json()) as ModelsListResponse;
    names = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    if (names.length === 0) throw new Error("這組 Gemini API 金鑰目前沒有任何可用的生成模型");
    modelListCache = { at: Date.now(), keyId, names };
  }
  const dead = await loadDeadModels();
  const ranked = rankGeminiModels(names, tier).filter((m) => !dead.has(m));
  // 每一級最多試 MAX_CANDIDATES 個，但一定保留 lite 備援（premium 的非 lite 全部 429／503 時退回 lite）。
  const head = ranked.slice(0, MAX_CANDIDATES);
  const liteBackup = ranked.filter((m) => GEMINI_LITE_PATTERN.test(m) && !head.includes(m)).slice(0, 1);
  return [...head, ...liteBackup];
}

export interface GeminiCallOptions {
  /** Widened from an original 8s once chips/announcements/fundamentals/
   *  dual-locale news made the grounding prompt noticeably bigger — a
   *  longer input increases generation time, so 8s started occasionally
   *  aborting valid, in-progress responses rather than a real stall. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** 模型等級（見上方說明），預設 standard（lite）。 */
  tier?: GeminiTier;
}

/** generationConfig（純函式，有測試）：思考模型加 thinkingConfig，maxOutputTokens 另加思考預算。 */
export function geminiGenerationConfig(model: string, maxOutputTokens = 1000): Record<string, unknown> {
  const thinking = isGeminiThinkingModel(model);
  return {
    maxOutputTokens: maxOutputTokens + (thinking ? GEMINI_THINKING_ALLOWANCE : 0),
    temperature: AI_TEMPERATURE,
    ...(thinking
      ? { thinkingConfig: /gemini-2\./.test(model) ? { thinkingBudget: GEMINI_THINKING_BUDGET } : { thinkingLevel: GEMINI_THINKING_LEVEL } }
      : {}),
  };
}

async function callGemini(
  model: string,
  system: string,
  messages: ChatTurn[],
  apiKey: string,
  options: GeminiCallOptions
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetchWithTimeout(url, options.timeoutMs ?? 12000, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      // Gemini uses "model" rather than "assistant" for the AI's turns.
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: geminiGenerationConfig(model, options.maxOutputTokens),
    }),
  });

  const data = (await res.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new Error(data.promptFeedback?.blockReason ?? `Gemini（${model}）回應為空`);
  }
  // A response cut off by the output-token cap reads as a sentence stopping
  // mid-word (observed on the daily brief once it grew to 550-800 Chinese
  // characters — CJK text costs noticeably more tokens per character than
  // the maxOutputTokens budget assumed, and that got silently served to
  // every visitor for the rest of the day since a non-empty string was
  // still "success" as far as this function was concerned). Surfacing it as
  // a failure here lets the caller fall through to Anthropic, or to the
  // canned "raw data" answer, instead of quietly shipping a broken-off reply.
  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error(`Gemini（${model}）回覆被輸出長度上限截斷`);
  }
  return text.trim();
}

export async function askGemini(
  system: string,
  messages: ChatTurn[],
  apiKey: string,
  options: GeminiCallOptions = {}
): Promise<string> {
  return (await askGeminiWithModel(system, messages, apiKey, options)).text;
}

/** 同 askGemini，另外回傳實際回答的模型名稱（每則 AI 回答標示模型用）。 */
export async function askGeminiWithModel(
  system: string,
  messages: ChatTurn[],
  apiKey: string,
  options: GeminiCallOptions = {}
): Promise<{ text: string; model: string }> {
  const tier = options.tier ?? "standard";
  const cacheKey = `${apiKey.slice(-8)}:${tier}`;
  const known = knownGoodModel.get(cacheKey);
  const candidates = await listCandidateModels(apiKey, tier);
  // 上次成功的模型排第一（仍在候選內才用）；但 premium 時只要偏好更前面的模型額度還在就照偏好順序。
  const order = tier === "standard" && known && candidates.includes(known) ? [known, ...candidates.filter((m) => m !== known)] : candidates;

  let lastError: unknown = new Error("沒有任何 Gemini 模型可用");
  for (const model of order) {
    if (isGeminiThinkingModel(model) && !process.env.GEMINI_MODEL && !(await reserveThinkingCall(model))) {
      lastError = new Error(`Gemini（${model}）今日免費額度已用到上限 ${GEMINI_PREMIUM_DAILY_CAP} 次`);
      continue;
    }
    try {
      const text = await callGemini(model, system, messages, apiKey, options);
      knownGoodModel.set(cacheKey, model);
      return { text, model };
    } catch (err) {
      lastError = err;
      if (known === model) knownGoodModel.delete(cacheKey);
      const status = httpStatusOf(err);
      // 只有「模型下架」的 404 才永久排除（避免把一般路徑錯誤也記成下架）。
      if (status === 404 && /no longer available|not found|is not supported/i.test(String(err))) markDead(model);
      if (status === 429 && isGeminiThinkingModel(model)) markExhausted(model);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
