import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cached } from "@/lib/data/cache";
import { cachedWithDegradedNullTtl } from "@/lib/data/degradedCache";
import { hasLivePollHeader, withLivePollWait } from "@/lib/data/livePollContext";
import {
  LIVE_POLL_REVALIDATE_WAIT_MS,
  LIVE_REVALIDATE_WAIT_MS,
  liveRevalidateWaitMs,
  liveSwrOptions,
} from "@/lib/data/swrPolicy";
import { LIVE_POLL_HEADER, livePollInit } from "@/lib/livePoll";
import { misTradeTimeIso } from "@/lib/data/twse";

/**
 * 2026-10-06 使用者：「盤中的股價與漲幅還是不夠即時，確定有 30 秒更新一次嗎？」
 * 根因：快取 TTL 25 秒 < 輪詢 30 秒，過期值只等背景重抓 1.5 秒，來不及就回「上一輪的舊值」。
 * 修法：前端輪詢請求帶 x-live-poll，伺服器對它把過期值的同步等待放寬到 6 秒；首次載入維持 1.5 秒。
 */

const pollReq = { headers: new Headers({ [LIVE_POLL_HEADER]: "1" }) };
const normalReq = { headers: new Headers() };

let seq = 0;
const nextKey = () => `live-poll-test:${++seq}`;

/** 先寫入一筆值（TTL 10ms），再讓它過期（仍在 SWR 寬限期內）。 */
async function makeStale(key: string, value: number | null) {
  await cachedWithDegradedNullTtl<number>(key, 10, 10, async () => value, liveSwrOptions("US"));
  await vi.advanceTimersByTimeAsync(50);
}

/** 第 n 次重抓要花 delayMs 才回新值（或丟錯）。 */
function slowLoad(value: number | "throw", delayMs: number) {
  return () =>
    new Promise<number>((resolve, reject) => {
      setTimeout(() => (value === "throw" ? reject(new Error("upstream down")) : resolve(value)), delayMs);
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("請求範圍的等待上限（liveRevalidateWaitMs）", () => {
  it("沒有輪詢標記：1.5 秒；輪詢請求：6 秒；包裝結束後恢復", async () => {
    expect(liveRevalidateWaitMs()).toBe(LIVE_REVALIDATE_WAIT_MS);
    expect(await withLivePollWait(normalReq, async () => liveRevalidateWaitMs())).toBe(LIVE_REVALIDATE_WAIT_MS);
    expect(await withLivePollWait(pollReq, async () => liveRevalidateWaitMs())).toBe(LIVE_POLL_REVALIDATE_WAIT_MS);
    expect(liveRevalidateWaitMs()).toBe(LIVE_REVALIDATE_WAIT_MS);
    expect(LIVE_POLL_REVALIDATE_WAIT_MS).toBeGreaterThan(LIVE_REVALIDATE_WAIT_MS);
  });

  it("標記只認 x-live-poll: 1；前端 helper 掛載那次不帶、之後每輪都帶", () => {
    expect(hasLivePollHeader(pollReq)).toBe(true);
    expect(hasLivePollHeader(normalReq)).toBe(false);
    expect(hasLivePollHeader({ headers: new Headers({ [LIVE_POLL_HEADER]: "0" }) })).toBe(false);
    expect(livePollInit({ mount: true })).toBeUndefined();
    expect(livePollInit({ mount: false })).toEqual({ headers: { [LIVE_POLL_HEADER]: "1" } });
  });

  it("標記在非同步呼叫鏈（含 liveSwrOptions）裡一路有效，且不會漏到別的請求", async () => {
    const [a, b] = await Promise.all([
      withLivePollWait(pollReq, async () => {
        await Promise.resolve();
        return liveSwrOptions("TW").revalidateWaitMs;
      }),
      withLivePollWait(normalReq, async () => liveSwrOptions("TW").revalidateWaitMs),
    ]);
    expect(a).toBe(LIVE_POLL_REVALIDATE_WAIT_MS);
    expect(b).toBe(LIVE_REVALIDATE_WAIT_MS);
  });
});

describe("過期值：輪詢請求等得到新值，首次載入維持 1.5 秒", () => {
  it("輪詢請求：重抓 3 秒完成 → 回新值（不是舊值）", async () => {
    const key = nextKey();
    await makeStale(key, 100);
    const p = withLivePollWait(pollReq, () =>
      cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, slowLoad(200, 3_000), liveSwrOptions("US"))
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await p).toBe(200);
  });

  it("首次載入（沒有標記）：重抓 3 秒 → 1.5 秒就回舊值，不讓使用者等", async () => {
    const key = nextKey();
    await makeStale(key, 100);
    const p = cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, slowLoad(200, 3_000), liveSwrOptions("US"));
    let settledAt = -1;
    const t0 = Date.now();
    void p.then(() => (settledAt = Date.now() - t0));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toBe(100);
    expect(settledAt).toBeLessThanOrEqual(1_500);
    // 背景仍把新值寫回，下一位拿到新值
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, slowLoad(300, 100), liveSwrOptions("US"))).toBe(200);
  });

  it("輪詢請求：上游太慢（8 秒）→ 6 秒上限一到就回舊值，不無限等", async () => {
    const key = nextKey();
    await makeStale(key, 100);
    const p = withLivePollWait(pollReq, () =>
      cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, slowLoad(200, 8_000), liveSwrOptions("US"))
    );
    await vi.advanceTimersByTimeAsync(LIVE_POLL_REVALIDATE_WAIT_MS);
    expect(await p).toBe(100);
  });

  it("輪詢請求：上游失敗 → 仍回舊值（降級路徑不變）", async () => {
    const key = nextKey();
    await makeStale(key, 100);
    const p = withLivePollWait(pollReq, () =>
      cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, slowLoad("throw", 500), liveSwrOptions("US"))
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(100);
  });

  it("輪詢請求：重抓得到降級值（null）→ 不覆蓋還能用的舊好值", async () => {
    const key = nextKey();
    await makeStale(key, 100);
    const p = withLivePollWait(pollReq, () =>
      cachedWithDegradedNullTtl<number>(key, 25_000, 1_000, async () => null, liveSwrOptions("US"))
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(100);
  });

  it("傳統 cached()（不開 SWR）不受標記影響", async () => {
    const key = nextKey();
    const load = vi.fn(async () => 7);
    expect(await withLivePollWait(pollReq, () => cached(key, 1_000, load))).toBe(7);
    expect(await withLivePollWait(pollReq, () => cached(key, 1_000, load))).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("misTradeTimeIso（MIS 上游資料時間，不是抓取時間）", () => {
  const now = Date.parse("2026-10-06T03:00:00Z");

  it("優先用 tlong（epoch 毫秒）", () => {
    expect(misTradeTimeIso({ tlong: "1791251465000" }, now)).toBe(new Date(1791251465000).toISOString());
  });

  it("沒有 tlong 時用 d＋t（台北時間）", () => {
    expect(misTradeTimeIso({ d: "20261006", t: "10:31:05" }, now)).toBe("2026-10-06T02:31:05.000Z");
  });

  it("缺值、格式錯、早於 2020、晚於現在 5 分鐘以上 → undefined（寧可不顯示）", () => {
    expect(misTradeTimeIso({}, now)).toBeUndefined();
    expect(misTradeTimeIso({ tlong: "abc", t: "x" }, now)).toBeUndefined();
    expect(misTradeTimeIso({ tlong: "1000000000000" }, now)).toBeUndefined();
    expect(misTradeTimeIso({ tlong: String(now + 10 * 60_000) }, now)).toBeUndefined();
  });
});
