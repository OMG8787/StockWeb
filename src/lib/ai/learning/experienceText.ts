import type { StockRatingResult } from "../stockRating";
import { describeLessons, matchLessons } from "./lessonMatch";
import { readSimilarTable } from "./learningStore";
import { describeSimilarCases, lookupSimilar } from "./similar";

/**
 * 個股資料區塊的「經驗層」兩行（相似案例統計＋相關教訓），接在【本站綜合評等】後面。
 * 只有台股（評等紀錄與獎勵都以加權指數為基準）；相似案例只讀 Redis 小表（記憶體快取 10 分鐘），fail open。
 */
export async function describeExperience(r: StockRatingResult | null | undefined): Promise<string[]> {
  if (!r || r.market !== "TW") return [];
  const table = await readSimilarTable().catch(() => ({}));
  return [describeSimilarCases(lookupSimilar(r.features, r.regime, table)), describeLessons(matchLessons(r.features, r.rating.code))].filter(
    (s): s is string => !!s
  );
}

