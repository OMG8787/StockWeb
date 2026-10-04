// AI 問答系統提示詞的「組裝邏輯」：依這一題實際附上了哪些參考資料區塊，決定要帶哪些規則。
// 規則文字本身（純資料）在 askSystemPrompt.ts（規則九：資料與邏輯分離）。
//
// 2026-10-04（F1）以前每題都把 40 多條規則全部送出（約 12,000 字），其中大半跟這一題無關
// （問名詞解釋也帶著技術篩選、持股深度分析、連漲天數的規則）。改成條件式後，偵測方式一律
// 是「看實際組進 userContent 的資料文字裡有沒有那個區塊」，而不是猜使用者意圖——
// 資料有附才帶規則，資料沒附時規則本來就用不到。
import { HISTORY_SECTION_TITLE } from "./grounding/history";
import { RECENT_CROSSES_TITLE } from "./grounding/indicators";
import { MARKET_HISTORY_TITLE } from "./marketHistoryText";
import {
  SYSTEM_ROLE,
  RULE_HONESTY,
  RULE_NOT_FOUND_MARKER,
  RULE_FULL_NAME_WITH_TICKER,
  RULE_JARGON,
  RULE_OPINION,
  RULE_SECOND_OPINION,
  RULE_STAY_ON_TOPIC,
  RULE_NO_UNVERIFIABLE_CONFESSION,
  RULE_NO_CANT_BACKTRACK_WHEN_DATA,
  RULE_USE_HISTORICAL_CONTEXT,
  RULE_INDICATORS,
  RULE_TW_CHIPS,
  RULE_CHIPS_RATIOS,
  RULE_SOCIAL_SENTIMENT,
  RULE_MULTI_STOCK_COMPARISON,
  RULE_INTRADAY_TW,
  RULE_INTRADAY_US,
  RULE_MACRO,
  RULE_RATE_HIKE_NUANCE,
  RULE_NIGHT_FUTURES,
  RULE_MOVERS,
  RULE_TECH_SCREEN_USAGE,
  RULE_THEME_STOCKS_USAGE,
  RULE_MARKET_WIDE_RECOMMENDATION,
  RULE_HOLDINGS_EMPTY_NOT_NO_PERMISSION,
  RULE_HOLDINGS_LIGHT,
  RULE_HOLDING_OF_TARGET,
  RULE_HOLDINGS_DEEP_ANALYSIS,
  RULE_SINGLE_STOCK_DEEP_ANALYSIS,
  RULE_YES_NO_DIRECT,
  RULE_CONCISE_ANSWER,
} from "./askSystemPrompt";

/** 這些字串必須跟各 grounding 產生的區塊文字一致；改那邊的標題要一起改這裡。 */
export const BLOCK_MARKERS = {
  recentCrosses: RECENT_CROSSES_TITLE, // grounding/indicators.ts（共用常數）
  chipsRatios: "籌碼比例（", // grounding/chipsRatios.ts
  socialSentiment: "社群情緒（", // grounding/sentiment.ts
  institutional: "三大法人", // grounding/stock.ts、movers.ts、techScreen.ts
  macro: "美國總體經濟", // macroText.ts
  nightFutures: "夜盤", // marketIndices / marketOverview.ts
  indicators: /RSI|KD|MACD|黃金交叉|死亡交叉/,
} as const;

/** 使用者引用「你更早說過」的話（看不到的對話）。 */
const EARLIER_CLAIM_PATTERN = /你(早上|昨天|剛剛|剛才|之前|先前|上次|稍早|前面)|說過|不是說/;
/** 問社群／網路討論氣氛：就算沒附社群情緒區塊也要帶規則（要直說查不到，不可拿新聞充當）。 */
const SOCIAL_TOPIC_PATTERN = /社群|情緒|Reddit|網友|散戶討論|PTT|推特|討論度/i;
/** 問到利率／升降息才帶升降息細部框架。 */
const RATE_TOPIC_PATTERN = /升息|降息|利率|聯準會|Fed|FOMC|央行|通膨|殖利率/i;
/** 問大盤／市場氣氛時，大盤層級的【市場歷史與情緒走勢】才派得上用場。 */
const MARKET_JUDGMENT_PATTERN = /大盤|加權|指數|市場|台股|美股|情緒|恐慌|VIX|大環境|總經|景氣/i;

export interface AskPromptContext {
  question: string;
  /** 對話紀錄裡上一句使用者的話（追問時主題常在上一句） */
  lastUserTurn: string;
  hasHistory: boolean;
  /** 個股資料區塊合併文字（含多檔） */
  stockText: string;
  stockCount: number;
  /** 關注清單／持股區塊文字 */
  holdingsText: string;
  holdingsMode: "deep" | "light" | "target" | "none";
  /** 有關注清單但這題不相關，只附了背景名單 */
  holdingsBackground: boolean;
  /** 問到自己的持股，但關注清單是空的 */
  holdingsEmptyAsked: boolean;
  indexText: string;
  moversText: string;
  techScreenText: string;
  hasTheme: boolean;
  hasNotFoundMarker: boolean;
  singleStockDeep: boolean;
  marketWide: boolean;
  twMarketOpen: boolean;
  usMarketOpen: boolean;
}

export function composeAskSystemPrompt(c: AskPromptContext): string {
  const dataText = [c.stockText, c.holdingsText, c.moversText, c.techScreenText].join("\n");
  const asked = `${c.question}\n${c.lastUserTurn}`;
  const hasStockLike = c.stockCount > 0 || c.holdingsMode !== "none";
  const hasStockHistory = dataText.includes(HISTORY_SECTION_TITLE);
  const marketHistoryRelevant =
    c.indexText.includes(MARKET_HISTORY_TITLE) && (hasStockLike || c.marketWide || MARKET_JUDGMENT_PATTERN.test(asked));

  const holdingsRule =
    c.holdingsMode === "deep"
      ? RULE_HOLDINGS_DEEP_ANALYSIS
      : c.holdingsMode === "light"
        ? RULE_HOLDINGS_LIGHT
        : c.holdingsMode === "target"
          ? RULE_HOLDING_OF_TARGET
          : "";

  return [
    SYSTEM_ROLE,
    RULE_HONESTY,
    c.hasNotFoundMarker ? RULE_NOT_FOUND_MARKER : "",
    RULE_FULL_NAME_WITH_TICKER,
    RULE_JARGON,
    RULE_OPINION,
    RULE_SECOND_OPINION,
    // 對話情境
    c.hasHistory || c.holdingsBackground ? RULE_STAY_ON_TOPIC : "",
    c.hasHistory || EARLIER_CLAIM_PATTERN.test(c.question) ? RULE_NO_UNVERIFIABLE_CONFESSION : "",
    // 個股／指標／籌碼（依資料文字偵測）
    dataText.includes(BLOCK_MARKERS.recentCrosses) ? RULE_NO_CANT_BACKTRACK_WHEN_DATA : "",
    hasStockHistory || marketHistoryRelevant ? RULE_USE_HISTORICAL_CONTEXT : "",
    BLOCK_MARKERS.indicators.test(dataText) ? RULE_INDICATORS : "",
    dataText.includes(BLOCK_MARKERS.institutional) ? RULE_TW_CHIPS : "",
    dataText.includes(BLOCK_MARKERS.chipsRatios) ? RULE_CHIPS_RATIOS : "",
    dataText.includes(BLOCK_MARKERS.socialSentiment) || SOCIAL_TOPIC_PATTERN.test(c.question) ? RULE_SOCIAL_SENTIMENT : "",
    c.stockCount > 1 ? RULE_MULTI_STOCK_COMPARISON : "",
    c.twMarketOpen && (hasStockLike || c.moversText || c.techScreenText) ? RULE_INTRADAY_TW : "",
    c.usMarketOpen && (hasStockLike || c.moversText || c.techScreenText) ? RULE_INTRADAY_US : "",
    // 大盤／總經
    c.indexText.includes(BLOCK_MARKERS.macro) ? RULE_MACRO : "",
    RATE_TOPIC_PATTERN.test(asked) ? RULE_RATE_HIKE_NUANCE : "",
    c.indexText.includes(BLOCK_MARKERS.nightFutures) && MARKET_JUDGMENT_PATTERN.test(asked) ? RULE_NIGHT_FUTURES : "",
    // 全市場篩選
    c.moversText ? RULE_MOVERS : "",
    c.techScreenText ? RULE_TECH_SCREEN_USAGE : "",
    c.hasTheme ? RULE_THEME_STOCKS_USAGE : "",
    c.marketWide ? RULE_MARKET_WIDE_RECOMMENDATION : "",
    // 關注清單／持股
    holdingsRule,
    c.holdingsEmptyAsked ? RULE_HOLDINGS_EMPTY_NOT_NO_PERMISSION : "",
    c.singleStockDeep ? RULE_SINGLE_STOCK_DEEP_ANALYSIS : "",
    RULE_YES_NO_DIRECT,
    // 放最後：長度與格式規則聲明優先於前面要求多解釋的規則
    RULE_CONCISE_ANSWER,
  ]
    .filter(Boolean)
    .join("\n");
}
