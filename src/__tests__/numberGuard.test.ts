import { describe, expect, it } from "vitest";
import { extractKeyLevels, guardAnswerNumbers } from "@/lib/ai/numberGuard";

const UMC =
  "股票：聯電（2303，台股）\n目前價格：45.2 TWD\n" +
  "【本站綜合評等】聯電(2303)：未持有：「建議等回檔再買（現價不買，等回到 42.5～43.8）」／已持有：「續抱」。理由：x。價位：買進區間 42.5～43.8；高於 47.3 不追價；買進後跌破 41.85 出場。\n" +
  "近 10 個交易日收盤價：2026-10-01=44.1, 2026-10-02=45.0\n" +
  "【本站綜合評等】台積電(2330)：未持有：「建議買進」／已持有：「續抱」。理由：y。價位：買進區間 1,420～1,450；高於 1,520 不追價；買進後跌破 1,390 出場。\n" +
  "【持有中出場參考】目前虧損約 3.1%（成本 1,500），停損價 1,405（MA20，現價 1,460 下方 3.8%）：收盤跌破就停損出場";

describe("extractKeyLevels", () => {
  it("依評等行分檔取出區間、出場、不追價", () => {
    const { levels, names } = extractKeyLevels(UMC);
    expect(names.get("聯電")).toBe("2303");
    expect(levels.filter((l) => l.symbol === "2303").map((l) => `${l.kind}:${l.value}`).sort()).toEqual(
      ["exit:41.85", "noChase:47.3", "zone:42.5", "zone:43.8"].sort()
    );
    expect(levels.some((l) => l.symbol === "2330" && l.kind === "exit" && l.value === 1405)).toBe(true);
    expect(levels.some((l) => l.symbol === "2330" && l.kind === "zone" && l.value === 1420)).toBe(true);
  });
});

describe("guardAnswerNumbers", () => {
  it("明顯不符（14.85 vs 41.85）改成同類程式價位", () => {
    const r = guardAnswerNumbers("聯電：等回到 42.5～43.8 再分批，跌破 14.85 停損。", UMC);
    expect(r.text).toBe("聯電：等回到 42.5～43.8 再分批，跌破 41.85 停損。");
    expect(r.fixes[0]).toMatchObject({ from: "14.85", to: "41.85", symbol: "2303", reason: "mismatch" });
  });
  it("小數點位移（4.185）改回程式價位", () => {
    const r = guardAnswerNumbers("聯電跌破 4.185 出場", UMC);
    expect(r.text).toBe("聯電跌破 41.85 出場");
    expect(r.fixes[0].reason).toBe("decimal-shift");
  });
  it("依前面提到的股票選價位（台積電的停損）", () => {
    const r = guardAnswerNumbers("聯電照區間買。台積電持有者停損價 2,405。", UMC);
    expect(r.text).toBe("聯電照區間買。台積電持有者停損價 1,405。");
  });
  it("正確數字、參考資料裡的數字、區間中間價、百分比都不動", () => {
    const ok = [
      "聯電跌破 41.85 出場，高於 47.3 不追。",
      "聯電掛單可參考 43.1 附近（區間中間）。",
      "聯電跌破 44.1 先減碼。",
      "聯電停損約 8% 以內。",
      "台積電跌破 1,390 出場，回到 1,420～1,450 分批。",
      "聯電(2303) 區間不變。",
    ];
    for (const s of ok) expect(guardAnswerNumbers(s, UMC)).toEqual({ text: s, fixes: [] });
  });
  it("參考資料沒有程式價位時原樣回傳", () => {
    expect(guardAnswerNumbers("跌破 14.85 停損", "沒有評等").fixes).toEqual([]);
  });
});
