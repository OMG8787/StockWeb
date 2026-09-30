import type { ChatTurn } from "./types";

// 共用的 OpenAI 相容 chat completions 呼叫（Groq、NVIDIA NIM 都走同一種格式）。
// 只負責「送一次請求、把結果或失敗原因整理好」，要不要重試、要不要跳過某家
// 供應商的判斷都在 provider.ts / providerHealth.ts，這裡不做。

export interface OpenAiCompatRequest {
  /** 供應商顯示名稱（錯誤訊息、log 用），例如 "Groq"。 */
  label: string;
  url: string;
  apiKey: string;
  model: string;
  system: string;
  turns: ChatTurn[];
  maxTokens: number;
  timeoutMs: number;
  /** 各家專屬參數（例如 Groq gpt-oss 的 reasoning_effort）。 */
  extraBody?: Record<string, unknown>;
}

export interface RateLimitInfo {
  /** 本分鐘剩餘可用 token（Groq 會回 x-ratelimit-remaining-tokens）。 */
  remainingTokens?: number;
  /** 距離 token 額度重置的毫秒數。 */
  resetTokensMs?: number;
}

/** 失敗時丟出的錯誤，帶 HTTP 狀態碼與 retry-after，讓熔斷器決定要跳過多久。 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | "timeout" | "network",
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
}

/** 解析 Groq 風格的時間長度字串，例如 "56.235s"、"1m26.4s"、"120ms"。 */
function parseDurationMs(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000; // retry-after 純秒數
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? total : undefined;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const remaining = headers.get("x-ratelimit-remaining-tokens");
  return {
    remainingTokens: remaining !== null && remaining !== "" ? Number(remaining) : undefined,
    resetTokensMs: parseDurationMs(headers.get("x-ratelimit-reset-tokens")),
  };
}

export async function callOpenAiCompatible(
  req: OpenAiCompatRequest
): Promise<{ text: string; rateLimit: RateLimitInfo }> {
  // 不用 cache.ts 的 fetchWithTimeout：它遇到非 2xx 會直接丟錯（拿不到
  // retry-after／限流 header），而且計時器在讀 body 之前就清掉了。這裡的逾時
  // 要涵蓋「等回應＋讀完 body」整段。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    return await sendRequest(req, controller.signal);
  } catch (err) {
    if (err instanceof ProviderHttpError) throw err;
    // fetch 本身或讀 body 期間被 abort／斷線，統一轉成帶分類的錯誤。
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = controller.signal.aborted || /abort/i.test(message);
    throw new ProviderHttpError(
      isTimeout ? `${req.label}（${req.model}）AI 回應逾時` : `${req.label}（${req.model}）連線失敗：${message}`,
      isTimeout ? "timeout" : "network"
    );
  } finally {
    clearTimeout(timer);
  }
}

async function sendRequest(
  req: OpenAiCompatRequest,
  signal: AbortSignal
): Promise<{ text: string; rateLimit: RateLimitInfo }> {
  const res = await fetch(req.url, {
    signal,
    cache: "no-store",
    method: "POST",
    headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        ...req.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      max_tokens: req.maxTokens,
      temperature: 0.4,
      ...req.extraBody,
    }),
  });

  const rateLimit = readRateLimit(res.headers);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 413 在 Groq 是「單一請求超過每分鐘 token 上限」，本質上也是限流。
    throw new ProviderHttpError(
      `${req.label}（${req.model}）HTTP ${res.status}：${body.slice(0, 200)}`,
      res.status,
      parseDurationMs(res.headers.get("retry-after")) ?? rateLimit.resetTokensMs
    );
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const choice = data.choices?.[0];
  // 有些推理模型的聊天模板會把思考過程以 <think>…</think> 夾在正文裡，一律去掉。
  const text = (choice?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // 被輸出長度上限截斷的回覆當作失敗（與 gemini.ts 的 MAX_TOKENS 判斷同理），
  // 否則半截回答會被當成功快取起來。
  if (choice?.finish_reason === "length") {
    throw new ProviderHttpError(`${req.label}（${req.model}）回覆被輸出長度上限截斷`, 200);
  }
  if (!text) throw new ProviderHttpError(`${req.label}（${req.model}）回傳了空白回覆`, 200);
  return { text, rateLimit };
}
