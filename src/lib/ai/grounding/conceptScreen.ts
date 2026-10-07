import { getConceptScreen, type ConceptStats } from "@/lib/data/conceptScreen";
import { formatLiveQuote } from "../livePrice";
import { SCREEN_CONCEPT_LABEL, type ScreenConcept } from "../questionType";
import { confidenceRank, describeSiteRating } from "../siteRating";
import { getStockRatings } from "../stockRating";

/**
 * 概念篩選題（questionType.ts 判成 screen-concept）的參考資料：把「抗壓性強／上漲趨勢／低波動／高殖利率」對應到
 * 程式算得出的條件（數字在 data/conceptScreen.ts），名單、排序與每檔本站綜合評等都由程式決定，AI 只解說。
 * 2026-10-07 使用者📝：問「有看起來抗壓性強且有上漲趨勢的股票嗎」→ 只答上文的啟碁／答成大盤偏多／NVIDIA 編台積電 600 元。
 */
export const CONCEPT_SCREEN_TITLE = "【概念篩選（程式依真實日K算好）】";
/** 名單最多幾檔（每檔要算評等）。 */
export const CONCEPT_SCREEN_MAX = 6;
const RATING_WAIT_MS = 12_000;
const SCREEN_WAIT_MS = 15_000;

/** 每個概念的程式條件（文字給 AI 照實轉述用；判斷式在 passes）。 */
export const CONCEPT_RULE_TEXT: Record<ScreenConcept, string> = {
  resilient: "近60日加權指數下跌的日子平均比大盤少跌（抗跌＞0個百分點），且近60日最大回撤不高於掃描範圍的中位數",
  uptrend: "現價站上20日均線、20日均線高於季線（60日均線），且20日均線比5個交易日前高（趨勢向上）",
  lowVol: "近20個交易日的日漲跌幅標準差在掃描範圍內最低的三成",
  highYield: "官方殖利率 4% 以上",
};

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/** 純函式（有測試）：各概念是否符合。 */
export function conceptChecks(pool: ConceptStats[]): (s: ConceptStats, c: ScreenConcept) => boolean {
  const mddMedian = quantile(pool.map((p) => p.maxDrawdown60).filter((v): v is number => v != null), 0.5);
  const vol30 = quantile(pool.map((p) => p.volatility20).filter((v): v is number => v != null), 0.3);
  return (s, c) => {
    switch (c) {
      case "resilient":
        return s.downDayExcess != null && s.downDayExcess > 0 && s.maxDrawdown60 != null && s.maxDrawdown60 <= mddMedian;
      case "uptrend":
        return s.ma20 != null && s.ma60 != null && s.price > s.ma20 && s.ma20 > s.ma60 && s.ma20Rising === true;
      case "lowVol":
        return s.volatility20 != null && s.volatility20 <= vol30;
      case "highYield":
        return s.dividendYield != null && s.dividendYield >= 4;
    }
  };
}

/** 排序分數（越大越好），多個概念取平均名次。 */
function sortKey(c: ScreenConcept, s: ConceptStats): number {
  switch (c) {
    case "resilient":
      return (s.downDayExcess ?? -99) - (s.maxDrawdown60 ?? 99) / 10;
    case "uptrend":
      return s.ret60 ?? -99;
    case "lowVol":
      return -(s.volatility20 ?? 99);
    case "highYield":
      return s.dividendYield ?? -99;
  }
}

/** 純函式（有測試）：依概念挑名單——全部符合的優先，不夠再補「符合最多項」的（標明缺哪項）。 */
export function pickConceptStocks(
  pool: ConceptStats[],
  concepts: ScreenConcept[],
  max = CONCEPT_SCREEN_MAX
): { full: ConceptStats[]; partial: Array<{ s: ConceptStats; missing: ScreenConcept[] }> } {
  const pass = conceptChecks(pool);
  const rank = new Map<string, number>();
  for (const c of concepts) {
    [...pool]
      .sort((a, b) => sortKey(c, b) - sortKey(c, a))
      .forEach((s, i) => rank.set(s.symbol, (rank.get(s.symbol) ?? 0) + i / concepts.length));
  }
  const byRank = (a: ConceptStats, b: ConceptStats) => (rank.get(a.symbol) ?? 0) - (rank.get(b.symbol) ?? 0);
  const full = pool.filter((s) => concepts.every((c) => pass(s, c))).sort(byRank).slice(0, max);
  const partial =
    full.length >= 3 || concepts.length < 2
      ? []
      : pool
          .filter((s) => !full.includes(s))
          .map((s) => ({ s, missing: concepts.filter((c) => !pass(s, c)) }))
          .filter((x) => x.missing.length < concepts.length)
          .sort((a, b) => a.missing.length - b.missing.length || byRank(a.s, b.s))
          .slice(0, Math.max(0, Math.min(3, max - full.length)));
  return { full, partial };
}

function fmtPct(n: number | null, signed = true): string {
  if (n == null) return "—";
  return `${signed && n > 0 ? "+" : ""}${n}%`;
}

/** 一檔的數字行（每個數字都是程式算的，AI 引用這些）。 */
export function describeConceptLine(s: ConceptStats): string {
  const parts = [
    `${s.name}(${s.symbol})：${formatLiveQuote({ price: s.price, changePercent: s.changePercent })}`,
    `近20日 ${fmtPct(s.ret20)}、近60日 ${fmtPct(s.ret60)}`,
    s.ma20 != null && s.ma60 != null
      ? `20日均線 ${s.ma20}${s.price > s.ma20 ? "（現價在上）" : "（現價在下）"}、季線 ${s.ma60}、20日均線${s.ma20Rising ? "上升" : "走平或下降"}`
      : "",
    s.downDayExcess != null ? `大盤下跌日平均比大盤${s.downDayExcess >= 0 ? "少跌" : "多跌"} ${Math.abs(s.downDayExcess)} 個百分點（近60日 ${s.downDays} 個下跌日）` : "",
    s.maxDrawdown60 != null ? `近60日最大回撤 ${s.maxDrawdown60}%` : "",
    s.beta60 != null ? `beta ${s.beta60}` : "",
    s.volatility20 != null ? `近20日日波動 ${s.volatility20}%` : "",
    s.dividendYield != null ? `殖利率 ${s.dividendYield}%` : "",
  ];
  return parts.filter(Boolean).join("；");
}

/**
 * 組【概念篩選】區塊。抓不到資料（冷快取逾時）就照實寫「這次算不出來」，不可讓 AI 自己編名單。
 */
export async function buildConceptScreenGrounding(concepts: ScreenConcept[]): Promise<string> {
  if (concepts.length === 0) return "";
  const labels = concepts.map((c) => SCREEN_CONCEPT_LABEL[c]).join("＋");
  const pool = await Promise.race([
    getConceptScreen().catch(() => [] as ConceptStats[]),
    new Promise<ConceptStats[]>((resolve) => setTimeout(() => resolve([]), SCREEN_WAIT_MS)),
  ]);
  if (pool.length === 0) {
    return `${CONCEPT_SCREEN_TITLE}使用者要找「${labels}」的股票，但這次全市場統計暫時算不出來（資料來源逾時）：照實說這次算不出名單、請稍後再問，不可自己列股票或編價格。`;
  }
  const { full, partial } = pickConceptStocks(pool, concepts);
  const picked = [...full, ...partial.map((p) => p.s)];
  const ratings = picked.length
    ? await Promise.race([
        getStockRatings(picked.map((s) => ({ symbol: s.symbol, market: "TW" as const })), undefined, "ai-ask"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RATING_WAIT_MS)),
      ]).catch(() => null)
    : null;
  const ratingLine = (s: ConceptStats) => {
    const r = ratings?.get(s.symbol.toUpperCase());
    return r ? `\n  ${describeSiteRating(r.name, r.symbol, r.rating)}` : "";
  };
  // 有評等的依本站把握程度排（建議買進在前），其餘保持條件排序。
  const order = (list: ConceptStats[]) =>
    list
      .map((s, i) => ({ s, i, k: ratings?.get(s.symbol.toUpperCase()) ? confidenceRank(ratings.get(s.symbol.toUpperCase())!.rating) : 3 }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.s);
  const rules = concepts.map((c) => `${SCREEN_CONCEPT_LABEL[c]}＝${CONCEPT_RULE_TEXT[c]}`).join("；");
  const lines = [
    `${CONCEPT_SCREEN_TITLE}使用者問「${labels}」。本站把這些說法換成程式條件：${rules}。掃描範圍：今日成交金額前 ${pool.length} 檔台股（不是全部上市櫃）；數字都用近3個月真實日K算，是過去表現、不保證之後。`,
    full.length > 0
      ? `全部條件都符合（共 ${full.length} 檔，已排序）：\n${order(full).map((s) => `- ${describeConceptLine(s)}${ratingLine(s)}`).join("\n")}`
      : `全部條件都符合：0 檔（掃描範圍內實際逐檔比對過，這次沒有）。`,
    partial.length > 0
      ? `只符合部分條件（全部符合的不到 3 檔，補最接近的；回答時要講缺哪一項）：\n${partial
          .map((p) => `- ${describeConceptLine(p.s)}（未符合：${p.missing.map((c) => SCREEN_CONCEPT_LABEL[c]).join("、")}）${ratingLine(p.s)}`)
          .join("\n")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}
