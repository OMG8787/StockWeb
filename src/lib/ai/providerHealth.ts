import { ProviderHttpError } from "./openaiCompat";

// 簡單的供應商熔斷器：某家剛回 429／5xx／逾時，就在接下來一段時間直接跳過它，
// 不要讓每一個請求都先撞一次已知壞掉的供應商（Gemini 免費層撞 429 後，原本
// 每一題都要先白等一次失敗才輪到下一家）。狀態只存在單一 serverless 執行個體
// 的記憶體裡，冷啟動就歸零——這是刻意的：最壞情況只是多撞一次，不需要共用快取。

export type ProviderId = "gemini" | "nvidia" | "groq" | "anthropic";

const skipUntil = new Map<ProviderId, number>();

const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;
const SERVER_ERROR_COOLDOWN_MS = 60_000;
const TIMEOUT_COOLDOWN_MS = 60_000;
/** 上游給的 retry-after 太長（例如每日額度用完）時，最多也只跳過這麼久再試。 */
const MAX_COOLDOWN_MS = 10 * 60_000;

export function isProviderCoolingDown(id: ProviderId, now = Date.now()): boolean {
  return (skipUntil.get(id) ?? 0) > now;
}

/**
 * 依失敗類型決定要跳過多久；400 之類「這次請求本身的問題」（例如提示詞太長）
 * 不代表供應商壞了，不熔斷，下一個請求照樣可以試。
 */
export function recordProviderFailure(id: ProviderId, err: unknown, now = Date.now()): void {
  let cooldown = 0;
  if (err instanceof ProviderHttpError) {
    if (err.status === 429) cooldown = err.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS;
    else if (err.status === "timeout") cooldown = TIMEOUT_COOLDOWN_MS;
    else if (err.status === "network" || (typeof err.status === "number" && err.status >= 500)) {
      cooldown = SERVER_ERROR_COOLDOWN_MS;
    }
  } else {
    // Gemini／Anthropic 的錯誤是一般 Error，只能從訊息判斷。
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 429|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(message)) cooldown = RATE_LIMIT_COOLDOWN_MS;
    else if (/AbortError|aborted|timed? ?out/i.test(message)) cooldown = TIMEOUT_COOLDOWN_MS;
    else if (/HTTP 5\d\d|overloaded|529/i.test(message)) cooldown = SERVER_ERROR_COOLDOWN_MS;
  }
  if (cooldown > 0) skipUntil.set(id, now + Math.min(cooldown, MAX_COOLDOWN_MS));
}

export function recordProviderSuccess(id: ProviderId): void {
  skipUntil.delete(id);
}

/** 測試用：清掉所有熔斷狀態。 */
export function resetProviderHealth(): void {
  skipUntil.clear();
}
