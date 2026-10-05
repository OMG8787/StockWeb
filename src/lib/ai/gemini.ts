import { fetchWithTimeout } from "@/lib/data/cache";
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
}

// Per-key cache of the last model confirmed to actually work, so most
// requests skip straight to a single call instead of re-probing.
const knownGoodModel = new Map<string, { model: string; at: number }>();
/**
 * 備援模型（不是排序第一的偏好模型，例如偏好模型暫時 503 才落到 lite）只記這麼久，之後重新探測，
 * 免得一次暫時性忙碌就讓整個執行個體一直用最弱的模型（2026-10-05 正式站實際用到 gemini-flash-lite-latest）。
 */
export const GEMINI_FALLBACK_MODEL_TTL_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 4;

async function listCandidateModels(apiKey: string): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const res = await fetchWithTimeout(url, 6000);
  const data = (await res.json()) as ModelsListResponse;
  const usable = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  if (usable.length === 0) {
    throw new Error("這組 Gemini API 金鑰目前沒有任何可用的生成模型");
  }

  return rankGeminiModels(usable).slice(0, MAX_CANDIDATES);
}

/**
 * 明確偏好的 Gemini 模型（依序）。2026-10-05 正式站回饋顯示實際用到 gemini-flash-lite-latest（最弱）：
 * 原本照 ListModels 回傳順序挑第一個含 flash 的，lite 剛好排前面。改成具名偏好順序。
 */
export const GEMINI_PREFERRED_MODELS = ["gemini-2.5-flash", "gemini-flash-latest"] as const;
/** 不是一般文字生成用的模型（語音、圖片、向量、即時串流等），一律排除。 */
export const GEMINI_EXCLUDED_MODEL_PATTERN = /tts|image|embedding|vision|audio|live|aqa|robotics|computer-use|omni|transcribe|lyria|nano-banana|deep-research|antigravity/i;
/** lite 版只當最後備援。 */
export const GEMINI_LITE_PATTERN = /lite/i;

/**
 * 排序候選模型（純函式，有測試）：偏好清單 → 其他非 lite 的 flash → lite 的 flash → 其他（例如 pro／gemma）。
 * 同一層維持 ListModels 原順序。
 */
export function rankGeminiModels(names: string[]): string[] {
  const usable = [...new Set(names)].filter((n) => !GEMINI_EXCLUDED_MODEL_PATTERN.test(n));
  const preferred = GEMINI_PREFERRED_MODELS.filter((m) => usable.includes(m));
  const rest = usable.filter((n) => !(preferred as string[]).includes(n));
  const flash = rest.filter((n) => /flash/i.test(n));
  const flashFull = flash.filter((n) => !GEMINI_LITE_PATTERN.test(n));
  const flashLite = flash.filter((n) => GEMINI_LITE_PATTERN.test(n));
  const others = rest.filter((n) => !flash.includes(n));
  return [...preferred, ...flashFull, ...flashLite, ...others];
}

export interface GeminiCallOptions {
  /** Widened from an original 8s once chips/announcements/fundamentals/
   *  dual-locale news made the grounding prompt noticeably bigger — a
   *  longer input increases generation time, so 8s started occasionally
   *  aborting valid, in-progress responses rather than a real stall. */
  timeoutMs?: number;
  maxOutputTokens?: number;
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
      generationConfig: { maxOutputTokens: options.maxOutputTokens ?? 1000, temperature: AI_TEMPERATURE },
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
  const keyId = apiKey.slice(-8);
  const cached = knownGoodModel.get(keyId);
  const known =
    cached && (!GEMINI_LITE_PATTERN.test(cached.model) || Date.now() - cached.at < GEMINI_FALLBACK_MODEL_TTL_MS)
      ? cached.model
      : undefined;

  if (known) {
    try {
      return { text: await callGemini(known, system, messages, apiKey, options), model: known };
    } catch {
      knownGoodModel.delete(keyId); // it stopped working; re-probe below
    }
  }

  const candidates = await listCandidateModels(apiKey);
  let lastError: unknown;
  for (const model of candidates) {
    if (model === known) continue; // already just failed above
    try {
      const text = await callGemini(model, system, messages, apiKey, options);
      knownGoodModel.set(keyId, { model, at: Date.now() });
      return { text, model };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError) || "沒有任何 Gemini 模型可用");
}
