import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@/lib/data/cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/data/cache")>()),
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

import { fetchMisRows, misSnapshotMs, resetMisSnapshotMemory } from "@/lib/data/twse";

/**
 * 2026-10-06 正式站實測：MIS 後端多節點新舊不一，同一支股票 09:57:24 回快照 09:59:50，
 * 09:57:54 卻回 09:58:30（落後 112 秒）。只在盤中、只對指定幾檔的請求，遇到落後的節點就重打、挑最新快照。
 */
const resp = (sysTime: string, rows: unknown[] = [{ c: "2317", tag: sysTime }]) => ({
  json: async () => ({ msgArray: rows, queryTime: { sysDate: "20261006", sysTime } }),
});

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(2_000);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T02:00:00Z")); // 台北週二 10:00，盤中
  fetchMock.mockReset();
  resetMisSnapshotMemory();
});
afterEach(() => vi.useRealTimers());

describe("misSnapshotMs", () => {
  it("sysDate＋sysTime 當台北時間", () => {
    expect(misSnapshotMs({ queryTime: { sysDate: "20261006", sysTime: "09:59:50" } })).toBe(Date.parse("2026-10-06T01:59:50Z"));
    expect(misSnapshotMs({})).toBeUndefined();
    expect(misSnapshotMs({ queryTime: { sysDate: "x", sysTime: "09:59:50" } })).toBeUndefined();
  });
});

describe("fetchMisRows 落後節點防護", () => {
  it("遇到比已看過最新快照落後 >15 秒的回應 → 重打，回傳較新的那份", async () => {
    fetchMock.mockResolvedValueOnce(resp("09:59:50")); // 先看過最新
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    fetchMock.mockResolvedValueOnce(resp("09:58:30")).mockResolvedValueOnce(resp("10:00:00"));
    const rows = await run(fetchMisRows<{ tag: string }>("tse_2317.tw", 4000, { retryStale: true }));
    expect(rows[0].tag).toBe("10:00:00");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("一直都是落後節點 → 最多重打 2 次（共 3 次請求），回傳其中最新的", async () => {
    fetchMock.mockResolvedValueOnce(resp("09:59:50"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resp("09:58:30")).mockResolvedValueOnce(resp("09:58:40")).mockResolvedValueOnce(resp("09:58:35"));
    const rows = await run(fetchMisRows<{ tag: string }>("tse_2317.tw", 4000, { retryStale: true }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows[0].tag).toBe("09:58:40");
  });

  it("只有輕微落後（≤15 秒）或沒落後 → 不重打", async () => {
    fetchMock.mockResolvedValueOnce(resp("09:59:50"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resp("09:59:40"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("冷啟動 instance（沒看過任何快照）第一次就打到落後 >35 秒的節點 → 也會重打", async () => {
    fetchMock.mockResolvedValueOnce(resp("09:58:30")).mockResolvedValueOnce(resp("09:59:50")); // 現在 10:00:00
    const rows = await run(fetchMisRows<{ tag: string }>("tse_2317.tw", 4000, { retryStale: true }));
    expect(rows[0].tag).toBe("09:59:50");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("13:30 後快照停在收盤時間是正常的（不套牆鐘規則，不重打）", async () => {
    vi.setSystemTime(new Date("2026-10-06T06:40:00Z")); // 台北 14:40
    fetchMock.mockResolvedValueOnce(resp("13:30:05"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("沒開 retryStale（全市場表）→ 不重打，照用", async () => {
    fetchMock.mockResolvedValueOnce(resp("09:59:50"));
    await run(fetchMisRows("tse_2317.tw", 4000));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resp("09:50:00"));
    const rows = await run(fetchMisRows<{ tag: string }>("tse_2317.tw", 4000));
    expect(rows[0].tag).toBe("09:50:00");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("非盤中（週六）→ 不重打", async () => {
    vi.setSystemTime(new Date("2026-10-03T02:00:00Z"));
    fetchMock.mockResolvedValueOnce(resp("09:59:50"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resp("09:00:00"));
    await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("回應沒有快照時間 → 無法判斷，照用不重打；上游失敗照舊丟出", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ msgArray: [{ c: "2317" }] }) });
    expect(await run(fetchMisRows("tse_2317.tw", 4000, { retryStale: true }))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRejectedValueOnce(new Error("HTTP 503"));
    const failing = fetchMisRows("tse_2317.tw", 4000, { retryStale: true });
    const caught = failing.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBe("HTTP 503");
  });
});
