import { describe, expect, it } from "vitest";
import { chipsPhase, institutionalCacheSpec, CHIPS_PUBLISH_WINDOW_TTL_MS } from "@/lib/data/chipsPublishWindow";

// 台北時間 = UTC+8；2026-10-07 是週三、2026-10-10 是週六
const tpe = (iso: string) => new Date(`${iso}+08:00`);

describe("三大法人表快取分段", () => {
  it("公布前（14:30）→ a，TTL 用平常值", () => {
    const s = institutionalCacheSpec("k", 3_600_000, tpe("2026-10-07T14:30:00"));
    expect(s.key).toBe("k:2026-10-07:a");
    expect(s.ttlMs).toBe(3_600_000);
  });
  it("公布窗口（15:00～17:30）→ p，TTL 10 分鐘；跨過 15:00 key 不同", () => {
    const before = institutionalCacheSpec("k", 3_600_000, tpe("2026-10-07T14:59:00"));
    const after = institutionalCacheSpec("k", 3_600_000, tpe("2026-10-07T15:00:00"));
    expect(after.key).toBe("k:2026-10-07:p");
    expect(after.ttlMs).toBe(CHIPS_PUBLISH_WINDOW_TTL_MS);
    expect(after.key).not.toBe(before.key);
  });
  it("17:30 之後 → z；隔天 key 不同", () => {
    expect(institutionalCacheSpec("k", 1, tpe("2026-10-07T17:30:00")).key).toBe("k:2026-10-07:z");
    expect(institutionalCacheSpec("k", 1, tpe("2026-10-08T09:00:00")).key).toBe("k:2026-10-08:a");
  });
  it("週末沒有公布 → 一律 a", () => {
    expect(chipsPhase(tpe("2026-10-10T16:00:00")).phase).toBe("a");
  });
});
