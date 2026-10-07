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

  it("marginSignalMention：有訊號要講出名稱；中性不適用", () => {
    const base = { caseDef: {} as EvalCase, zhFixedCount: 0, phase: "intraday" as const, rawAnswer: "" };
    const grounding = "籌碼 融資融券組合判讀（程式依單日數字算好，10/05單日數字，不是趨勢）：【追高風險】股價上漲…。依據：股價+2%";
    expect(gradeCheck({ kind: "marginSignalMention" }, { ...base, grounding, finalAnswer: "籌碼面有追高風險，融資增加。" }).pass).toBe(true);
    expect(gradeCheck({ kind: "marginSignalMention" }, { ...base, grounding, finalAnswer: "籌碼面偏多。" }).pass).toBe(false);
    expect(gradeCheck({ kind: "marginSignalMention" }, { ...base, grounding: "沒有該區塊", finalAnswer: "籌碼面偏多。" }).pass).toBe(true);
  });
});

describe("2026-10-07 回報題組的檢查", () => {
  const listGrounding =
    "【依使用者問的條件「RSI ≤ 70 且 本站評等為建議買進」由程式逐檔比對的名單】\n台股符合共 2 檔\n\n【符合「RSI ≤ 70」且本站綜合評等為「建議買進」的股票（程式逐檔算好）】\n" +
    "【本站綜合評等】寶成(9904)：未持有：「建議買進」／已持有：「續抱」。理由：x。\n\n【別的區塊】\n- 寶成(9904)，現價 24.85(+1%)：RSI 55";
  it("conditionListOnly：只列名單裡的股票", () => {
    expect(gradeCheck({ kind: "conditionListOnly" }, input("寶成(9904)建議買進。", { grounding: listGrounding })).pass).toBe(true);
    const bad = gradeCheck({ kind: "conditionListOnly" }, input("台表科(6278)目前符合。", { grounding: listGrounding }));
    expect(bad.pass).toBe(false);
    expect(bad.detail).toContain("6278");
  });
  it("conditionListOnly：名單為空要說沒有，不可湊數", () => {
    const g = "【符合「RSI < 30」且本站綜合評等為「建議買進」的股票（程式逐檔算好）】\n（目前一檔都沒有：…）\n";
    expect(gradeCheck({ kind: "conditionListOnly" }, input("目前沒有符合的股票。", { grounding: g })).pass).toBe(true);
    expect(gradeCheck({ kind: "conditionListOnly" }, input("台表科(6278)目前符合。", { grounding: g })).pass).toBe(false);
  });
  it("rsiConsistent：RSI 與資料不一致或資料沒有就判失敗", () => {
    expect(gradeCheck({ kind: "rsiConsistent" }, input("寶成(9904)的 RSI 為 55。", { grounding: listGrounding })).pass).toBe(true);
    expect(gradeCheck({ kind: "rsiConsistent" }, input("寶成(9904)的 RSI 為 65。", { grounding: listGrounding })).pass).toBe(false);
    expect(gradeCheck({ kind: "rsiConsistent" }, input("台表科(6278)目前 RSI 為 65。", { grounding: listGrounding })).pass).toBe(false);
  });
  it("deathCrossExplained：已收盤確認的死叉不可說成今天盤中", () => {
    const g = "- 死亡交叉說明（程式）：KD死亡交叉出現在 10/06（已收盤確認）；…";
    expect(gradeCheck({ kind: "deathCrossExplained" }, input("10/06 收盤出現 KD 死亡交叉，本站技術面中性。", { grounding: g })).pass).toBe(true);
    expect(gradeCheck({ kind: "deathCrossExplained" }, input("今天盤中出現 KD 死亡交叉。", { grounding: g })).pass).toBe(false);
    expect(gradeCheck({ kind: "deathCrossExplained" }, input("建議買進。", { grounding: g })).pass).toBe(false);
    expect(gradeCheck({ kind: "deathCrossExplained" }, input("建議買進。", { grounding: "x" })).pass).toBe(true);
  });
  it("chipsDateMentioned", () => {
    const g = "籌碼面（10/06的資料；今天10/07的…）：三大法人合計賣超22張";
    expect(gradeCheck({ kind: "chipsDateMentioned" }, input("三大法人合計賣超22張。", { grounding: g })).pass).toBe(false);
    expect(gradeCheck({ kind: "chipsDateMentioned" }, input("10/06 三大法人合計賣超22張。", { grounding: g })).pass).toBe(true);
    expect(gradeCheck({ kind: "chipsDateMentioned" }, input("技術面偏多。", { grounding: g })).pass).toBe(true);
  });
});
