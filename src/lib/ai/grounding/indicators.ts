import { getChart } from "@/lib/data";
import type { Market, TechScreenItem } from "@/lib/data";
import type { Candle } from "@/lib/data/types";
import { computeIndicatorState, computeSignals } from "@/lib/signals";

// 一檔股票在「技術指標明細表」裡的一行。刻意把每個指標的實際數值都寫出來
// （K/D 幾點、RSI 幾點、MACD 在 0 軸哪一側），而不是只寫有沒有訊號——這樣
// AI 才有辦法回答「KD 剛交叉但還在低檔」「RSI 還沒過熱」這種帶數值條件的
// 追問，也讓它引用的每個數字都有出處、不需要自己編。
// 2026-09-22 地毯式審計提醒：這個檔案裡 describeTechState()／describeIndicatorState()／
// describeHoldingTechnical() 三個函式各自重複組裝一次「MACD/KD 交叉狀態 → 中文描述」的
// if/else，沒有抽成共用函式——刻意保留分開，不是忘記合併：三處的輸出格式跟詳細程度
// 真的不一樣（describeTechState 帶KD區間位置、describeIndicatorState 不帶但列K/D精確值、
// describeHoldingTechnical 更精簡），硬合併成一個共用函式容易在參數化的過程中不小心
// 改動某一處原本的措辭，對AI回答品質的風險大於重複程式碼本身的維護成本。**新增交叉
// 狀態種類或調整任一處措辭時，記得檢查這三個函式是不是都需要同步更新**，避免同一檔
// 股票在不同區塊出現不一致的說法。
export function describeTechState(item: TechScreenItem): string {
  const s = item.state;
  const parts: string[] = [];
  const zoneText = { low: "低檔/超賣區", mid: "中間區間", high: "高檔/超買區" } as const;
  parts.push(
    s.macdCross === "golden"
      ? `MACD黃金交叉（${s.macdAboveZero ? "0軸上方，訊號較明確" : "0軸下方，屬低檔訊號，力道較弱"}）`
      : s.macdCross === "death"
        ? `MACD死亡交叉（${s.macdAboveZero ? "0軸上方" : "0軸下方，屬續跌訊號"}）`
        : s.macdAboveZero === null
          ? "MACD資料不足"
          : `MACD今日未交叉（MACD線在0軸${s.macdAboveZero ? "上方" : "下方"}）`
  );
  if (s.kd) {
    const crossText =
      s.kd.cross === "golden"
        ? `KD黃金交叉（K值${s.kd.prevK.toFixed(1)}→${s.kd.k.toFixed(1)}上穿D值${s.kd.prevD.toFixed(1)}→${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`
        : s.kd.cross === "death"
          ? `KD死亡交叉（K值${s.kd.k.toFixed(1)}下穿D值${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`
          : `KD今日未交叉（K值${s.kd.k.toFixed(1)}、D值${s.kd.d.toFixed(1)}，${zoneText[s.kd.zone]}）`;
    parts.push(crossText);
  } else {
    parts.push("KD資料不足");
  }
  parts.push(
    s.maAlignment === "bullish"
      ? "均線多頭排列（5日線>10日線>20日線）"
      : s.maAlignment === "bearish"
        ? "均線空頭排列（5日線<10日線<20日線）"
        : "均線未成明確排列"
  );
  if (s.aboveMa20 !== null) parts.push(s.aboveMa20 ? "站上20日均線" : "跌破20日均線");
  if (s.rsi != null) {
    const tag = s.rsi >= 70 ? "，超買區" : s.rsi <= 30 ? "，超賣區" : "，未過熱也未超賣";
    parts.push(`RSI ${s.rsi.toFixed(0)}${tag}`);
  }
  if (s.bollinger) parts.push(s.bollinger === "upper" ? "觸及布林通道上緣" : "觸及布林通道下緣");
  if (s.streakDirection && s.streakDays >= 1) {
    parts.push(`連${s.streakDirection === "up" ? "漲" : "跌"}${s.streakDays}天`);
  }
  if (s.volumeRatio != null) parts.push(`量能${s.volumeRatio.toFixed(1)}倍均量`);
  return `${item.name}(${item.symbol})，現價${item.price}(${item.changePercent >= 0 ? "+" : ""}${item.changePercent}%)：${parts.join("、")}`;
}

/** 回看最近幾個交易日的 MACD／KD 交叉紀錄用的天數。 */
const RECENT_CROSS_DAYS = 5;
/** 個股資料裡這一行的固定標題。askSystemCompose.ts 靠它判斷要不要帶「不可說無法回溯」規則，
 *  所以兩邊一律 import 這個常數，不可各自手寫字串（改字就會讓規則悄悄消失）。 */
export const RECENT_CROSSES_TITLE = `近${RECENT_CROSS_DAYS}個交易日逐日的MACD／KD交叉紀錄`;

/**
 * 近幾個交易日「每一天」的 MACD／KD 交叉紀錄（把K線截到那一天再算一次指標）。
 *
 * 2026-10-04 使用者實測：問「昨天1301有沒有兩個都黃金交叉」，AI 回「系統沒有保留
 * 昨天的歷史指標明細，無法回溯」——其實指標本來就是用日K現算的，昨天是什麼狀態
 * 一算就知道，只是之前資料裡只放「今天」那一行。這裡把近 N 天逐日算好附上，
 * 「昨天有沒有」「這幾天有沒有交叉過」都能直接用資料回答，不必猜、也不必說做不到。
 * 最後一根K線若是今天盤中尚未收盤的那根，它的指標會隨最新價跳動（盤中有交叉、收盤
 * 後消失是正常現象），所以最後一天另外標「今天（盤中仍會變動）」或「今天」。
 */
export function describeRecentCrosses(candles: Candle[], marketOpen: boolean): string {
  const lines: string[] = [];
  for (let back = RECENT_CROSS_DAYS - 1; back >= 0; back--) {
    const upTo = candles.slice(0, candles.length - back);
    const last = upTo[upTo.length - 1];
    if (!last) continue;
    const state = computeIndicatorState(upTo, last.close);
    if (!state) continue;
    const events: string[] = [];
    if (state.macdCross === "golden") events.push("MACD黃金交叉");
    if (state.macdCross === "death") events.push("MACD死亡交叉");
    if (state.kd?.cross === "golden") events.push("KD黃金交叉");
    if (state.kd?.cross === "death") events.push("KD死亡交叉");
    const label = back === 0 ? (marketOpen ? `${last.time}（今天，盤中仍會變動）` : `${last.time}（最新一個交易日；若今天是休市日，使用者說的「昨天」就是這一天）`) : last.time;
    lines.push(`${label}：${events.length > 0 ? events.join("＋") : "沒有交叉"}`);
  }
  return lines.join("；");
}

/**
 * 把一檔股票「每個技術指標當下的實際狀態」寫成一句話——**沒有觸發交叉的指標
 * 也一樣要出現**，這正是它跟 computeSignals()（只回傳已觸發的標籤）的分工。
 * 見呼叫端（個股資料組裝處）註解記錄的那個實測缺口。
 */
export function describeIndicatorState(state: ReturnType<typeof computeIndicatorState>): string {
  if (!state) return "";
  const parts: string[] = [];
  parts.push(
    state.macdCross === "golden"
      ? `MACD：今日黃金交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
      : state.macdCross === "death"
        ? `MACD：今日死亡交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
        : state.macdAboveZero == null
          ? "MACD：K線根數不足，算不出來"
          : `MACD：今日沒有發生交叉，MACD線（DIF）目前位於0軸${state.macdAboveZero ? "上方（多方力道相對占優）" : "下方（空方力道相對占優）"}`
  );
  parts.push(
    state.kd
      ? state.kd.cross === "golden"
        ? `KD：今日黃金交叉（K值${state.kd.k.toFixed(1)}上穿D值${state.kd.d.toFixed(1)}）`
        : state.kd.cross === "death"
          ? `KD：今日死亡交叉（K值${state.kd.k.toFixed(1)}下穿D值${state.kd.d.toFixed(1)}）`
          : `KD：今日沒有交叉（K值${state.kd.k.toFixed(1)}、D值${state.kd.d.toFixed(1)}）`
      : "KD：資料不足"
  );
  parts.push(state.rsi != null ? `RSI(14)：${state.rsi.toFixed(0)}` : "RSI：資料不足");
  if (state.maAlignment) parts.push(`均線：${state.maAlignment === "bullish" ? "多頭排列" : "空頭排列"}`);
  if (state.aboveMa20 != null) parts.push(`現價${state.aboveMa20 ? "站上" : "跌破"}20日均線`);
  if (state.streakDirection && state.streakDays >= 1) {
    parts.push(`連${state.streakDirection === "up" ? "漲" : "跌"}${state.streakDays}天`);
  }
  if (state.volumeRatio != null) parts.push(`今日量能約為近20日均量的${state.volumeRatio.toFixed(1)}倍`);
  return parts.join("；");
}

/** 單一持股的技術指標描述，格式跟【技術指標篩選】區塊一致，讓 AI 在兩邊看到
 *  同一檔股票時說法不會前後矛盾。 */
export async function describeHoldingTechnical(quote: { symbol: string; market: Market; price: number }): Promise<string> {
  try {
    const chart = await getChart(quote.symbol, "3m", quote.market);
    if (!chart) return "；技術面：目前抓不到K線資料，無法計算指標";
    const state = computeIndicatorState(chart.candles, quote.price);
    if (!state) return "；技術面：K線資料不足，無法計算指標";
    const crossText =
      state.macdCross === "golden"
        ? `有MACD黃金交叉（${state.macdAboveZero ? "0軸上方" : "0軸下方"}）`
        : state.macdCross === "death"
          ? "有MACD死亡交叉"
          : "今日沒有MACD交叉";
    const kdText = state.kd
      ? state.kd.cross === "golden"
        ? `有KD黃金交叉（K值${state.kd.k.toFixed(1)}上穿D值${state.kd.d.toFixed(1)}）`
        : state.kd.cross === "death"
          ? `有KD死亡交叉（K值${state.kd.k.toFixed(1)}下穿D值${state.kd.d.toFixed(1)}）`
          : `今日沒有KD交叉（K值${state.kd.k.toFixed(1)}、D值${state.kd.d.toFixed(1)}）`
      : "KD資料不足";
    const signals = computeSignals(chart.candles, quote.price, "3m");
    const signalText = signals.length > 0 ? signals.map((s) => s.label).join("、") : "今日沒有觸發任何技術訊號";
    return `；技術面：${crossText}、${kdText}；已觸發的技術訊號：${signalText}`;
  } catch {
    return "；技術面：指標計算失敗";
  }
}
