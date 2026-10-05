export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 所有 AI 供應商共用的 temperature。2026-10-05 使用者回報「同一題每次問答案都不一樣」：
 * 本站的回答幾乎都是判斷型（買不買、怎麼解讀資料），原本 0.4 讓措辭與結論每次飄動；
 * 結論已改由程式算好（siteRating.ts），這裡再壓低隨機性，讓短時間內重問的說法也接近。
 */
export const AI_TEMPERATURE = 0.2;
