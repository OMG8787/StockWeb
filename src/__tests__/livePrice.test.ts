import { describe, expect, it } from "vitest";
import { LIVE_QUOTE_PATTERN, formatLiveQuote, parseLiveQuotes, patchLiveQuotes, ratingPriceFromGrounding } from "@/lib/ai/livePrice";
import { renderActionBrief, type ActionBriefPick } from "@/lib/ai/actionPicks";

const NOW = new Date("2026-10-06T06:00:00.000Z");

describe("livePrice", () => {
  it("非今天的報價時間帶日期；沒有時間就不寫（不拿抓取時間頂替）", () => {
    expect(formatLiveQuote({ price: 100, changePercent: 0, tradeTime: "2026-10-05T05:30:00.000Z" }, null, NOW)).toBe("現價 100（0%，10/05 13:30）");
    expect(formatLiveQuote({ price: 100.5, changePercent: -2 }, null, NOW)).toBe("現價 100.5（-2%）");
  });
  it("美股標美元", () => {
    expect(formatLiveQuote({ price: 189.5, changePercent: 1.2, currency: "USD", tradeTime: "2026-10-05T20:00:00.000Z" }, null, NOW)).toBe("現價 189.5 美元（+1.2%，04:00）");
  });
  it("評等句「現價 234 可分批買」不會被當成現價片段，但現價片段會", () => {
    expect(LIVE_QUOTE_PATTERN.test("建議買進（現價 234 可分批買；若拉回到 221 附近可加碼）")).toBe(false);
    expect(LIVE_QUOTE_PATTERN.test("現價 2,585（+0.5%，13:31）")).toBe(true);
    expect(LIVE_QUOTE_PATTERN.test("現價 236（+7.1%，13:31；評等以 234 計算）")).toBe(true);
  });
  it("parseLiveQuotes／ratingPriceFromGrounding", () => {
    const g = "【即時報價】台表科(6278)：現價 234（+6.4%，13:31）\n【本站綜合評等】台表科(6278)：未持有：「建議買進」／已持有：「續抱」。理由：x。（評等以現價 230 計算，與今日建議同一份結論）";
    expect(parseLiveQuotes(g).get("6278")).toEqual({ name: "台表科", symbol: "6278", text: "現價 234（+6.4%，13:31）", price: 234 });
    expect(ratingPriceFromGrounding(g, "6278")).toBe(230);
  });
});

describe("今日建議卡現價", () => {
  const pick = (p: Partial<ActionBriefPick>): ActionBriefPick => ({ symbol: "6278", name: "台表科", label: "建議買進（現價 234 可分批買）", code: "buy", holdingLabel: "x", reason: "r", ...p });
  const render = (buy: ActionBriefPick[]) =>
    renderActionBrief({ stance: { briefMode: "today", nextOpenLabel: "" }, marketLine: "m", buy, notChase: null, gainersAvailable: true, ai: null });
  it("每檔結論後面接現價片段；前端輪詢後 patchLiveQuotes 只換那一檔那一行的片段", () => {
    const text = render([pick({ livePrice: "現價 234（+6.4%，13:31）" }), pick({ symbol: "6285", name: "啟碁", livePrice: "現價 256（+1.2%，13:31）" })]);
    expect(text).toContain("**台表科(6278)**：建議買進（現價 234 可分批買）。現價 234（+6.4%，13:31）。");
    const patched = patchLiveQuotes(text, { "6278": "現價 236（+7.1%，13:32；評等以 234 計算）" });
    expect(patched).toContain("建議買進（現價 234 可分批買）。現價 236（+7.1%，13:32；評等以 234 計算）。");
    expect(patched).toContain("現價 256（+1.2%，13:31）");
  });
  it("沒有現價（報價抓不到）就不寫", () => {
    expect(render([pick({})])).not.toContain("現價 234（");
  });
});
