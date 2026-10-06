import { describe, expect, it } from "vitest";
import { confidenceRank, describeConfidenceGrades, ratingConfidence, type SiteRating } from "@/lib/ai/siteRating";
import { stateFromRatingLog } from "@/lib/ai/ratingConfirmStore";
import { selectPickGroups } from "@/lib/ai/actionPicks";
import { formatWatchRatingSummary, HOLDING_SUMMARY_TITLE, type HoldingRatingEntry } from "@/lib/ai/holdingRating";
import { guardHoldingsCoverage } from "@/lib/ai/ratingConsistencyGuard";
import { isListReferenceQuestion } from "@/lib/ai/intent";
import type { RatingLogEntry } from "@/lib/ai/ratingLog";

const r = (code: "buy" | "avoid", streak: number, weak = false, extra: Partial<SiteRating> = {}): SiteRating =>
  ({
    code, label: code === "buy" ? "建議買進" : "建議先不要買", holdingCode: code === "buy" ? "add" : "hold", holdingLabel: code === "buy" ? "可分批加碼" : "續抱觀察、不加碼",
    reason: "", supportCount: 3, againstCount: 0, zone: null, noChase: null, exit: null, chaseHits: [], riskNote: null,
    marketNote: weak ? "大盤偏弱提示" : null, confirmState: { code, holdingCode: "add", pending: null, day: "2026-10-06", streak }, ...extra,
  }) as SiteRating;

describe("ratingConfidence（回測驗證：高＞中＞低）", () => {
  it("高＝大盤不偏弱且連續 ≥3 天；低＝大盤偏弱且剛轉買；其餘中；先不要買沒有把握程度", () => {
    expect(ratingConfidence(r("buy", 3))?.level).toBe("高");
    expect(ratingConfidence(r("buy", 2))?.level).toBe("中");
    expect(ratingConfidence(r("buy", 5, true))?.level).toBe("中");
    expect(ratingConfidence(r("buy", 1, true))?.level).toBe("低");
    expect(ratingConfidence(r("avoid", 9))).toBeNull();
    expect(ratingConfidence(r("buy", 9, false, { confirmState: null }))?.level).toBe("中"); // 沒有狀態當剛轉買
  });
  it("排序：高→中→低→先不要買", () => {
    const list = [r("avoid", 1), r("buy", 1, true), r("buy", 2), r("buy", 4)];
    expect(list.map(confidenceRank)).toEqual([3, 2, 1, 0]);
  });
  it("今日建議名單依把握程度排在前（支持數相同時）", () => {
    const picks = [
      { symbol: "A", name: "A", rating: r("buy", 1) },
      { symbol: "B", name: "B", rating: r("buy", 5) },
    ];
    expect(selectPickGroups(picks).buy.map((p) => p.symbol)).toEqual(["B", "A"]);
  });
  it("分級區塊：沒有高就寫（無）", () => {
    const t = describeConfidenceGrades([{ name: "鼎元", symbol: "2426", rating: r("buy", 1) }]);
    expect(t).toContain("高：（無）；中：鼎元(2426)");
  });
});

describe("stateFromRatingLog（剛上線／久沒評等時用評等紀錄回推前一交易日狀態與連續天數）", () => {
  const e = (day: string, code: RatingLogEntry["code"], at = `${day}T02:00:00Z`) =>
    ({ day, at, code, holdingLabel: code === "buy" ? "可分批加碼" : "建議減碼", symbol: "2330" }) as RatingLogEntry;
  it("取最近一天最後一筆，往前數連續相同大類", () => {
    const st = stateFromRatingLog([e("2026-10-01", "avoid"), e("2026-10-02", "buy"), e("2026-10-05", "buy"), e("2026-10-05", "avoid", "2026-10-05T01:00:00Z")], "2026-10-06")!;
    expect([st.code, st.day, st.streak]).toEqual(["buy", "2026-10-05", 2]);
    const s2 = stateFromRatingLog([e("2026-10-05", "avoid")], "2026-10-06")!;
    expect([s2.code, s2.holdingCode]).toEqual(["avoid", "reduce"]);
  });
  it("太久以前或沒有紀錄 → null；今天的紀錄不算", () => {
    expect(stateFromRatingLog([e("2026-09-20", "buy")], "2026-10-06")).toBeNull();
    expect(stateFromRatingLog([e("2026-10-06", "buy")], "2026-10-06")).toBeNull();
  });
});

describe("關注清單分析：僅關注彙整與漏掉補上（2026-10-06 漏掉旺矽）", () => {
  const entry = (name: string, symbol: string, rating: SiteRating, held = false): HoldingRatingEntry => ({ name, symbol, text: "", rating, held });
  const watch = formatWatchRatingSummary([entry("旺矽", "6223", r("buy", 1)), entry("昇達科", "3491", r("buy", 4)), entry("陽明", "2609", r("avoid", 1), true)]);
  it("只列僅關注、把握程度高的在前", () => {
    expect(watch.indexOf("昇達科")).toBeLessThan(watch.indexOf("旺矽"));
    expect(watch).not.toContain("陽明");
    expect(watch).toContain("（本站把握程度：高）");
  });
  it("回答漏掉的股票補一行；都有寫到就不動", () => {
    const g = `${HOLDING_SUMMARY_TITLE}持有中評等為減碼／出場（該賣）的：陽明(2609)「建議減碼」；其餘持有中（不用賣）：（無）。\n${watch}\n`;
    const a = guardHoldingsCoverage("陽明：建議減碼。\n昇達科：建議買進。", g);
    expect(a.appended).toEqual(["6223"]);
    expect(a.text).toMatch(/旺矽\(6223\)「建議買進」$/);
    expect(guardHoldingsCoverage("陽明、昇達科、旺矽都寫了", g).appended).toEqual([]);
  });
});

describe("清單指代認數字（2026-10-06 13:13「這3檔分別建議買還是不買」被當成全市場推薦）", () => {
  it("這3檔／這三檔／那 2 支 → 指代上一則清單", () => {
    for (const q of ["這3檔分別建議買還是不買?原因?", "這三檔哪個好", "那 2 支呢"]) expect(isListReferenceQuestion(q)).toBe(true);
    expect(isListReferenceQuestion("推薦3檔股票")).toBe(false);
  });
});
