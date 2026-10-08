import { describe, expect, it } from "vitest";
import { diffAlerts, diffLists, dueAlarms, formatAlert, normalizeAlarms } from "@/lib/strategy/alertFormat";

const item = (a: "buy" | "sell" | null, b: "buy" | "sell" | null) => ({
  symbol: "2330",
  name: "台積電",
  price: 1000,
  allBuy: a === "buy" && b === "buy",
  lines: [
    { id: "ai", name: "🤖 AI 建議策略（本站綜合評等）", current: b, summary: "建議買進" },
    { id: "s1", name: "我的策略", current: a, summary: "x" },
  ],
});

describe("即時提醒：通知格式", () => {
  it("標題是股票、每個策略一行，沒訊號寫觀察", () => {
    expect(formatAlert(item(null, "buy"))).toEqual({ title: "2330 台積電　1000", body: "AI 策略：買進（建議買進）\n我的策略：觀察" });
    expect(formatAlert(item("buy", "buy")).body).toBe("AI 策略：買進（建議買進）\n我的策略：買進\n✅ 全部 2 個策略都是買進");
    expect(formatAlert(item("sell", "sell")).body).toBe("AI 策略：先不要買\n我的策略：賣出");
  });
});

describe("即時提醒：比對訊號變化", () => {
  it("第一次看到就是買進要通知；第一次看到是賣出、或沒訊號不通知", () => {
    expect(diffAlerts({}, [item("buy", null)]).notices.map((n) => n.tone)).toEqual(["buy"]);
    expect(diffAlerts({}, [item("sell", null)]).notices).toEqual([]);
    expect(diffAlerts({}, [item(null, null)]).notices).toEqual([]);
  });

  it("新出現買進／賣出才通知（一檔一則，列出全部策略）；沒變化、變成觀察不通知", () => {
    let s = diffAlerts({}, [item(null, null)]).next;
    let r = diffAlerts(s, [item("buy", null)]);
    expect(r.notices).toEqual([{ title: "2330 台積電　1000", body: "AI 策略：觀察\n我的策略：買進", tone: "buy" }]);
    r = diffAlerts(r.next, [item("buy", null)]);
    expect(r.notices).toEqual([]);
    s = diffAlerts(r.next, [item(null, null)]).next;
    r = diffAlerts(s, [item("sell", null)]);
    expect(r.notices.map((n) => n.tone)).toEqual(["sell"]);
    expect(diffAlerts(s, [item("sell", null)], false).notices).toEqual([]); // 關掉賣出通知
  });
});

describe("定時提醒（鬧鐘）", () => {
  const alarms = normalizeAlarms([
    { id: "a1", time: "8:45", days: "weekdays", label: "開盤前" },
    { id: "a2", time: "20:00", days: "daily", enabled: false },
    { time: "25:00" },
  ]);
  // 2026-10-08（四）台北 08:47 ＝ UTC 00:47
  const thu0847 = new Date("2026-10-08T00:47:00Z");

  it("整理設定：補零、壞時間丟掉", () => {
    expect(alarms.map((a) => [a.id, a.time, a.days, a.enabled])).toEqual([
      ["a1", "08:45", "weekdays", true],
      ["a2", "20:00", "daily", false],
    ]);
  });

  it("時間到（10 分鐘內補響）、今天響過不再響、週末不響平日鬧鐘", () => {
    expect(dueAlarms(alarms, new Set(), thu0847).map((a) => a.id)).toEqual(["a1"]);
    expect(dueAlarms(alarms, new Set(["a1|2026-10-08"]), thu0847)).toEqual([]);
    expect(dueAlarms(alarms, new Set(), new Date("2026-10-08T00:40:00Z"))).toEqual([]); // 還沒到
    expect(dueAlarms(alarms, new Set(), new Date("2026-10-08T01:00:00Z"))).toEqual([]); // 超過 10 分鐘
    expect(dueAlarms(alarms, new Set(), new Date("2026-10-10T00:47:00Z"))).toEqual([]); // 週六
  });
});

describe("名單異動（關注清單、AI 今日建議名單）", () => {
  const n = (symbol: string, name = symbol) => ({ symbol, name });
  const day = "2026-10-08";

  it("關注清單：第一次只記錄；之後新增、移出各通知；讀不到（null）不動", () => {
    let r = diffLists({}, { watchlist: [n("2330", "台積電")], ai: null }, day);
    expect(r.notices).toEqual([]);
    expect(r.next.watchlist).toEqual(["2330"]);
    r = diffLists(r.next, { watchlist: [n("2330", "台積電"), n("2317", "鴻海")], ai: null }, day);
    expect(r.notices.map((x) => x.title)).toEqual(["⭐ 新增關注：2317 鴻海"]);
    r = diffLists(r.next, { watchlist: [n("2317", "鴻海")], ai: null }, day);
    expect(r.notices.map((x) => x.title)).toEqual(["⭐ 移出關注：2330"]);
    const kept = diffLists(r.next, { watchlist: null, ai: null }, day); // 暫時讀不到：不誤報全部移出
    expect(kept.notices).toEqual([]);
    expect(kept.next.watchlist).toEqual(["2317"]);
  });

  it("AI 建議名單：每天第一次發摘要，之後新增／移出各通知；隔天再發一次摘要", () => {
    let r = diffLists({}, { watchlist: null, ai: [n("6285", "啟碁"), n("2313", "華通")] }, day);
    expect(r.notices.map((x) => x.title)).toEqual(["🤖 今日 AI 建議名單（2 檔）"]);
    expect(r.notices[0].body).toBe(["6285 啟碁", "2313 華通"].join(String.fromCharCode(10)));
    r = diffLists(r.next, { watchlist: null, ai: [n("6285", "啟碁"), n("2313", "華通")] }, day);
    expect(r.notices).toEqual([]); // 沒變化不重複通知
    r = diffLists(r.next, { watchlist: null, ai: [n("6285", "啟碁"), n("4720", "德淵")] }, day);
    expect(r.notices.map((x) => x.title)).toEqual(["🤖 AI 新增建議：4720 德淵", "🤖 AI 移出建議：2313"]);
    r = diffLists(r.next, { watchlist: null, ai: [n("6285", "啟碁")] }, "2026-10-09");
    expect(r.notices.map((x) => x.title)).toEqual(["🤖 今日 AI 建議名單（1 檔）"]); // 隔天重新摘要
  });

  it("AI 名單還是空的（今天還沒產生）不發摘要，等有名單才發", () => {
    const r = diffLists({}, { watchlist: null, ai: [] }, day);
    expect(r.notices).toEqual([]);
    expect(r.next.aiSummaryDay).toBeUndefined();
    expect(diffLists(r.next, { watchlist: null, ai: [n("2330")] }, day).notices.length).toBe(1);
  });
});
