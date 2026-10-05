import type { RatingCode } from "./siteRating";

/**
 * 教訓清單（純資料；比對與驗證邏輯在 learning/lessonMatch.ts）。
 *
 * 每條：條件描述、可程式比對的條件（全部成立才算相關）、統計證據、建立日期、狀態。
 * - 新增／修改教訓：直接改這個檔案的常數陣列；證據數字一定要附來源。
 * - 每日學習工作會用評等紀錄的實際獎勵重新驗證每條（learning/lessonMatch.ts validateLessons），
 *   結果在成績看板與 `py scripts/update-lessons.py` 列出；「證據已不成立」的由主 agent 檢查後
 *   手動改狀態或刪除，程式不會自動刪。
 * - expectedExcessSign：這條教訓預期「符合條件時買進」的 5 日超額方向（-1＝不利、+1＝有利），驗證時比對用。
 */

export type LessonStatus = "有效" | "待驗證" | "已失效";

/** 可比對的特徵欄位（learning/features.ts RatingFeatures 的數值／旗標欄位）。 */
export type LessonField = "rsi" | "r5" | "r10" | "r20" | "b20" | "b60" | "lu" | "vr";

export interface LessonCondition {
  field: LessonField;
  op: ">=" | ">" | "<=" | "<";
  value: number;
}

export interface Lesson {
  id: string;
  /** 條件描述（給人看） */
  condition: string;
  /** 給 AI 引用的一句話 */
  advice: string;
  /** 全部成立才相關；空陣列＝只看 codes */
  when: LessonCondition[];
  /** 只在這些結論時附上（不給＝不限） */
  codes?: RatingCode[];
  /** 任一組成立即可（OR）；給了就取代 when */
  anyOf?: LessonCondition[][];
  evidence: {
    /** 樣本數（未知寫 null） */
    n: number | null;
    /** 5 日超額報酬（%；未知 null） */
    excessPct: number | null;
    /** 跑贏比例（%；未知 null） */
    winRatePct: number | null;
    source: string;
  };
  expectedExcessSign: 1 | -1;
  created: string;
  status: LessonStatus;
}

/** 擴大回測報告（2026-10-05）。 */
const WIDE = "docs/backtest/2026-10-wide-summary.md（198 檔×99 週、減同市值層級平均）";

// 2026-10-06 修正：原本「RSI≥75 是最一致的負向訊號（61 筆、5 日 −2.58%）」來自 60 檔／2 個月小樣本，
// 擴大回測沒有重現（追高組 5 日 −0.23% 不顯著、20 日 +1.64%），跟評等規則（急漲只提示、不擋）矛盾——
// 使用者 10/6 回報主結論「建議買進」下一行卻引用這條說「有效」，不知道以哪個為主。改成跟評等規則一致的說法。
export const LESSON_RSI_OVERHEAT: Lesson = {
  id: "rsi-75",
  condition: "RSI ≥ 75",
  advice: "短線 5 日常回檔、但 20 日表現不比較差（擴大回測 20 日 +1.64%），所以不是不能買，宜分批、不要一次買滿（舊的 60 檔小樣本「5 日 −2.58%」結論已被擴大樣本修正）",
  when: [{ field: "rsi", op: ">=", value: 75 }],
  evidence: { n: 1745, excessPct: -0.23, winRatePct: null, source: `${WIDE}：追高組（5日>15% 或 RSI≥75）5 日 −0.23%（不顯著）、20 日 +1.64%` },
  expectedExcessSign: -1,
  created: "2026-10-05",
  status: "有效",
};

// 2026-10-06 修正：同 LESSON_RSI_OVERHEAT（小樣本「急漲 90 筆 5 日 −1.15%」在擴大回測沒有重現）。
export const LESSON_SURGE: Lesson = {
  id: "surge",
  condition: "近 5 日漲幅 > 15% 或近 10 日漲幅 > 25%（急漲）",
  advice: "急漲後短線 5 日常回檔、但 20 日表現不比較差，所以不是不能買，宜分批、不要一次買滿（舊的 60 檔小樣本「5 日 −1.15%」結論已被擴大樣本修正）",
  when: [],
  anyOf: [[{ field: "r5", op: ">", value: 15 }], [{ field: "r10", op: ">", value: 25 }]],
  evidence: { n: 1745, excessPct: -0.23, winRatePct: null, source: `${WIDE}：追高組 5 日 −0.23%（不顯著）、20 日 +1.64%` },
  expectedExcessSign: -1,
  created: "2026-10-05",
  status: "有效",
};

export const LESSON_LIMIT_UP_CHASE: Lesson = {
  id: "limit-up-chase",
  condition: "近 3 日內有漲停、且近 20 日漲幅 > 25%",
  advice: "漲停後隔日開高進場，進場價常是短線高點，宜分批、設好出場價（個案觀察，結論仍以本站綜合評等為準）",
  when: [
    { field: "lu", op: ">=", value: 1 },
    { field: "r20", op: ">", value: 25 },
  ],
  evidence: { n: 8, excessPct: null, winRatePct: null, source: "2026-10-05 使用者依推薦買的 8 檔中 6 檔追在急漲／漲停後（個案，未做統計回測）" },
  expectedExcessSign: -1,
  created: "2026-10-05",
  status: "待驗證",
};

// 2026-10-06：評等改果斷二分、不再有「等回檔」（siteRating.ts），這條只留給舊紀錄的驗證，不再附給 AI。
export const LESSON_WAIT_FOR_ZONE: Lesson = {
  id: "wait-for-zone",
  condition: "評等為「等回檔再買」（舊評等）",
  advice: "等回檔的股票，回測中等價格回到買進區間上緣才買、抱 5 日平均 +0.71%（未扣大盤）",
  when: [],
  codes: ["buy-on-pullback"],
  evidence: { n: null, excessPct: null, winRatePct: null, source: "2026-10-05 檢討回測（等回檔組回到區間才買抱 5 日 +0.71%，未扣大盤）" },
  expectedExcessSign: -1,
  created: "2026-10-05",
  status: "已失效",
};

export const LESSON_TAKE_PROFIT: Lesson = {
  id: "take-profit",
  condition: "近 20 日已漲 > 10% 的建議買進／等回檔個股",
  advice: "使用者多檔持股曾獲利 5～12% 但沒停利又跌回成本；買進後要設停利紀律（曾獲利≥8%跌回成本就減碼）",
  when: [{ field: "r20", op: ">", value: 10 }],
  codes: ["buy", "buy-on-pullback"],
  evidence: { n: null, excessPct: null, winRatePct: null, source: "2026-10-05 使用者持股檢討（個案）" },
  expectedExcessSign: -1,
  created: "2026-10-05",
  status: "待驗證",
};

// 2026-10-06 更新：原本引用 33 筆小樣本「建議買進 5 日 −1.47%」；二分評等擴大回測 3,524 筆為正但未達統計可靠。
export const LESSON_TECH_SCORE_NEGATIVE: Lesson = {
  id: "tech-score-negative",
  condition: "評等為「建議買進」",
  advice: "誠實提醒：擴大回測中本站「建議買進」10 日超額 +0.34%、20 日 +0.76%，方向為正但尚未達統計可靠，評等是參考、宜分批並設出場價",
  when: [],
  codes: ["buy"],
  evidence: { n: 3524, excessPct: 0.2, winRatePct: null, source: `${WIDE}：2026-10-05 二分評等（0e01390）建議買進組` },
  expectedExcessSign: 1,
  created: "2026-10-05",
  status: "待驗證",
};

export const LESSONS: Lesson[] = [
  LESSON_RSI_OVERHEAT,
  LESSON_SURGE,
  LESSON_LIMIT_UP_CHASE,
  LESSON_WAIT_FOR_ZONE,
  LESSON_TAKE_PROFIT,
  LESSON_TECH_SCORE_NEGATIVE,
];
