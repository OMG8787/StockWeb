import Anthropic from "@anthropic-ai/sdk";
import { askGemini } from "./gemini";
import { callOpenAiCompatible } from "./openaiCompat";
import type { ProviderId } from "./providerHealth";
import type { ChatTurn } from "./types";

// 各家 AI 供應商的轉接層：每家都包成同一種介面，provider.ts 只需要依序呼叫、
// 不用知道各家 API 的差異。金鑰一律只從 process.env 讀，沒設定的供應商
// isConfigured() 回 false，整條備援鏈就當它不存在（跟接入前的行為完全一樣）。
//
// 模型選擇的實測依據（2026-10-01，免費層）：
// - NVIDIA NIM：81 個模型裡，kimi-k3／deepseek-v4.1-flash／glm-5.3／gemma-4-31b
//   在 90 秒內都沒回應（免費層排隊），nemotron-3-ultra 要 60 秒；只有
//   nemotron-3-super-120b-a12b 在本站 1 萬字系統提示詞下穩定約 4~7 秒回覆、
//   繁中正確。偶爾回 503 overloaded（交給熔斷器處理）。它是推理模型，思考過程
//   也吃 max_tokens，所以要額外預留（見 NVIDIA_REASONING_ALLOWANCE）；關掉思考
//   雖然快一點，但回答明顯變短、白話解釋變少，不划算。
// - Groq：免費層每個模型每分鐘只有 8,000 token（TPM，而且「提示詞＋max_tokens」
//   單一請求超過就直接 413），qwen3.8-27b 另有每分鐘 1,000 輸出 token 上限。
//   AI 問答的系統提示詞本身就約 8,600 token（gpt-oss 分詞），所以 Groq 只接得住
//   新聞摘要這類小請求；gpt-oss-120b 約 1 秒回覆，最快。

export interface AdapterCallOptions {
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** 顯示在失敗原因裡的名稱。 */
  label: string;
  isConfigured(): boolean;
  /** 這次請求的大小這家接不接得住（不接得住就直接跳過，不浪費一次呼叫）。 */
  canHandle(system: string, turns: ChatTurn[], maxOutputTokens: number): boolean;
  /** 這家的理想逾時時間（實際還會被整條備援鏈的總截止時間壓縮）。 */
  preferredTimeoutMs(callerTimeoutMs: number): number;
  call(system: string, turns: ChatTurn[], options: AdapterCallOptions): Promise<string>;
}

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
/** 推理模型的思考過程實測約 300~700 token，保留寬一點避免把正文擠掉被截斷。 */
const NVIDIA_REASONING_ALLOWANCE = 2048;
/** NVIDIA 比 Gemini 慢（實測 4~7 秒起跳，長輸出更久），給的逾時下限。 */
const NVIDIA_MIN_TIMEOUT_MS = 25_000;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
/** Groq 免費層每模型每分鐘 token 上限，留一點誤差空間。 */
const GROQ_REQUEST_TOKEN_BUDGET = 7600;
/** gpt-oss 的 reasoning_effort=low 實測思考約 10~50 token，保留一些。 */
const GROQ_REASONING_ALLOWANCE = 300;
/** 實測 gpt-oss 分詞下本站中文提示詞約 0.83 token／字，取保守值。 */
const GROQ_TOKENS_PER_CHAR = 0.9;
const GROQ_MAX_TIMEOUT_MS = 20_000;

/** Groq 回應 header 帶回的剩餘額度，用來在額度明顯不夠時直接跳過、不白撞 429。 */
let groqRemaining: { tokens: number; resetAt: number } | undefined;

function estimateGroqTokens(system: string, turns: ChatTurn[]): number {
  const chars = system.length + turns.reduce((sum, t) => sum + t.content.length, 0);
  return Math.ceil(chars * GROQ_TOKENS_PER_CHAR) + 20 * (turns.length + 1);
}

const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  label: "Gemini",
  isConfigured: () => Boolean(process.env.GEMINI_API_KEY),
  canHandle: () => true,
  preferredTimeoutMs: (callerTimeoutMs) => callerTimeoutMs,
  call: (system, turns, options) =>
    askGemini(system, turns, process.env.GEMINI_API_KEY ?? "", {
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
    }),
};

const nvidiaAdapter: ProviderAdapter = {
  id: "nvidia",
  label: "NVIDIA",
  isConfigured: () => Boolean(process.env.NVIDIA_API_KEY),
  canHandle: () => true,
  preferredTimeoutMs: (callerTimeoutMs) => Math.max(callerTimeoutMs, NVIDIA_MIN_TIMEOUT_MS),
  call: async (system, turns, options) => {
    const { text } = await callOpenAiCompatible({
      label: "NVIDIA",
      url: NVIDIA_URL,
      apiKey: process.env.NVIDIA_API_KEY ?? "",
      model: process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL,
      system,
      turns,
      maxTokens: options.maxOutputTokens + NVIDIA_REASONING_ALLOWANCE,
      timeoutMs: options.timeoutMs,
    });
    return text;
  },
};

const groqAdapter: ProviderAdapter = {
  id: "groq",
  label: "Groq",
  isConfigured: () => Boolean(process.env.GROQ_API_KEY),
  canHandle: (system, turns, maxOutputTokens) => {
    const need = estimateGroqTokens(system, turns) + maxOutputTokens + GROQ_REASONING_ALLOWANCE;
    if (need > GROQ_REQUEST_TOKEN_BUDGET) return false;
    if (groqRemaining && Date.now() < groqRemaining.resetAt && groqRemaining.tokens < need) return false;
    return true;
  },
  preferredTimeoutMs: (callerTimeoutMs) => Math.min(callerTimeoutMs, GROQ_MAX_TIMEOUT_MS),
  call: async (system, turns, options) => {
    const { text, rateLimit } = await callOpenAiCompatible({
      label: "Groq",
      url: GROQ_URL,
      apiKey: process.env.GROQ_API_KEY ?? "",
      model: process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL,
      system,
      turns,
      maxTokens: options.maxOutputTokens + GROQ_REASONING_ALLOWANCE,
      timeoutMs: options.timeoutMs,
      extraBody: { reasoning_effort: "low" },
    });
    if (rateLimit.remainingTokens !== undefined && rateLimit.resetTokensMs !== undefined) {
      groqRemaining = { tokens: rateLimit.remainingTokens, resetAt: Date.now() + rateLimit.resetTokensMs };
    }
    return text;
  },
};

const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: "Claude",
  isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  canHandle: () => true,
  // 接入前 Anthropic 沒有設逾時（SDK 預設很長）；這裡只用整條鏈剩下的時間當上限。
  preferredTimeoutMs: () => Number.POSITIVE_INFINITY,
  call: async (system, turns, options) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: options.maxOutputTokens,
        system,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
      },
      { timeout: options.timeoutMs }
    );
    const answer = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    // 被輸出長度上限截斷的回覆一樣當失敗（Opus QA 抓過：截斷的回答會被當成功
    // 快取，每日快報一快取就是 25 小時）。
    if (message.stop_reason === "max_tokens") throw new Error("Claude 回覆被輸出長度上限截斷");
    if (!answer) throw new Error("Claude 回傳了空白回覆");
    return answer;
  },
};

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: geminiAdapter,
  nvidia: nvidiaAdapter,
  groq: groqAdapter,
  anthropic: anthropicAdapter,
};
