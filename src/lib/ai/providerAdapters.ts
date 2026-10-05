import Anthropic from "@anthropic-ai/sdk";
import { askGeminiWithModel } from "./gemini";
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
//   AI 問答的系統提示詞本身就約 8,600 token（gpt-oss 分詞），附全文的新聞摘要
//   批次也約 9,000 token，所以 Groq 只接得住「新聞重大消息挑選」這類小請求；
//   gpt-oss-120b 約 1 秒回覆，最快，但實測挑選品質不及 Gemini（同一事件重複
//   挑、用「美聯儲」等中國用語），因此排在備援鏈最後。

export interface AdapterCallOptions {
  timeoutMs: number;
  maxOutputTokens: number;
  /** 格式固定、不需要推理的工作（見 CallAiProvidersOptions.simpleTask）。 */
  simpleTask?: boolean;
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
  /** 回傳文字與實際使用的模型 id（每則 AI 回答標示模型用，見 modelName.ts）。 */
  call(system: string, turns: ChatTurn[], options: AdapterCallOptions): Promise<{ text: string; model: string }>;
}

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
/** 推理模型的思考過程實測約 300~700 token，保留寬一點避免把正文擠掉被截斷。 */
const NVIDIA_REASONING_ALLOWANCE = 2048;
/** NVIDIA 免費層輸出速度實測約 60~70 token/秒：短回答 5~10 秒，單股／關注清單
 *  這類上千字的深度分析要 25~37 秒。逾時下限給寬，實際仍受整條鏈總時限壓縮。 */
const NVIDIA_MIN_TIMEOUT_MS = 40_000;
/** 推理保持開啟但走 low_effort：實測思考從約 600 token 降到約 100 token（省約 10 秒），
 *  回答長度與結構不變；完全關閉思考則深度分析只剩 300 多字，不採用。 */
const NVIDIA_EXTRA_BODY = { chat_template_kwargs: { enable_thinking: true, low_effort: true } };
/** 新聞挑選／摘要這類照格式回 JSON 的工作：開著思考實測 10 則摘要要 98 秒還被截斷，關掉。 */
const NVIDIA_SIMPLE_TASK_BODY = { chat_template_kwargs: { enable_thinking: false } };

const ANTHROPIC_MODEL = "claude-sonnet-5";

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
    askGeminiWithModel(system, turns, process.env.GEMINI_API_KEY ?? "", {
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
    const model = process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL;
    const { text } = await callOpenAiCompatible({
      label: "NVIDIA",
      url: NVIDIA_URL,
      apiKey: process.env.NVIDIA_API_KEY ?? "",
      model,
      system,
      turns,
      maxTokens: options.maxOutputTokens + (options.simpleTask ? 0 : NVIDIA_REASONING_ALLOWANCE),
      timeoutMs: options.timeoutMs,
      extraBody: options.simpleTask ? NVIDIA_SIMPLE_TASK_BODY : NVIDIA_EXTRA_BODY,
    });
    return { text, model };
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
    const model = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
    const { text, rateLimit } = await callOpenAiCompatible({
      label: "Groq",
      url: GROQ_URL,
      apiKey: process.env.GROQ_API_KEY ?? "",
      model,
      system,
      turns,
      maxTokens: options.maxOutputTokens + GROQ_REASONING_ALLOWANCE,
      timeoutMs: options.timeoutMs,
      extraBody: { reasoning_effort: "low" },
    });
    if (rateLimit.remainingTokens !== undefined && rateLimit.resetTokensMs !== undefined) {
      groqRemaining = { tokens: rateLimit.remainingTokens, resetAt: Date.now() + rateLimit.resetTokensMs };
    }
    return { text, model };
  },
};

const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: "Claude",
  // 本專案最高原則是「不能有任何花費」，Claude API 是唯一按用量計費的供應商，所以
  // 光是環境變數裡有金鑰不夠：還要明確設 ALLOW_PAID_AI=true 才會啟用。2026-10-04
  // 發現 Vercel 上其實留著一把 ANTHROPIC_API_KEY（9/9 新增，使用者不記得自己有用過 Claude API），
  // 在這道閘門之前，只要 Gemini／NVIDIA／Groq 全部失敗，系統就會悄悄改打這把金鑰而產生費用。
  isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY) && process.env.ALLOW_PAID_AI === "true",
  canHandle: () => true,
  // 接入前 Anthropic 沒有設逾時（SDK 預設很長）；這裡只用整條鏈剩下的時間當上限。
  preferredTimeoutMs: () => Number.POSITIVE_INFINITY,
  call: async (system, turns, options) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create(
      {
        model: ANTHROPIC_MODEL,
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
    return { text: answer, model: ANTHROPIC_MODEL };
  },
};

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: geminiAdapter,
  nvidia: nvidiaAdapter,
  groq: groqAdapter,
  anthropic: anthropicAdapter,
};
