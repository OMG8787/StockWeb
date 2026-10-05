import { ADAPTERS, type ProviderAdapter } from "./providerAdapters";
import {
  isProviderCoolingDown,
  recordProviderFailure,
  recordProviderSuccess,
  type ProviderId,
} from "./providerHealth";
import { normalizeZhTw } from "./zhTwNormalize";
import type { ChatTurn } from "./types";

export type { ChatTurn };

export interface ProviderResult {
  answer: string;
  usedAi: boolean;
  /** 實際回答的供應商（usedAi 為 true 時才有）。 */
  provider?: ProviderId;
  /** 實際回答的模型 id（usedAi 為 true 時才有；好讀名稱見 modelName.ts displayModelName） */
  model?: string;
  /** Set only when usedAi is false — what each configured provider said when it failed. */
  failureReason?: string;
}

export interface CallAiProvidersOptions {
  /** Per-provider request timeout in ms (default 12000). NVIDIA gets a
   *  higher floor since it's measurably slower; everything is additionally
   *  capped by `totalBudgetMs`. */
  timeoutMs?: number;
  /** Output token cap (default 1000). The daily brief passes a higher value
   *  since it generates a longer, four-section write-up than a typical chat
   *  answer. */
  maxOutputTokens?: number;
  /** 整條備援鏈（所有供應商加起來）最多花多久，預設 45 秒——所有呼叫 AI 的
   *  route 的 maxDuration 都是 60 秒，前面還要留時間抓 grounding，前一家逾時
   *  後也要留時間給下一家，但不能讓整個請求超過函式時限。 */
  totalBudgetMs?: number;
  /** 格式固定、不需要推理的工作（新聞挑選／摘要回 JSON）設 true：NVIDIA 會關閉
   *  思考模式（實測開著思考做 10 則摘要要 98 秒還被截斷）。不影響供應商順序。 */
  simpleTask?: boolean;
  /** 預設 true：輸出做繁中把關（簡體／日文新字體一對一轉回繁體，成段日文
   *  假名視為不合格改用下一家）。要求模型「原封不動抄回原文」的呼叫端要設
   *  false，否則原文裡的簡體字被轉掉會對不上。 */
  normalizeZhTw?: boolean;
}

const MAX_HISTORY_TURNS = 10;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1000;
const DEFAULT_TOTAL_BUDGET_MS = 45_000;
/** 剩下的時間少於這個就不再嘗試下一家（幾乎不可能在這麼短時間內回完）。 */
const MIN_ATTEMPT_MS = 3000;
const DEFAULT_ORDER: ProviderId[] = ["gemini", "nvidia", "groq", "anthropic"];

/**
 * 依序嘗試已設定金鑰的 AI 供應商（順序見 buildProviderChain），回傳第一個
 * 成功的文字回覆。聊天問答、每日快報、今日建議、新聞摘要都共用這一個入口，
 * 備援／熔斷／繁中把關行為一致。`messages` is the full turn sequence ending
 * with the latest user turn — pass a single-element array for a one-shot
 * (non-chat) generation like the daily brief.
 *
 * 沒設定任何新供應商金鑰時，行為與接入前完全相同（Gemini → Claude）。
 */
export async function callAiProviders(
  system: string,
  messages: ChatTurn[],
  options: CallAiProvidersOptions = {}
): Promise<ProviderResult> {
  const anyConfigured = Object.values(ADAPTERS).some((a) => a.isConfigured());
  if (!anyConfigured) {
    return {
      answer: "",
      usedAi: false,
      failureReason: "沒有偵測到任何 AI 服務金鑰（GEMINI_API_KEY／NVIDIA_API_KEY／GROQ_API_KEY／ANTHROPIC_API_KEY）。",
    };
  }

  // Bound how much history we forward regardless of what the caller sends,
  // to keep latency/cost predictable on a long-running conversation.
  //
  // Then drop any leading assistant turns the window cut into: providers
  // require the conversation to *start* with a user turn (Anthropic rejects
  // it outright, Gemini likewise). History arrives as user/assistant pairs,
  // so once a chat passed ~5 exchanges this slice began at an assistant turn
  // and every AI call 400'd — the widget quietly stopped answering and fell
  // back to the canned "raw data" reply for the rest of the conversation,
  // which reads as the AI having broken.
  let turns = messages.slice(-MAX_HISTORY_TURNS);
  const firstUser = turns.findIndex((t) => t.role === "user");
  turns = firstUser <= 0 ? turns : turns.slice(firstUser);

  // Providers also reject two consecutive turns with the same role. The chat
  // widget always alternates strictly so this never fires there, but
  // `messages` is caller-supplied, and a caller that ever passes two user (or
  // assistant) turns back to back would otherwise 400 the same way the
  // leading-assistant-turn bug used to.
  turns = turns.reduce<ChatTurn[]>((merged, turn) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.content = `${prev.content}\n${turn.content}`;
    } else {
      merged.push({ ...turn });
    }
    return merged;
  }, []);

  if (turns.length === 0) {
    return { answer: "", usedAi: false, failureReason: "沒有可送出的對話內容。" };
  }

  const callerTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const deadline = Date.now() + (options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS);
  const simpleTask = options.simpleTask ?? false;
  const chain = buildProviderChain(system, turns, maxOutputTokens);
  const failures: string[] = [];

  for (const adapter of chain) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      failures.push(`${adapter.label} 未嘗試：整體等待時間已用完`);
      continue;
    }
    const timeoutMs = Math.min(adapter.preferredTimeoutMs(callerTimeoutMs), remaining);
    const startedAt = Date.now();
    try {
      const { text: raw, model } = await adapter.call(system, turns, { timeoutMs, maxOutputTokens, simpleTask });
      const checked = options.normalizeZhTw === false ? { text: raw, fixedCount: 0 } : normalizeZhTw(raw);
      if ("rejectReason" in checked && checked.rejectReason) {
        console.error(`[ai] ${adapter.label} output rejected:`, checked.rejectReason);
        failures.push(`${adapter.label} ${checked.rejectReason}`);
        continue;
      }
      if (checked.fixedCount > 0) {
        console.warn(`[ai] ${adapter.label} output: fixed ${checked.fixedCount} simplified/Japanese chars`);
      }
      recordProviderSuccess(adapter.id);
      console.info(`[ai] answered by ${adapter.label} (${model}) in ${Date.now() - startedAt}ms`);
      return { answer: checked.text, usedAi: true, provider: adapter.id, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ai] ${adapter.label} call failed:`, message);
      recordProviderFailure(adapter.id, err);
      failures.push(`${adapter.label} 呼叫失敗：${humanizeProviderError(message)}`);
    }
  }

  if (failures.length === 0) failures.push("這次請求太大，已設定的 AI 服務都接不住");
  return { answer: "", usedAi: false, failureReason: failures.join(" / ") };
}

/**
 * 決定這次請求要依序嘗試哪些供應商：
 * - Gemini → NVIDIA → Groq → Claude。Gemini 是原本的主力、品質基準（實測名詞
 *   白話解釋、新聞挑選判斷都最好）；NVIDIA 接得住本站所有長提示詞、數字忠於
 *   參考資料，當第一備援；Groq 最快（約 1 秒）但免費層只接得住小請求，且實測
 *   新聞挑選會重複挑同一事件、用「美聯儲」等中國用語，品質不及 Gemini，只當
 *   最後的免費備援；Claude 付費，放最後。
 * - 環境變數 AI_PROVIDER_ORDER（例如 "nvidia,gemini"）可以整個覆寫順序，
 *   維運或本機測試備援鏈時用；沒列到的供應商就不會被呼叫。
 * 沒設定金鑰、或這次請求太大接不住的供應商直接排除；正在熔斷冷卻中的排到
 * 最後（全部都在冷卻時仍然照順序試，總比直接放棄好）。
 */
function buildProviderChain(system: string, turns: ChatTurn[], maxOutputTokens: number): ProviderAdapter[] {
  const order: ProviderId[] = parseProviderOrder(process.env.AI_PROVIDER_ORDER) ?? DEFAULT_ORDER;
  const usable = order
    .map((id) => ADAPTERS[id])
    .filter((a) => a.isConfigured() && a.canHandle(system, turns, maxOutputTokens));
  const healthy = usable.filter((a) => !isProviderCoolingDown(a.id));
  const cooling = usable.filter((a) => isProviderCoolingDown(a.id));
  return [...healthy, ...cooling];
}

function parseProviderOrder(value: string | undefined): ProviderId[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderId => s in ADAPTERS);
  return ids.length > 0 ? ids : undefined;
}

/**
 * The raw error from a failed provider call is useful in server logs (still
 * logged in full via console.error above) but not to an end user — an Opus
 * QA pass found the canned fallback answer showing the complete raw upstream
 * error, e.g. Gemini's full 429 JSON body ("You exceeded your current
 * quota, please check your plan and billing details..."). Common,
 * recognizable failure shapes get a short plain-language substitute instead;
 * anything else still gets shown (truncated) since some detail is better
 * than none when it's not a well-known "quota/rate limit" case.
 */
function humanizeProviderError(message: string): string {
  if (/HTTP 429|HTTP 413|rate.?limit|quota|too large/i.test(message)) return "AI 服務目前額度已用完，請稍後再試";
  if (/AbortError|operation was aborted|timed? ?out|逾時/i.test(message)) return "AI 回應逾時";
  if (/HTTP 5\d\d|overloaded/i.test(message)) return "AI 服務暫時忙碌中";
  return message.slice(0, 300);
}
