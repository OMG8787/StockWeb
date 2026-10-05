import { describe, expect, it } from "vitest";
import {
  buildPlan,
  parseActionBriefJson,
  PICK_GROUP_LIMIT,
  PULLBACK_GROUP_TITLE,
  renderActionBrief,
  selectNotChase,
  selectPickGroups,
  type ActionBriefPick,
} from "@/lib/ai/actionPicks";
import type { SiteRating } from "@/lib/ai/siteRating";

const rating = (code: SiteRating["code"], support: number, against = 0): SiteRating => ({
  code,
  label: code === "buy" ? "建議買進" : "建議等回檔再買（現價不買，等回到 95～100）",
  holdingCode: "hold",
  holdingLabel: "續抱",
  reason: "程式理由",
  supportCount: support,
  againstCount: against,
  zone: { low: 95, high: 100 },
  noChase: 112,
  exit: 92.5,
  chaseHits: [],
  riskNote: null,
});
const input = (symbol: string, code: SiteRating["code"], support: number, against = 0) => ({ symbol, name: `股${symbol}`, rating: rating(code, support, against) });
const pick = (symbol: string, code: ActionBriefPick["code"]): ActionBriefPick => ({
  symbol,
  name: `股${symbol}`,
  code,
  label: rating(code, 2).label,
  holdingLabel: "續抱",
  reason: "程式理由",
  plan: buildPlan(rating(code, 2), { briefMode: "today", nextOpenLabel: "10/6（二）" }),
});
const stance = { briefMode: "today" as const, nextOpenLabel: "10/6（二）" };

describe("selectPickGroups", () => {
  it("每組最多 3 檔、依支持數排序、去重", () => {
    const list = [
      input("1", "buy-on-pullback", 2),
      input("2", "buy-on-pullback", 4),
      input("3", "buy-on-pullback", 3),
      input("4", "buy-on-pullback", 2),
      input("5", "buy-on-pullback", 3, 1),
      input("2", "buy-on-pullback", 4),
      input("6", "buy-on-pullback", 2),
      input("7", "buy-on-pullback", 2),
      input("8", "buy", 2),
    ];
    const g = selectPickGroups(list);
    expect(g.pullback.map((p) => p.symbol)).toEqual(["2", "3", "5"]);
    expect(g.pullback).toHaveLength(PICK_GROUP_LIMIT);
    expect(g.buy.map((p) => p.symbol)).toEqual(["8"]);
  });
});

describe("selectNotChase", () => {
  const scored = [
    { symbol: "A", supportCount: 0, facets: [{ name: "籌碼面", verdict: "不支持" }] },
    { symbol: "B", supportCount: 1, facets: [{ name: "財報面（x）", verdict: "無資料" }] },
  ];
  it("排除建議名單裡的代號（互斥）", () => {
    const r = selectNotChase(
      [
        { symbol: "A", name: "甲", changePercent: 9.9 },
        { symbol: "B", name: "乙", changePercent: 7 },
      ],
      scored,
      ["A"]
    );
    expect(r?.symbol).toBe("B");
    expect(r?.weakFacets).toEqual(["財報面"]);
  });
  it("沒有符合的回 null", () => {
    expect(selectNotChase([{ symbol: "C", name: "丙", changePercent: 5 }], scored, [])).toBeNull();
  });
});

describe("renderActionBrief", () => {
  const buy = [pick("8", "buy")];
  const pullback = ["1", "2", "3", "4"].map((s) => pick(s, "buy-on-pullback"));
  const ai = parseActionBriefJson(
    '```json\n{"market":"偏多","order":["3","8","1","999"],"picks":{"3":{"reason":"外資買超","risk":"RSI偏高"},"999":{"reason":"名單外"}},"view":"最看好股3","confidence":"中","confidenceReason":"量能普通","notChase":"法人在賣","watch":"留意匯率"}\n```'
  );
  const text = renderActionBrief({
    stance,
    marketLine: "加權指數 +1%",
    buy,
    pullback,
    notChase: { symbol: "1", name: "股1", changePercent: 9.9, supportCount: 0, weakFacets: ["籌碼面"] },
    gainersAvailable: true,
    ai,
  });
  it("名單只用程式給的、每組最多 3 檔，AI 多寫的代號忽略", () => {
    expect(text).not.toContain("股999");
    expect(text).not.toContain("股4(");
    expect(text).toContain(`**${PULLBACK_GROUP_TITLE}**`);
    const pbSection = text.split(PULLBACK_GROUP_TITLE)[1].split("**我的看法**")[0];
    expect(pbSection.match(/^- \*\*/gm)).toHaveLength(3);
  });
  it("依 AI 排序偏好重排、價位由程式寫", () => {
    const pbSection = text.split(PULLBACK_GROUP_TITLE)[1];
    expect(pbSection.indexOf("股3(3)")).toBeLessThan(pbSection.indexOf("股1(1)"));
    expect(text).toContain("現價不買，等回到 95～100 再分批；買進後跌破 92.5 出場");
    expect(text).toContain("理由：外資買超。風險：RSI偏高。");
    expect(text).toContain("把握程度：中（量能普通）");
  });
  it("AI 失敗時 fallback 名單相同", () => {
    const fb = renderActionBrief({ stance, marketLine: "加權指數 +1%", buy, pullback, notChase: null, gainersAvailable: false, ai: null, failureNote: "429" });
    expect(fb).toContain("股8(8)");
    expect(fb).not.toContain("股4(");
    expect(fb).toContain("今日漲幅榜無資料");
    expect(fb).toContain("AI 白話說明暫時無法產生（429）");
  });
  it("明日操作建議：等回檔寫盤中回到區間可分批買", () => {
    expect(buildPlan(rating("buy-on-pullback", 2), { briefMode: "next-open", nextOpenLabel: "10/6（二）" })).toContain(
      "開盤不追；10/6（二）盤中回到 95～100 可分批買"
    );
  });
});

describe("AI JSON 容錯", () => {
  it("picks 的 key 寫成「名稱(代號)」或陣列也對得上；不建議追去掉重複名稱", () => {
    const base = { stance, marketLine: "x", buy: [pick("8", "buy")], pullback: [], gainersAvailable: true };
    const t1 = renderActionBrief({ ...base, notChase: null, ai: { picks: { "股8(8)": { reason: "AI理由甲" } } } as never });
    expect(t1).toContain("理由：AI理由甲");
    const t2 = renderActionBrief({ ...base, notChase: null, ai: { picks: [{ symbol: "8", reason: "AI理由乙" }] } as never });
    expect(t2).toContain("理由：AI理由乙");
    const t3 = renderActionBrief({
      ...base,
      notChase: { symbol: "4174", name: "浩鼎", changePercent: 10, supportCount: 0, weakFacets: [] },
      ai: { notChase: "浩鼎(4174)面向支持數為0，技術面、籌碼面皆未跟上" },
    });
    expect(t3).toContain("**不建議追**：浩鼎(4174) 今日 +10%，但面向支持數只有 0，技術面、籌碼面皆未跟上。");
  });
});
