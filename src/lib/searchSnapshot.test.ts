import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSearchSnapshots, getSearchSnapshot } from "./searchSnapshot";

describe("getSearchSnapshot", () => {
  beforeEach(() => {
    clearSearchSnapshots();
    vi.useRealTimers();
  });

  it("相同條件 10 秒內共用同一份結果與 id", async () => {
    const load = vi.fn(async () => [1, 2, 3]);
    const a = await getSearchSnapshot("k", load);
    const b = await getSearchSnapshot("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
  });

  it("帶快照 id 時即使資料已更新，仍回同一份（分頁不位移）", async () => {
    vi.useFakeTimers();
    let n = 0;
    const load = vi.fn(async () => [++n]);
    const a = await getSearchSnapshot("k", load);
    vi.advanceTimersByTime(30_000);
    const same = await getSearchSnapshot("k", load, a.id);
    expect(same.id).toBe(a.id);
    expect(same.items).toEqual([1]);
    const fresh = await getSearchSnapshot("k", load);
    expect(fresh.id).not.toBe(a.id);
    expect(fresh.items).toEqual([2]);
  });

  it("找不到快照 id 或條件不符時重新計算並回新 id", async () => {
    const load = vi.fn(async () => ["x"]);
    const a = await getSearchSnapshot("k1", load);
    const other = await getSearchSnapshot("k2", load, a.id);
    expect(other.id).not.toBe(a.id);
    const missing = await getSearchSnapshot("k1", load, "nope");
    expect(missing.id).toBe(a.id); // 10 秒內仍共用最新的
  });

  it("載入失敗不快取", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce([1]);
    await expect(getSearchSnapshot("k", load)).rejects.toThrow();
    expect((await getSearchSnapshot("k", load)).items).toEqual([1]);
  });
});
