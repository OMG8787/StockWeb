import { revalidate } from "./accounts";
import { REVALIDATE_MS, type SessionPayload } from "./sessionCookie";

/**
 * 「每 5 分鐘回試算表確認登入」的排程邏輯（proxy 呼叫）。
 *
 * Google Apps Script 每次呼叫要 2.5～5 秒（2026-10-07 實測），如果在請求當下同步確認，
 * 每個人每 5 分鐘就會有一次換頁卡住。所以有 Redis 時改成背景確認：
 *   1. cookie 過期 → 先看 Redis 有沒有背景確認好的結果（比 cookie 新）：有就套用（或登出）。
 *   2. 沒有 → 搶一個 60 秒的鎖，在背景（waitUntil）確認並把結果寫進 Redis，這次請求照舊放行。
 * 代價：停用／強制登出最慢「5 分鐘＋下一次操作」才生效。沒有 Redis（本機）時維持同步確認。
 */

/** 背景確認的結果（不含登入憑證本身） */
interface CachedResult {
  at: number;
  payload: Omit<SessionPayload, "t"> | null;
}

export interface MiniKv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts: { ex: number; nx?: boolean }): Promise<unknown>;
}

const resultKey = (sid: string) => `auth:rv:${sid}`;
const lockKey = (sid: string) => `auth:rvlock:${sid}`;
const RESULT_TTL_SEC = 30 * 60;
const LOCK_TTL_SEC = 60;

export type RefreshOutcome =
  /** 不需要確認，或背景確認已排程：沿用目前的 session */
  | { kind: "keep" }
  /** 套用新的 session（要重寫 cookie） */
  | { kind: "refresh"; session: SessionPayload }
  /** 登入已失效 */
  | { kind: "revoked" };

export async function refreshSession(
  session: SessionPayload,
  kv: MiniKv | null,
  waitUntil: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<RefreshOutcome> {
  if (now - session.chk <= REVALIDATE_MS) return { kind: "keep" };

  if (!kv) {
    // 同步確認（本機開發）；試算表暫時連不上就沿用舊資料，下一次請求再試
    try {
      const r = await revalidate(session);
      if (r.touch) waitUntil(r.touch().catch(() => {}));
      return r.payload ? { kind: "refresh", session: r.payload } : { kind: "revoked" };
    } catch (err) {
      console.warn("[auth] 登入確認失敗，暫時沿用舊資料", err);
      return { kind: "keep" };
    }
  }

  try {
    const cached = await kv.get<CachedResult>(resultKey(session.sid));
    // 只套用比 cookie 新的結果；套用後 cookie 的確認時間＝結果時間，5 分鐘後才會再排下一次確認
    // （若沿用結果裡的 chk，可能比 at 早，就會一直重用同一筆舊結果、永遠不再回試算表）
    if (cached && cached.at > session.chk) {
      if (!cached.payload) return { kind: "revoked" };
      return { kind: "refresh", session: { ...cached.payload, t: session.t, chk: cached.at } };
    }
    const locked = await kv.set(lockKey(session.sid), 1, { ex: LOCK_TTL_SEC, nx: true });
    if (locked) {
      waitUntil(
        (async () => {
          const r = await revalidate(session);
          await r.touch?.();
          let payload: CachedResult["payload"] = null;
          if (r.payload) {
            const { t: token, ...rest } = r.payload;
            void token; // 登入憑證不存進 Redis
            payload = rest;
          }
          // at＝排程當下的請求時間（必定晚於 cookie 的確認時間）
          const value: CachedResult = { at: now, payload };
          await kv.set(resultKey(session.sid), value, { ex: RESULT_TTL_SEC });
        })().catch((err) => console.warn("[auth] 背景登入確認失敗", err)),
      );
    }
  } catch (err) {
    console.warn("[auth] Redis 讀取失敗，這次略過登入確認", err);
  }
  return { kind: "keep" };
}

/** 把 Upstash Redis 包成 MiniKv（Upstash 的 set 選項型別是嚴格的聯集，不能直接傳） */
export function kvFromRedis(r: import("@upstash/redis").Redis | null): MiniKv | null {
  if (!r) return null;
  return {
    get: <T>(key: string) => r.get<T>(key),
    set: (key, value, opts) => (opts.nx ? r.set(key, value, { ex: opts.ex, nx: true }) : r.set(key, value, { ex: opts.ex })),
  };
}
