/**
 * 資料層的對外門面（barrel）。
 *
 * 這個檔案本身**不放任何邏輯**，只負責把 `src/lib/data/` 底下各個單一職責的
 * 模組重新匯出成一個穩定的 `@/lib/data` 公開介面——全站幾十個檔案都是從這裡
 * import，所以拆檔案時只要這份清單不變，呼叫端就完全不用跟著改。
 *
 * 各模組的職責：
 * - `symbols.ts`      代號/市場判斷（detectMarket、normalizeSymbol、板別解析）
 * - `quote.ts`        單檔即時報價與內外盤
 * - `chart.ts`        單檔K線（含當日分時）
 * - `marketIndices.ts` 大盤指數與台指期夜盤
 * - `twMergedMaps.ts` TWSE/TPEx/興櫃「整個市場一份對照表」的合併helper
 * - `companyData.ts`  個股基本面/財報/籌碼/重大訊息（都走整市場對照表再查表）
 * - `marketQuoteMap.ts` 全市場批次報價快取
 * - `search.ts`       篩選/排序（searchStocks）
 * - `degradedCache.ts` 「空結果只給短TTL」的快取變體
 * - `momentum.ts`     技術訊號共振股
 * - `techScreen.ts`   多重技術指標篩選用的全市場指標快照
 * - `volumeSurge.ts`  價漲量增＋連漲天數
 * - `valueScreen.ts`  本益比/殖利率/股價淨值比/跌幅排行
 * - `chipsRanking.ts` 三大法人/外資/投信買賣超排行
 * - `chipsRatios.ts`  融資使用率/外資持股比例/大戶持股比例＋前一期（個股頁最上方摘要）
 *   - `foreignHoldings.ts` 外資持股（TWSE MI_QFIIS／TPEx qfii，可查指定日）
 *   - `majorHolders.ts`    集保股權分散表第15級（週資料＋週快照/官網個股查詢補上一週）
 * - `volumeBackfill.ts` 量能歷史的一次性回填
 */

export * from "./types";
export type { MarketDepth } from "./yahooTwMarketDepth";
export {
  sectorsFor,
  getTwUniverse,
  ensureTwUniverseWarm,
  findSymbolByName,
  findAllSymbolsByName,
  findInUniverse,
  searchUniverseByQuery,
} from "./universe";
export type { UniverseEntry } from "./universe";
export { describeTaifexNightFutures } from "./taifex";

export { detectMarket, normalizeSymbol } from "./symbols";
export { getQuote, getMarketDepth } from "./quote";
export { getChart, getLastChartFailure } from "./chart";
export { getIndices, getTaifexNightFutures } from "./marketIndices";
export { getFundamentals, getEarnings, getChips, getMaterialAnnouncements } from "./companyData";
export { backfillVolumeHistory } from "./volumeBackfill";
export { searchStocks } from "./search";
export type { SearchFilters } from "./search";
export { getMultiSignalStocks } from "./momentum";
export type { MomentumItem } from "./momentum";
export { getLastTechScreenRun, getTechnicalScreen } from "./techScreen";
export type { TechScreenItem } from "./techScreen";
export { getVolumeSurgeStocks } from "./volumeSurge";
export type { VolumeSurgeItem } from "./volumeSurge";
export { getValueScreen } from "./valueScreen";
export type { ValueScreen, ValueScreenItem } from "./valueScreen";
export { getChipsRanking } from "./chipsRanking";
export { getChipsRatios, getChipsRatiosBatch, MAJOR_WEB_FALLBACK_MAX_SYMBOLS } from "./chipsRatios";
export { getMacroSnapshot, isMacroConfigured } from "./macro";
export type { MacroIndicator, MacroSnapshot } from "./macro";
export type { ChipsRanking, ChipsRankingItem } from "./chipsRanking";
