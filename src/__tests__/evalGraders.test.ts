import { describe, expect, it } from "vitest";
import { coreLabel, firstSentences, gradeAnswer, gradeCheck, mentionedSymbols, parseProgramRatings, verdictCategory, type GradeInput } from "../../scripts/eval/graders";
import type { EvalCase } from "../../scripts/eval/types";

const GROUNDING =
  "【個股資料】\n股票：台積電（2330，台股）\n【本站綜合評等】台積電(2330)：未持有：「建議等回檔再買（現價不買，等回到 2,490～2,505）」／已持有：「續抱」。理由：…。價位：買進區間 2,490～2,505；高於 2,580 不追價；買進後跌破 2,455 出場。\n" +
  "【本站綜合評等】友達(2409)：未持有：「建議先不要買」／已持有：「建議出場」。理由：…。";

const baseCase: EvalCase = { id: "t", title: "t", question: "台積電可以買嗎？", checks: [], source: "test", tags: [] };
const input = (answer: string, extra: Partial<GradeInput> = {}): GradeInput => ({
  caseDef: baseCase,
  rawAnswer: answer,
  finalAnswer: answer,
  grounding: GROUNDING,
  zhFixedCount: 0,
  phase: "after-close",
  ...extra,
});

describe("eval graders", () => {
  it("解析程式評等與核心字樣", () => {
    const r = parseProgramRatings(GROUNDING);
    expect(r.get("2330")?.unheld).toContain("建議等回檔再買");
    expect(r.get("2409")?.held).toBe("建議出場");
    expect(coreLabel("建議等回檔再買（現價不買）")).toBe("建議等回檔再買");
  });

  it("第一句照抄評等", () => {
    const ok = gradeCheck({ kind: "ratingFirst", symbol: "2330" }, input("**建議等回檔再買**（現價不買，等回到 2,490～2,505）。理由如下。"));
    expect(ok.pass).toBe(true);
    const bad = gradeCheck({ kind: "ratingFirst", symbol: "2330" }, input("台積電今天上漲 3%。建議等回檔再買。"));
    expect(bad.pass).toBe(false);
  });

  it("只抓括號內代號，排除指標縮寫與價格", () => {
    expect(mentionedSymbols("台積電(2330)的 RSI（RSI）偏高，現價 2575，台灣精材(3467)")).toEqual(["2330", "3467"]);
  });

  it("關鍵價位抄錯會被抓到", () => {
    const res = gradeAnswer(input("建議等回檔再買。買進後跌破 245.5 出場。"));
    expect(res.find((c) => c.rule === "關鍵價位照抄程式值")?.pass).toBe(false);
  });

  it("持股賣留判斷分類", () => {
    expect(verdictCategory("建議出場，跌破 39 停損")).toBe("sell");
    expect(verdictCategory("續抱，若跌破再減碼")).toBe("keep");
    const sell = gradeCheck({ kind: "sellListMatches", symbols: ["2330", "2409"] }, input("友達(2409)：建議出場"));
    expect(sell.pass).toBe(true);
  });

  it("週末不可說今天行情、比較題要選一檔", () => {
    const wk = gradeAnswer(input("建議等回檔再買。今天上漲 3%。", { phase: "weekend" }));
    expect(wk.find((c) => c.rule === "週末不說今天行情")?.pass).toBe(false);
    expect(firstSentences("A。B！C", 2)).toBe("A。B！");
  });
});
