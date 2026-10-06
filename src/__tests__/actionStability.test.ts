import { describe, expect, it } from "vitest";
import { frozenListEpochKey, stabilizeBuyPicks } from "@/lib/ai/actionStability";

/** 台北時間字串 → Date（台北＝UTC+8） */
const tpe = (s: string) => new Date(`${s}+08:00`);

describe("frozenListEpochKey：只有資料已定的時段才有代號", () => {
  it("平日夜間 22:00 起到隔天 08:30 前同一個代號（週二 22:00 ~ 週三 08:29）", () => {
    expect(frozenListEpochKey(tpe("2026-10-06T22:00:00"))).toBe("2026-10-06");
    expect(frozenListEpochKey(tpe("2026-10-06T23:40:00"))).toBe("2026-10-06");
    expect(frozenListEpochKey(tpe("2026-10-07T00:30:00"))).toBe("2026-10-06");
    expect(frozenListEpochKey(tpe("2026-10-07T07:51:00"))).toBe("2026-10-06");
    expect(frozenListEpochKey(tpe("2026-10-07T08:29:59"))).toBe("2026-10-06");
  });
  it("08:30 試撮開始～22:00：報價與法人資料還在變，沒有代號", () => {
    for (const t of ["08:30:00", "09:00:00", "13:30:00", "14:35:00", "18:25:00", "21:59:00"]) {
      expect(frozenListEpochKey(tpe(`2026-10-07T${t}`))).toBeNull();
    }
  });
  it("週五夜間、週六、週日、週一 08:30 前＝同一個代號（上週五）", () => {
    const fri = "2026-10-09";
    expect(frozenListEpochKey(tpe("2026-10-09T22:30:00"))).toBe(fri);
    expect(frozenListEpochKey(tpe("2026-10-10T03:00:00"))).toBe(fri);
    expect(frozenListEpochKey(tpe("2026-10-10T15:00:00"))).toBe(fri);
    expect(frozenListEpochKey(tpe("2026-10-11T23:59:00"))).toBe(fri);
    expect(frozenListEpochKey(tpe("2026-10-12T08:00:00"))).toBe(fri);
    expect(frozenListEpochKey(tpe("2026-10-12T08:30:00"))).toBeNull();
  });
  it("跨月也正確（週一凌晨的代號是上週五）", () => {
    expect(frozenListEpochKey(tpe("2026-10-05T07:00:00"))).toBe("2026-10-02");
    expect(frozenListEpochKey(tpe("2026-11-02T07:00:00"))).toBe("2026-10-30");
  });
});

const p = (symbol: string, tag = "") => ({ symbol, tag });

describe("stabilizeBuyPicks：上游失敗不換掉整份名單", () => {
  const previous = [p("A"), p("B"), p("C"), p("D"), p("E")];

  it("相同輸入兩次結果相同；這次候選排序不同也不影響已在名單裡的股票", () => {
    const ranked = [p("X"), p("Y"), p("A"), p("B"), p("C"), p("D"), p("E")];
    const args = { previous, ranked, rejected: new Set<string>(), limit: 5 };
    const r1 = stabilizeBuyPicks(args);
    expect(r1.map((x) => x.symbol)).toEqual(["A", "B", "C", "D", "E"]);
    expect(stabilizeBuyPicks(args)).toEqual(r1);
  });

  it("某檔這次沒有評等（上游失敗，不在 ranked 也不在 rejected）→ 保留上一份的那檔", () => {
    const ranked = [p("X"), p("A"), p("B"), p("D"), p("E")]; // C 不見（抓不到）
    const out = stabilizeBuyPicks({ previous, ranked, rejected: new Set(), limit: 5 });
    expect(out.map((x) => x.symbol)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("整批候選抓不到（ranked 空）→ 整份沿用上一份", () => {
    const out = stabilizeBuyPicks({ previous, ranked: [], rejected: new Set(), limit: 5 });
    expect(out).toEqual(previous);
  });

  it("只有明確被重新評等為不建議買進的才換掉，空出的名額依這次排序補上", () => {
    const ranked = [p("X"), p("Y"), p("A"), p("D"), p("E")];
    const out = stabilizeBuyPicks({ previous, ranked, rejected: new Set(["B", "C"]), limit: 5 });
    expect(out.map((x) => x.symbol)).toEqual(["A", "D", "E", "X", "Y"]);
  });

  it("保留的股票用這次的新評等（價位更新），沒有新評等才用舊的", () => {
    const fresh = new Map([["A", p("A", "new")]]);
    const out = stabilizeBuyPicks({ previous: [p("A", "old"), p("B", "old")], ranked: [], fresh, rejected: new Set(), limit: 5 });
    expect(out).toEqual([p("A", "new"), p("B", "old")]);
  });

  it("不超過上限、同代號只出現一次、代號大小寫視為相同", () => {
    const out = stabilizeBuyPicks({
      previous: [p("a"), p("A"), p("B")],
      ranked: [p("A"), p("C"), p("D")],
      rejected: new Set(),
      limit: 3,
    });
    expect(out.map((x) => x.symbol.toUpperCase())).toEqual(["A", "B", "C"]);
  });
});
