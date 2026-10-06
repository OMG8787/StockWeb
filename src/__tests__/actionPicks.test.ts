import { describe, expect, it } from "vitest";
import {
  buildPlan,
  NOT_CHASE_TITLE,
  parseActionBriefJson,
  PICK_GROUP_LIMIT,
  renderActionBrief,
  selectNotChase,
  selectPickGroups,
  type ActionBriefPick,
} from "@/lib/ai/actionPicks";
import type { SiteRating } from "@/lib/ai/siteRating";

const rating = (code: SiteRating["code"], support: number, against = 0, pullbackAdd: number | null = null): SiteRating => ({
  code,
  label: code === "buy" ? (pullbackAdd != null ? `建議買進（現價 110 可分批買；若拉回到 ${pullbackAdd} 附近可加碼）` : "建議買進") : "建議先不要買",
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
  pullbackAdd,
  upgradeCondition: code === "avoid" ? "技術面轉為支持" : null,
});
const input = (symbol: string, support: number, against = 0, pullbackAdd: number | null = null) => ({
  symbol,
  name: `股${symbol}`,
  rating: rating("buy", support, against, pullbackAdd),
});
const pick = (symbol: string, code: ActionBriefPick["code"] = "buy"): ActionBriefPick => ({
  symbol,
  name: `股${symbol}`,
  code,
  label: rating(code, 2).label,
  holdingLabel: "續抱",
  reason: "程式理由",
  plan: buildPlan(rating(code, 2, 0, 100), { briefMode: "today", nextOpenLabel: "10/6（二）" }),
});
const stance = { briefMode: "today" as const, nextOpenLabel: "10/6（二）" };

describe("selectPickGroups（只剩建議買進一組）", () => {
  it("最多 5 檔、依支持數→不支持→貼近支撐優先排序、去重、先不要買不列", () => {
    const list = [
      input("1", 2),
      input("2", 4, 0, 100),
      input("3", 3),
      input("4", 2),
      input("5", 3, 1),
      input("2", 4),
      input("6", 2),
      input("7", 4),
      { symbol: "9", name: "股9", rating: rating("avoid", 5) },
    ];
    const g = selectPickGroups(list);
    expect(PICK_GROUP_LIMIT).toBe(5);
    expect(g.buy.map((p) => p.symbol)).toEqual(["7", "2", "3", "5", "1"]);
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
  const buy = ["1", "2", "3", "4", "5", "6", "8"].map((s) => pick(s));
  const ai = parseActionBriefJson(
    '```json\n{"market":"偏多","order":["3","8","1","999"],"picks":{"3":{"reason":"外資買超","risk":"RSI偏高"},"999":{"reason":"名單外"}},"view":"最看好股3","confidence":"中","confidenceReason":"量能普通","notChase":"法人在賣","watch":"留意匯率"}\n```'
  );
  const text = renderActionBrief({
    stance,
    marketLine: "加權指數 +1%",
    buy,
    notChase: { symbol: "9", name: "股9", changePercent: 9.9, supportCount: 0, weakFacets: ["籌碼面"] },
    gainersAvailable: true,
    ai,
    marketNote: "大盤偏弱提示：近60日加權報酬 +2.3%，歷史上此時技術強勢股常落後，宜降低部位或分批",
  });
  it("名單只用程式給的、最多 5 檔，AI 多寫的代號忽略；沒有等回檔組", () => {
    expect(text).not.toContain("股999");
    expect(text.match(/^- \*\*/gm)).toHaveLength(PICK_GROUP_LIMIT);
    expect(text).not.toMatch(/等回檔|現價不買/);
    expect(text).toContain(`**${NOT_CHASE_TITLE}**：股9(9)`);
  });
  it("順序由程式決定（不採用 AI 排序偏好）、價位由程式寫（現價可買＋單一加碼價＋出場）", () => {
    expect(text.indexOf("股1(1)")).toBeLessThan(text.indexOf("股3(3)"));
    expect(text).toContain("操作：現價可分批買；拉回到 100 附近可加碼；買進後跌破 92.5 出場。");
    expect(text).toContain("理由：外資買超。風險：RSI偏高。");
    // 把握程度由程式判定逐檔顯示，AI 的 confidence 不再顯示（2026-10-06）
    expect(text).not.toContain("把握程度：中（量能普通）");
  });
  it("大盤偏弱時頁首提示一次", () => {
    expect(text).toContain("**大盤偏弱提示**：近60日加權報酬 +2.3%");
    expect(text.match(/大盤偏弱提示/g)).toHaveLength(1);
  });
  it("AI 失敗時 fallback 名單相同", () => {
    const fb = renderActionBrief({ stance, marketLine: "加權指數 +1%", buy, notChase: null, gainersAvailable: false, ai: null, failureNote: "429" });
    expect(fb).toContain("股5(5)");
    expect(fb).not.toContain("股6(");
    expect(fb).toContain("今日漲幅榜無資料");
    expect(fb).toContain("AI 白話說明暫時無法產生（429）");
  });
  it("明日操作建議：建議買進寫「開盤或盤中可買」，不寫現價不買", () => {
    const plan = buildPlan(rating("buy", 2, 0, 100), { briefMode: "next-open", nextOpenLabel: "10/6（二）" });
    expect(plan).toBe("10/6（二）開盤或盤中可買（分批）；拉回到 100 附近可加碼；買進後跌破 92.5 出場");
  });
  it("先不要買不給計畫價位，只給改判條件", () => {
    const plan = buildPlan(rating("avoid", 1), stance);
    expect(plan).toBe("先不買；改判建議買進的條件：技術面轉為支持");
  });
});

describe("AI JSON 容錯", () => {
  it("picks 的 key 寫成「名稱(代號)」或陣列也對得上；不建議追去掉重複名稱", () => {
    const base = { stance, marketLine: "x", buy: [pick("8", "buy")], gainersAvailable: true };
    const t1 = renderActionBrief({ ...base, notChase: null, ai: { picks: { "股8(8)": { reason: "AI理由甲" } } } as never });
    expect(t1).toContain("理由：AI理由甲");
    const t2 = renderActionBrief({ ...base, notChase: null, ai: { picks: [{ symbol: "8", reason: "AI理由乙" }] } as never });
    expect(t2).toContain("理由：AI理由乙");
    const t3 = renderActionBrief({
      ...base,
      notChase: { symbol: "4174", name: "浩鼎", changePercent: 10, supportCount: 0, weakFacets: [] },
      ai: { notChase: "浩鼎(4174)面向支持數為0，技術面、籌碼面皆未跟上" },
    });
    expect(t3).toContain("**先不要買／不建議追**：浩鼎(4174) 今日 +10%，但面向支持數只有 0，技術面、籌碼面皆未跟上。");
  });
});
