/**
 * AI 建議名單的「資料池」常數與說明（單一來源）：actionGrounding.ts 用這些數字組候選池，
 * 策略模擬器的來源說明（SourcePicker）也讀同一份，避免畫面上寫的跟實際不一樣。
 */
export const POOL_MOMENTUM_LIMIT = 8;
export const POOL_VALUE_LIMIT = 4;
export const POOL_GAINER_LIMIT = 6;
export const POOL_CHIP_LIMIT = 6;
export const POOL_TRUST_LIMIT = 4;
/** 候選池總上限（依下列順序加入，滿了後面來源的新股票不再加） */
export const POOL_CANDIDATE_LIMIT = 30;
/** 完整排名名單的上限（各帳號可設定顯示前 5／10／15／20 檔） */
export const AI_LIST_MAX = 20;
/** 初篩通過的最多拿幾檔去算本站綜合評等 */
export const POOL_RATED_LIMIT = 24;
/** 漲幅榜流動性下限（成交值，元） */
export const POOL_MIN_TURNOVER_TWD = 30_000_000;

/** 候選池來源（依加入順序） */
export const POOL_SOURCES: Array<{ label: string; limit: number; note: string }> = [
  { label: "技術訊號共振清單", limit: POOL_MOMENTUM_LIMIT, note: "多個技術指標同時轉強的股票" },
  { label: "低本益比排行", limit: POOL_VALUE_LIMIT, note: "估值便宜（今天不一定大漲）" },
  { label: "高殖利率排行", limit: POOL_VALUE_LIMIT, note: "股利率高" },
  { label: "低股價淨值比排行", limit: POOL_VALUE_LIMIT, note: "股價相對淨值便宜" },
  { label: "今日漲幅榜", limit: POOL_GAINER_LIMIT, note: "當天漲最多且成交值 ≥ 3,000 萬元，用來辨別是否追高" },
  { label: "外資買超榜", limit: POOL_CHIP_LIMIT, note: "外資當天買超最多" },
  { label: "三大法人買超榜", limit: POOL_CHIP_LIMIT, note: "外資＋投信＋自營商合計買超最多" },
  { label: "投信買超榜", limit: POOL_TRUST_LIMIT, note: "投信當天買超最多" },
];
