import { describe, expect, it } from "vitest";
import { currentCheckSlot } from "@/lib/strategy/simSlots";

const tpe = (day: string, hm: string) => new Date(`${day}T${hm}:00+08:00`);

describe("模擬倉盤中檢查時點", () => {
  it("10:00、11:30、13:00 各自一個窗口，窗口外與週末不執行", () => {
    const D = "2026-10-14"; // 週三
    expect(currentCheckSlot(tpe(D, "09:59"))).toBeNull();
    expect(currentCheckSlot(tpe(D, "10:00"))?.id).toBe("1000");
    expect(currentCheckSlot(tpe(D, "11:29"))?.id).toBe("1000");
    expect(currentCheckSlot(tpe(D, "11:30"))?.id).toBe("1130");
    expect(currentCheckSlot(tpe(D, "12:59"))?.id).toBe("1130");
    expect(currentCheckSlot(tpe(D, "13:00"))?.id).toBe("1300");
    expect(currentCheckSlot(tpe(D, "13:29"))?.id).toBe("1300");
    expect(currentCheckSlot(tpe(D, "13:30"))).toBeNull();
    expect(currentCheckSlot(tpe("2026-10-17", "10:30"))).toBeNull(); // 週六
  });
});
