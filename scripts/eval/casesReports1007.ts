// 2026-10-07 使用者 4 則回報題組（純資料；跑法：npx tsx scripts/eval/run.ts --tag 回報1007 …）。
// ①RSI 前後不一＋「RSI70以下建議買進」組合篩選 ②MACD 與 KD 兩種線都快交叉 ③宏璟死亡交叉仍建議買 ④達新法人當天資料。
import type { EvalCase } from "./types";

const TABIAO_HISTORY = [
  { role: "user" as const, content: "台表科(6278) 現在 RSI 是多少？" },
  { role: "assistant" as const, content: "台表科(6278)現在 RSI 是 83。\n\n融資融券組合判讀（本站程式說明）：\n- 台表科(6278)：【追高風險】股價上漲、融資同步大增。" },
];
const CROSS_HISTORY = [
  { role: "user" as const, content: "有沒有MACD與KD線都黃金交叉的股票？" },
  { role: "assistant" as const, content: "台股最新交易日在掃描範圍內，MACD 與 KD 同時黃金交叉的有 2 檔，其餘沒有同時符合。" },
];
const HONGJING_ANSWER =
  "宏璟(2527)建議買進（現價 50.2 可分批買；若拉回到 50 附近可加碼）。\n技術面偏多但短線有過熱跡象：均線多頭排列且站上 20 日均線；RSI 71 處於超買區，且 KD 出現死亡交叉，追價風險仍在。";

export const REPORT_1007_CASES: EvalCase[] = [
  {
    id: "r1007-rsi-buy-after-6278",
    title: "上文答台表科 RSI 83，接著問「RSI70以下建議買進的股票」：要由程式名單回答，RSI 不可編、不可沿用台表科",
    question: "那有rsi70以下建議買進的股票嗎",
    history: TABIAO_HISTORY,
    checks: [
      { kind: "conditionListOnly" },
      { kind: "rsiConsistent" },
      { kind: "forbid", name: "不把 RSI 83 的台表科當成 RSI70 以下", any: ["台表科[^。\n]{0,40}(目前符合|RSI\s*(為|約|是)?\s*6\d)"] },
      { kind: "noUngroundedPrice" },
    ],
    source: "使用者📝 2026-10-07 11:30「你上一則說83，這則說65，到底哪個是對的？而且我現在不是只有問台表科」",
    tags: ["report-1007", "回報1007", "使用者原題", "技術篩選"],
  },
  {
    id: "r1007-rsi-buy-plain",
    title: "沒有上文：「RSI 低於 40 而且建議買進的股票」→ 程式名單（可能是空的，要照實說沒有）",
    question: "有沒有RSI低於40而且建議買進的股票？",
    checks: [{ kind: "conditionListOnly" }, { kind: "rsiConsistent" }, { kind: "noUngroundedPrice" }],
    source: "使用者📝 2026-10-07 11:30 的變體（低 RSI）",
    tags: ["report-1007", "回報1007", "技術篩選"],
  },
  {
    id: "r1007-dual-near-cross",
    title: "上文談 MACD＋KD 黃金交叉，問「兩種線快線都快超過慢線的嗎」：要答 MACD＋KD 同時即將交叉（有就列、沒有照實說並列最接近），不可說沒有這個功能",
    question: "那有兩種線快線都快超過慢線的嗎？",
    history: CROSS_HISTORY,
    checks: [
      { kind: "forbid", name: "不說沒有這個功能", any: ["沒有這個功能", "無法篩選", "沒有提供", "查不到", "沒有資料"] },
      { kind: "require", name: "同時談 MACD 與 KD", any: ["MACD[^。]{0,120}KD", "KD[^。]{0,120}MACD"] },
      { kind: "require", name: "給出結果（有名單或目前沒有＋最接近）", any: ["沒有", "最接近", "共\s*\d+\s*檔", "符合"] },
      { kind: "noUngroundedPrice" },
    ],
    source: "使用者📝 2026-10-07 11:27「是真的沒有還是沒有這個功能？如果沒有的話要不要加上？」",
    tags: ["report-1007", "回報1007", "使用者原題", "技術篩選"],
  },
  {
    id: "r1007-dual-near-plain",
    title: "沒有上文：「MACD 跟 KD 都快黃金交叉的股票」",
    question: "有沒有MACD跟KD兩種指標都快要黃金交叉的股票？",
    checks: [
      { kind: "forbid", name: "不說沒有這個功能", any: ["沒有這個功能", "無法篩選", "沒有提供", "查不到"] },
      { kind: "require", name: "給出結果（有名單或目前沒有＋最接近）", any: ["沒有", "最接近", "共\s*\d+\s*檔", "符合"] },
      { kind: "noUngroundedPrice" },
    ],
    source: "使用者📝 2026-10-07 11:27 的變體",
    tags: ["report-1007", "回報1007", "技術篩選"],
  },
  {
    id: "r1007-hongjing-deathcross",
    title: "宏璟：上一則建議買進並提到 KD 死叉，使用者問「出現死亡交叉真的還可以買嗎」→ 要交代哪個死叉、哪一天、為何結論沒變",
    question: "出現死亡交叉真的還可以買嗎",
    contextSymbol: "2527",
    history: [
      { role: "user", content: "關於 宏璟（2527），最近走勢如何？現在建議買還是不買？" },
      { role: "assistant", content: HONGJING_ANSWER },
    ],
    checks: [
      { kind: "ratingFirst", symbol: "2527" },
      { kind: "deathCrossExplained" },
      { kind: "require", name: "回答死叉問題", any: ["死亡交叉", "死叉"] },
      { kind: "noUngroundedPrice" },
    ],
    source: "使用者📝 2026-10-07 11:40 宏璟「出現死亡交叉真的還可以買嗎」",
    tags: ["report-1007", "回報1007", "使用者原題", "個股"],
  },
  {
    id: "r1007-hongjing-first",
    title: "宏璟個股頁按鈕：建議買進時，技術面有死叉要在回答裡交代（程式死叉說明）",
    question: "關於 宏璟（2527），最近走勢如何？現在建議買還是不買？",
    contextSymbol: "2527",
    checks: [{ kind: "ratingFirst", symbol: "2527" }, { kind: "deathCrossExplained" }, { kind: "chipsDateMentioned" }, { kind: "noUngroundedPrice" }],
    source: "使用者📝 2026-10-07 11:40 宏璟原題",
    tags: ["report-1007", "回報1007", "使用者原題", "個股"],
  },
  {
    id: "r1007-dasin-chips-date",
    title: "達新：盤中問走勢買不買，提到三大法人買賣超要講是哪一天的資料（盤中沒有當天官方資料）",
    question: "關於 達新（1315），最近走勢如何？現在建議買還是不買？",
    contextSymbol: "1315",
    checks: [{ kind: "ratingFirst", symbol: "1315" }, { kind: "chipsDateMentioned" }, { kind: "noUngroundedPrice" }],
    source: "使用者📝 2026-10-07 10:38 達新「三大法人當天的買賣超也要参考」",
    tags: ["report-1007", "回報1007", "使用者原題", "個股"],
  },
];
