import { describe, expect, it } from "vitest";
import { mergeAiExplanation, renderActionBrief, type ActionAiLayer, type ActionBriefPick } from "@/lib/ai/actionPicks";
import { actionAiLayerPrefix } from "@/lib/ai/actionBrief";
import { actionBriefTimeLabel, nextActionBriefSlotTime } from "@/lib/ai/aiSchedule";

const pick = (symbol: string, label = "建議買進"): ActionBriefPick => ({
  symbol,
  name: `股${symbol}`,
  code: "buy",
  label,
  holdingLabel: "可分批加碼",
  reason: "程式理由",
  plan: "現價可分批買",
});
const layer = (labels: Record<string, string>, notChaseSymbol: string | null = "9"): ActionAiLayer => ({
  labels,
  notChaseSymbol,
  ai: {
    market: "偏多",
    picks: { "1": { reason: "AI理由一", risk: "AI風險一" }, "2": { reason: "AI理由二" } },
    view: "最看好股1",
    confidence: "中",
    notChase: "法人在賣",
  },
});
const tpe = (iso: string) => new Date(`${iso}+08:00`);

describe("今日建議兩層合併（程式即時名單＋時點 AI 解說）", () => {
  it("名單沒變：全部沿用 AI 解說與看法", () => {
    const m = mergeAiExplanation([pick("1"), pick("2")], layer({ "1": "建議買進", "2": "建議買進" }), "9", "10:30");
    expect(m.stale).toEqual([]);
    expect(m.ai?.view).toBe("最看好股1");
    expect(m.ai?.notChase).toBe("法人在賣");
  });

  it("名單變動：新加入的股票用程式理由並標示下次更新時點；看法不顯示", () => {
    const m = mergeAiExplanation([pick("1"), pick("3")], layer({ "1": "建議買進", "2": "建議買進" }), "9", "10:30");
    expect(m.stale).toEqual(["3"]);
    expect(m.picks[1].reason).toBe("程式理由（解說將於下次更新（10:30）補上）");
    expect(m.ai?.view).toBeUndefined();
    const text = renderActionBrief({ stance: { briefMode: "today", nextOpenLabel: "" }, marketLine: "x", buy: m.picks, notChase: null, gainersAvailable: true, ai: m.ai });
    expect(text).toContain("理由：AI理由一");
    expect(text).not.toContain("AI理由二");
    expect(text).not.toContain("**我的看法**");
  });

  it("結論或價位改變：絕不沿用舊解說", () => {
    const changed = "建議買進（現價 110 可分批買；若拉回到 100 附近可加碼）";
    const m = mergeAiExplanation([pick("1", changed), pick("2")], layer({ "1": "建議買進", "2": "建議買進" }), "9", "11:00");
    expect(m.stale).toEqual(["1"]);
    expect(m.ai?.picks).not.toHaveProperty("1");
    expect(m.picks[0].reason).toContain("解說將於下次更新（11:00）補上");
  });

  it("不建議追換了一檔：不沿用舊句；沒有 AI 層時原樣", () => {
    expect(mergeAiExplanation([pick("1")], layer({ "1": "建議買進" }), "8", "x").ai?.notChase).toBeUndefined();
    expect(mergeAiExplanation([pick("1")], null, "8", "x")).toEqual({ picks: [pick("1")], ai: null, stale: [] });
  });

  it("下次更新時點、卡片兩個時間", () => {
    expect(nextActionBriefSlotTime(tpe("2026-10-06T10:14:00"))).toBe("10:30");
    expect(nextActionBriefSlotTime(tpe("2026-10-06T22:00:00"))).toBe("08:30");
    expect(actionBriefTimeLabel("2026-10-06T02:14:00.000Z", "2026-10-06T02:00:00.000Z", "Gemini 3.5 Flash")).toBe(
      "名單與價位即時（10:14），分析文字撰寫於 10:00（Gemini 3.5 Flash）"
    );
  });

  it("AI 解說不跨日、時段切換換一份（快取前綴帶日期＋時段）", () => {
    const a = actionAiLayerPrefix("2026-10-06", "today");
    expect(actionAiLayerPrefix("2026-10-07", "today")).not.toBe(a);
    expect(actionAiLayerPrefix("2026-10-06", "next-open")).not.toBe(a);
  });
});
