import { describe, expect, it } from "vitest";
import { diffAlerts } from "@/components/strategy/AlertWatcher";

const item = (a: "buy" | "sell" | null, b: "buy" | "sell" | null) => ({
  symbol: "2330",
  name: "台積電",
  price: 1000,
  allBuy: a === "buy" && b === "buy",
  lines: [
    { id: "s1", name: "策略一", current: a, summary: "x" },
    { id: "ai", name: "AI 建議策略", current: b, summary: "y" },
  ],
});

describe("即時提醒：比對訊號變化", () => {
  it("第一次只記錄、不通知（避免一打開就一堆通知）", () => {
    const r = diffAlerts({}, [item("buy", null)]);
    expect(r.toasts).toEqual([]);
  });

  it("訊號變成買進／賣出才通知；變成不動作不通知；全部買進另外通知一次", () => {
    let s = diffAlerts({}, [item(null, "sell")]).next;
    let r = diffAlerts(s, [item("buy", "sell")]);
    expect(r.toasts.map((t) => t.body)).toEqual(["策略一：出現買進訊號（x）"]);
    s = r.next;
    r = diffAlerts(s, [item("buy", "buy")]);
    expect(r.toasts.map((t) => t.body)).toEqual(["AI 建議策略：出現買進訊號（y）", "✅ 全部 2 個策略都是買進訊號"]);
    s = r.next;
    r = diffAlerts(s, [item("buy", "buy")]);
    expect(r.toasts).toEqual([]); // 沒變化不重複通知
    r = diffAlerts(r.next, [item(null, "buy")]);
    expect(r.toasts).toEqual([]); // 變成不動作不通知
  });
});
