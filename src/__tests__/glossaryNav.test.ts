import { describe, expect, it } from "vitest";
import { findTerms, GLOSSARY, hasTerm } from "@/lib/glossary";
import { activeNavHref, NAV_ITEMS } from "@/lib/navItems";

describe("名詞說明比對", () => {
  it("找出名詞、同位置取最長寫法、ASCII 名詞不比到更長的英數字", () => {
    expect(findTerms("RSI(14) 低於 30").map((h) => h.entry.term)).toEqual(["RSI"]);
    expect(findTerms("KDJ 與 EPSX").length).toBe(0);
    expect(findTerms("營收年增率與月增率").map((h) => h.entry.term)).toEqual(["營收年增率", "營收月增率"]);
    // 「外資買超」拆成兩個名詞，各自有說明
    expect(findTerms("外資買超").map((h) => h.entry.term)).toEqual(["外資", "買超"]);
    expect(findTerms("同時符合全部")[0].entry.term).toBe("同時符合全部");
    expect(hasTerm("沒有專有名詞的句子")).toBe(false);
    expect(hasTerm("本益比偏高")).toBe(true);
  });

  it("每個名詞都有說明、沒有重複的寫法", () => {
    const seen = new Set<string>();
    for (const e of GLOSSARY) {
      expect(e.text.length).toBeGreaterThan(10);
      for (const s of [e.term, ...(e.aliases ?? [])]) {
        expect(seen.has(s), `重複寫法：${s}`).toBe(false);
        seen.add(s);
      }
    }
  });
});

describe("導覽列", () => {
  it("目前頁面對應到哪個項目", () => {
    expect(activeNavHref("/", NAV_ITEMS)).toBe("/");
    expect(activeNavHref("/stock/2330", NAV_ITEMS)).toBeNull();
    expect(activeNavHref("/sim/SM123", NAV_ITEMS)).toBe("/sim");
    expect(activeNavHref("/strategies/alerts", NAV_ITEMS)).toBe("/sim");
    expect(activeNavHref("/indicators", NAV_ITEMS)).toBe("/sim");
    expect(activeNavHref("/scoreboard", NAV_ITEMS)).toBe("/action");
    expect(activeNavHref("/action", NAV_ITEMS)).toBe("/action");
  });
});
