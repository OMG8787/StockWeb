// AI 問答系統提示詞的「組裝邏輯」：依這一題實際附上了哪些參考資料區塊，決定要帶哪些規則。
// 規則文字本身（純資料）在 askSystemPrompt.ts（規則九：資料與邏輯分離）。
//
// 2026-10-04（F1）以前每題都把 40 多條規則全部送出（約 12,000 字），其中大半跟這一題無關
// （問名詞解釋也帶著技術篩選、持股深度分析、連漲天數的規則）。改成條件式後，偵測方式一律
// 是「看實際組進 userContent 的資料文字裡有沒有那個區塊」，而不是猜使用者意圖——
// 資料有附才帶規則，資料沒附時規則本來就用不到。
import { weekendNoteForAi } from "@/lib/marketStatus";
import { HISTORY_SECTION_TITLE } from "./grounding/history";
import { RECENT_CROSSES_TITLE } from "./grounding/indicators";
import { SECTOR_FACTORS_TITLE } from "./grounding/sectorFactors";
import { PRICE_LEVELS_TITLE } from "./grounding/priceLevels";
import { MARKET_HISTORY_TITLE } from "./marketHistoryText";
import { TOPIC_NEWS_TITLE } from "@/lib/data/topicNews";
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
  RULE_SECTOR_FACTORS,
  RULE_MULTI_STOCK_COMPARISON,
  RULE_INTRADAY_TW,
  RULE_INTRADAY_US,
  RULE_MACRO,
  RULE_TOPIC_NEWS,
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
  RULE_PRICE_LEVEL_CONSISTENCY,
  RULE_USE_PRICE_FRAMEWORK,
  RULE_ONLY_ASKED_STOCKS,
  RULE_YES_NO_DIRECT,
  RULE_CONCISE_ANSWER,
  RULE_FOLLOW_SITE_RATING,
  RULE_TRADING_STANCE,
  RULE_RATING_CHANGE,
  RULE_LIST_REFERENCE,
  RULE_DECISION_CARD,
  RULE_MARKET_PULSE,
} from "./askSystemPrompt";
import { DECISION_CARD_TITLE } from "./decisionCard";
import { MARKET_PULSE_TITLE } from "./grounding/movers";
import { SITE_RATING_TITLE } from "./siteRating";
import { SIMILAR_CASES_TITLE } from "./learning/similar";
import { LESSONS_TITLE } from "./learning/lessonMatch";
import { RULE_AI_VIEW, RULE_EXPERIENCE } from "./learning/experienceRule";
import { AI_VIEW_TITLE } from "./learning/aiAdjust";
import { RATING_CHANGE_TITLE } from "./ratingChange";

/** 這些字串必須跟各 grounding 產生的區塊文字一致；改那邊的標題要一起改這裡。 */
export const BLOCK_MARKERS = {
  recentCrosses: RECENT_CROSSES_TITLE, // grounding/indicators.ts（共用常數）
  sectorFactors: SECTOR_FACTORS_TITLE, // grounding/sectorFactors.ts（共用常數）
  priceLevels: PRICE_LEVELS_TITLE, // grounding/priceLevels.ts（共用常數）
  chipsRatios: "籌碼比例（", // grounding/chipsRatios.ts
  socialSentiment: "社群情緒（", // grounding/sentiment.ts
  institutional: "三大法人", // grounding/stock.ts、movers.ts、techScreen.ts
  macro: "美國總體經濟", // macroText.ts
  nightFutures: "夜盤", // marketIndices / marketOverview.ts
  indicators: /RSI|KD|MACD|黃金交叉|死亡交叉/,
  similarCases: SIMILAR_CASES_TITLE, // learning/similar.ts（共用常數）
  lessons: LESSONS_TITLE, // learning/lessonMatch.ts（共用常數）
  aiView: AI_VIEW_TITLE, // learning/aiAdjust.ts（共用常數）
  topicNews: TOPIC_NEWS_TITLE, // data/topicNews.ts（共用常數）
  ratingChange: RATING_CHANGE_TITLE, // ratingChange.ts（共用常數）
} as const;

/** 使用者引用「你更早說過」的話（看不到的對話）。 */
const EARLIER_CLAIM_PATTERN = /你(早上|昨天|剛剛|剛才|之前|先前|上次|稍早|前面)|說過|不是說/;
/** 問社群／網路討論氣氛：就算沒附社群情緒區塊也要帶規則（要直說查不到，不可拿新聞充當）。 */
const SOCIAL_TOPIC_PATTERN = /社群|情緒|Reddit|網友|散戶討論|PTT|推特|討論度/i;
/** 問到利率／升降息才帶升降息細部框架。 */
const RATE_TOPIC_PATTERN = /升息|降息|利率|聯準會|Fed|FOMC|央行|通膨|殖利率/i;
/** 問大盤／市場氣氛時，大盤層級的【市場歷史與情緒走勢】才派得上用場。 */
export const MARKET_JUDGMENT_PATTERN = /大盤|加權|指數|市場|台股|美股|情緒|恐慌|VIX|大環境|總經|景氣/i;

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
  /** 本站綜合評等名單（全市場推薦用）文字 */
  ratingListText?: string;
  /** 參考資料有附【目前時段與回答立場】 */
  hasTradingStance?: boolean;
  /** 「這幾檔／這些」指代上一則回答的清單 */
  listReference?: boolean;
  /** 主題新聞搜尋的資料區塊文字（有搜尋才有；見 data/topicNews.ts） */
  topicNewsText?: string;
  /** 大盤題的精簡漲跌榜（grounding/movers.ts buildMarketPulseGrounding） */
  marketPulseText?: string;
}

export function composeAskSystemPrompt(c: AskPromptContext): string {
  const dataText = [c.stockText, c.holdingsText, c.moversText, c.techScreenText, c.ratingListText ?? ""].join("\n");
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
    // 只在使用者真的引用「你之前說過」時才組入（2026-10-06 評測：有對話紀錄就組入，模型在沒人提時也念「我只看得到這次的對話」）。
    EARLIER_CLAIM_PATTERN.test(c.question) ? RULE_NO_UNVERIFIABLE_CONFESSION : "",
    // 個股／指標／籌碼（依資料文字偵測）
    dataText.includes(BLOCK_MARKERS.recentCrosses) ? RULE_NO_CANT_BACKTRACK_WHEN_DATA : "",
    hasStockHistory || marketHistoryRelevant ? RULE_USE_HISTORICAL_CONTEXT : "",
    BLOCK_MARKERS.indicators.test(dataText) ? RULE_INDICATORS : "",
    dataText.includes(BLOCK_MARKERS.institutional) ? RULE_TW_CHIPS : "",
    dataText.includes(BLOCK_MARKERS.chipsRatios) ? RULE_CHIPS_RATIOS : "",
    dataText.includes(BLOCK_MARKERS.sectorFactors) ? RULE_SECTOR_FACTORS : "",
    dataText.includes(BLOCK_MARKERS.socialSentiment) || SOCIAL_TOPIC_PATTERN.test(c.question) ? RULE_SOCIAL_SENTIMENT : "",
    c.stockCount > 1 ? RULE_MULTI_STOCK_COMPARISON : "",
    c.twMarketOpen && (hasStockLike || c.moversText || c.techScreenText) ? RULE_INTRADAY_TW : "",
    c.usMarketOpen && (hasStockLike || c.moversText || c.techScreenText) ? RULE_INTRADAY_US : "",
    // 大盤／總經
    c.indexText.includes(BLOCK_MARKERS.macro) ? RULE_MACRO : "",
    (c.topicNewsText ?? "").includes(BLOCK_MARKERS.topicNews) ? RULE_TOPIC_NEWS : "",
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
    hasStockLike ? RULE_PRICE_LEVEL_CONSISTENCY : "",
    dataText.includes(BLOCK_MARKERS.priceLevels) ? RULE_USE_PRICE_FRAMEWORK : "",
    c.stockCount > 0 && !c.marketWide ? RULE_ONLY_ASKED_STOCKS : "",
    c.listReference ? RULE_LIST_REFERENCE : "",
    dataText.includes(SITE_RATING_TITLE) ? RULE_FOLLOW_SITE_RATING : "",
    dataText.includes(BLOCK_MARKERS.similarCases) || dataText.includes(BLOCK_MARKERS.lessons) ? RULE_EXPERIENCE : "",
    dataText.includes(BLOCK_MARKERS.aiView) ? RULE_AI_VIEW : "",
    dataText.includes(BLOCK_MARKERS.ratingChange) ? RULE_RATING_CHANGE : "",
    c.hasTradingStance ? RULE_TRADING_STANCE : "",
    c.stockText.includes(DECISION_CARD_TITLE) ? RULE_DECISION_CARD : "",
    (c.marketPulseText ?? "").includes(MARKET_PULSE_TITLE) ? RULE_MARKET_PULSE : "",
    RULE_YES_NO_DIRECT,
    weekendNoteForAi(),
    // 放最後：長度與格式規則聲明優先於前面要求多解釋的規則
    RULE_CONCISE_ANSWER,
  ]
    .filter(Boolean)
    .join("\n");
}
