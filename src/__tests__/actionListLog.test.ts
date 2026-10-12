import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ ratings: new Map<string, unknown>() }));
vi.mock("@/lib/data/kv", async () => {
  const { RuntimeKv } = await import("@/lib/data/runtimeKv");
  return { kvEnabled: true, redis: new RuntimeKv() };
});
vi.mock("@/lib/ai/stockRating", () => ({
  getStockRating: async (symbol: string) => state.ratings.get(symbol) ?? null,
}));

const { diffActionList, recordActionListChange, readActionListLog, removalExplanation, ACTION_LOG_KEY, ACTION_LOG_RETENTION_DAYS } = await import("@/lib/ai/actionListLog");
const { redis } = await import("@/lib/data/kv");
const { default: MarkdownLite } = await import("@/components/MarkdownLite");

const pick = (symbol: string, name: string, price = 100) => ({ symbol, name, label: "建議買進（可分批）", confidence: "本站把握程度：中", plan: "可分批買", reason: "法人買超", price });

describe("AI 建議清單紀錄", () => {
  it("新舊名單比對（代號大小寫不分）", () => {
    expect(diffActionList(null, ["6278", "2542"])).toEqual({ added: ["6278", "2542"], removed: [] });
    expect(diffActionList(["6278", "2542"], ["2542", "6909"])).toEqual({ added: ["6909"], removed: ["6278"] });
    expect(diffActionList(["abc1"], ["ABC1"])).toEqual({ added: [], removed: [] });
  });

  it("第一次記全部加入；沒變動不寫；有進出才寫，移出附當時評等與價位；讀取最新在前", async () => {
    const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 12, h, m)); // UTC＝台北 −8
    expect(await recordActionListChange({ picks: [pick("6278", "台表科", 272.5), pick("2542", "興富發", 40.2)], mode: "today", now: t(2, 0) })).toBe(2);
    expect(await recordActionListChange({ picks: [pick("2542", "興富發", 40.5), pick("6278", "台表科", 273)], mode: "today", now: t(2, 10) })).toBe(0); // 只是順序與價位變，名單沒變
    state.ratings.set("6278", { price: 280, rating: { code: "avoid", label: "建議先不要買", reason: "RSI 超買、技術面轉弱" } });
    expect(await recordActionListChange({ picks: [pick("2542", "興富發"), pick("6909", "創控", 47.85)], mode: "today", now: t(3, 30) })).toBe(2);

    const log = await readActionListLog();
    expect(log.map((e) => `${e.event}:${e.symbol}`)).toEqual(["remove:6278", "add:6909", "add:2542", "add:6278"]); // 最新在前
    const removed = log[0];
    expect(removed).toMatchObject({ day: "2026-10-12", time: "11:30", price: 280, label: "評等轉為建議先不要買", reason: "本站評等轉為不建議買進：RSI 超買、技術面轉弱" });
    expect(log[3]).toMatchObject({ event: "add", name: "台表科", price: 272.5, confidence: "本站把握程度：中", plan: "可分批買", listSize: 2 });
  });
});

describe("移出原因與保存期限", () => {
  it("移出原因依評等寫：轉為不買／仍是買進但被擠出／抓不到評等", () => {
    const r = (code: string, label: string, reason = "理由") => ({ rating: { code, label, reason } }) as never;
    expect(removalExplanation(r("avoid", "建議先不要買", "技術面破底"))).toEqual({ label: "評等轉為建議先不要買", reason: "本站評等轉為不建議買進：技術面破底" });
    expect(removalExplanation(r("buy", "建議買進（現價 25.6）"))).toMatchObject({ label: "仍是建議買進，但被擠出名單" });
    expect(removalExplanation(r("buy", "建議買進（現價 25.6）")).reason).toContain("名額上限");
    expect(removalExplanation(null)).toMatchObject({ label: "不在這次建議名單內" });
  });

  it("超過 30 天的紀錄：下一次寫入時清掉、讀取時也不回傳", async () => {
    await redis!.del(ACTION_LOG_KEY);
    await redis!.del("action-list-log:v1:last");
    const day = 86_400_000;
    const now = new Date("2026-10-12T05:00:00Z");
    const old = { day: "2026-09-01", time: "10:00", at: new Date(now.getTime() - (ACTION_LOG_RETENTION_DAYS + 5) * day).toISOString(), event: "add", symbol: "1101", name: "台泥", price: 30, label: "建議買進", listSize: 1, mode: "today" };
    const recent = { ...old, at: new Date(now.getTime() - 10 * day).toISOString(), symbol: "2002", name: "中鋼", day: "2026-10-02" };
    await redis!.rpush(ACTION_LOG_KEY, JSON.stringify(old), JSON.stringify(recent));
    expect((await readActionListLog()).map((e) => e.symbol)).toEqual(["2002"]); // 讀取就已經看不到過期的
    await recordActionListChange({ picks: [pick("2330", "台積電", 1000)], mode: "today", now });
    const raw = (await redis!.lrange<unknown>(ACTION_LOG_KEY, 0, -1)).map((v) => (typeof v === "string" ? (JSON.parse(v) as { symbol: string }) : (v as { symbol: string })).symbol);
    expect(raw).toEqual(["2002", "2330"]); // 過期的 1101 已被清掉，新的接在後面
  });
});

describe("文字裡每檔股票前的星號", () => {
  it("只在「名稱(代號)」前插入，一般文字不動，粗體裡的也會", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownLite, {
        text: "- 台表科(6278):建議買進\n我的看法：最好看**台表科(6278)**，其次興富發(2542)。無關文字(9999)",
        stocks: [{ symbol: "6278", name: "台表科" }, { symbol: "2542", name: "興富發" }],
        stockPrefix: (s) => createElement("b", { "data-star": s.symbol }, "★"),
      }),
    );
    expect(html.match(/data-star="6278"/g)).toHaveLength(2);
    expect(html.match(/data-star="2542"/g)).toHaveLength(1);
    expect(html).not.toContain('data-star="9999"');
    expect(html.indexOf("★")).toBeLessThan(html.indexOf("台表科(6278)")); // 星號在名稱前面
    expect(html).toContain("無關文字(9999)");
  });

  it("沒傳 stocks 時輸出跟以前完全一樣", () => {
    const plain = renderToStaticMarkup(createElement(MarkdownLite, { text: "- 台表科(6278)：**買進**" }));
    expect(plain).toBe("<ul class=\"list-disc space-y-0.5 pl-4\"><li>台表科(6278)：<strong>買進</strong></li></ul>");
  });
});
