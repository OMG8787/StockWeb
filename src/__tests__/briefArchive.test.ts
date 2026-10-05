import { describe, expect, it } from "vitest";
import { briefArchiveSlot, shouldWriteBriefArchive } from "@/lib/ai/briefArchive";

describe("briefArchive", () => {
  it("台北 17:00 前是 pre、之後是 post（UTC 09:00＝台北 17:00）", () => {
    expect(briefArchiveSlot(new Date("2026-10-05T08:59:00Z"))).toBe("pre");
    expect(briefArchiveSlot(new Date("2026-10-05T09:00:00Z"))).toBe("post");
    expect(briefArchiveSlot(new Date("2026-10-05T00:30:00Z"))).toBe("pre");
  });
  it("一天最多寫兩次：沒有存檔→寫；pre→post 覆蓋；其餘不寫", () => {
    expect(shouldWriteBriefArchive(null, "pre")).toBe(true);
    expect(shouldWriteBriefArchive(null, "post")).toBe(true);
    expect(shouldWriteBriefArchive({ slot: "pre" }, "pre")).toBe(false);
    expect(shouldWriteBriefArchive({ slot: "pre" }, "post")).toBe(true);
    expect(shouldWriteBriefArchive({ slot: "post" }, "post")).toBe(false);
    expect(shouldWriteBriefArchive({ slot: "post" }, "pre")).toBe(false);
  });
});
