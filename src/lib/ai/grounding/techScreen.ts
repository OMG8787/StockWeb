import { getTechnicalScreen } from "@/lib/data";
import type { TechScreenItem } from "@/lib/data";
import { describeTechState } from "./indicators";
import { getStockRating, getStockRatings, type StockRatingResult } from "../stockRating";
import { confidenceRank, describeSiteRating, isRecommendable } from "../siteRating";
import {
  conditionsForQuestion,
  describeCondition,
  DUAL_CLOSEST_LIMIT,
  DUAL_CLOSEST_MAX_EST_DAYS,
  matchesAllConditions,
  rankDualNearCross,
  type CrossDirection,
  type DualNearEntry,
  type IndicatorCondition,
} from "../techScreenConditions";
import {
  KD_NEAR_CROSS_CONVERGING_DAYS,
  KD_NEAR_CROSS_MAX_EST_DAYS,
  KD_NEAR_CROSS_MAX_GAP,
  MACD_NEAR_CROSS_CONVERGING_DAYS,
  MACD_NEAR_CROSS_MAX_EST_DAYS,
} from "@/lib/nearCross";

// 明細表最多列幾檔：凡是「今天有任一交叉」的一律全部列出（這才是多重指標
// 篩選真正會用到的母體，通常一天只有十幾檔），另外再補上成交金額最大的
// 幾檔（讓「台積電現在技術面如何」這類問法也有數值可引用）。
const TECH_TABLE_EXTRA_BY_TURNOVER = 25;

/** 「即將交叉」清單共用的免責說明：AI 必須照這個意思轉述，不可說成「明天會交叉」。 */
export const NEAR_CROSS_DISCLAIMER =
  "這是依最近幾天兩線收斂的趨勢線性外推的推估（判斷門檻為本站自訂經驗值，不是權威標準），明天不一定會交叉，股價一轉向差距就可能重新拉開";

/** MACD 數值的刻度隨股價差很多（低價股可能只有 0.0x），小數位數依大小調整。 */
const fmtMacd = (v: number) => (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

/** 「即將KD交叉」清單的一行：附 K、D、差距逐日變化與推估天數。 */
function describeKdNearCross(i: TechScreenItem): string {
  const n = i.state.kdNearCross;
  if (!n) return "";
  const golden = n.direction === "golden";
  const zone = n.fast <= 30 ? "低檔/超賣區" : n.fast >= 70 ? "高檔/超買區" : "中間區間";
  return `${i.name}(${i.symbol})，現價${i.price}(${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%)：K值${n.fast.toFixed(1)}${golden ? "仍低於" : "仍高於"}D值${n.slow.toFixed(1)}（${zone}），兩線差距近${n.gaps.length}日 ${n.gaps.map((g) => g.toFixed(1)).join("→")}（K值${golden ? "上升" : "下降"}、差距連續縮小），照目前速度推估約${Math.max(1, Math.round(n.estDays))}個交易日內可能${golden ? "黃金" : "死亡"}交叉`;
}

/** 「即將MACD交叉」清單的一行：附 DIF、訊號線、柱狀體逐日變化與推估天數。 */
function describeMacdNearCross(i: TechScreenItem): string {
  const n = i.state.macdNearCross;
  if (!n) return "";
  const golden = n.direction === "golden";
  const hist = n.gaps.map((g) => fmtMacd(golden ? -g : g)).join("→");
  return `${i.name}(${i.symbol})，現價${i.price}(${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%)：DIF ${fmtMacd(n.fast)}${golden ? "仍低於" : "仍高於"}訊號線 ${fmtMacd(n.slow)}（DIF在0軸${n.fast >= 0 ? "上方" : "下方"}），柱狀體(DIF−訊號線)近${n.gaps.length}日 ${hist}（連續縮小、逼近0），照目前速度推估約${Math.max(1, Math.round(n.estDays))}個交易日內可能${golden ? "黃金" : "死亡"}交叉`;
}

/** MACD 與 KD 同時黃金交叉的股票，最多對幾檔附本站綜合評等（每檔可能要抓日K）。 */
export const TECH_SCREEN_RATING_LIMIT = 8;
/** 算評等最多等多久，逾時就不附（不拖慢聊天回應）。 */
const TECH_SCREEN_RATING_WAIT_MS = 12_000;

/**
 * 2026-10-05 使用者回報：問「MACD與KD皆黃金交叉、你多方面驗證後建議買入的股票」→ AI 說健鼎「建議買入」，
 * 到個股頁問AI卻說「暫緩觀望」。技術條件只是篩選條件，買不買要跟個股頁同一份本站綜合評等。
 */
async function describeBothGoldenRatings(items: TechScreenItem[]): Promise<string> {
  const targets = items
    .filter((i) => i.state.macdCross === "golden" && i.state.kd?.cross === "golden")
    .slice(0, TECH_SCREEN_RATING_LIMIT);
  if (targets.length === 0) return "";
  const ratings = await Promise.race([
    getStockRatings(targets.map((t) => ({ symbol: t.symbol })), undefined, "tech-screen"),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TECH_SCREEN_RATING_WAIT_MS)),
  ]).catch(() => null);
  if (!ratings || ratings.size === 0) return "";
  const lines = targets
    .map((t) => ratings.get(t.symbol.toUpperCase()))
    .filter((r) => r != null)
    // 建議買進依本站把握程度高→低排前面（2026-10-06 使用者：優先顯示把握程度最高的），先不要買在後。
    .map((r, i) => ({ r, i }))
    .sort((a, b) => confidenceRank(a.r.rating) - confidenceRank(b.r.rating) || a.i - b.i)
    .map(({ r }) => describeSiteRating(r.name, r.symbol, r.rating));
  return `【MACD與KD同時黃金交叉者的本站綜合評等（跟今日建議、個股頁「問AI關於」同一份結論）】技術交叉只是篩選條件，買不買以這裡的評等為準：\n${lines.join("\n")}`;
}

/** 「MACD 與 KD 同時即將交叉」清單的一行：兩條線各自的數值與推估天數。 */
function describeDualNearCross(e: DualNearEntry, direction: CrossDirection): string {
  const { item } = e;
  const kd = item.state.kd;
  const m = item.state.macdReading;
  if (!kd || !m) return "";
  const golden = direction === "golden";
  const days = (v: number | null) => (v == null ? "差距沒有縮小" : `推估約${Math.max(1, Math.round(v))}個交易日`);
  return `${item.name}(${item.symbol})，現價${item.price}(${item.changePercent >= 0 ? "+" : ""}${item.changePercent}%)：KD 的 K值${kd.k.toFixed(1)}${golden ? "仍低於" : "仍高於"}D值${kd.d.toFixed(1)}（差距${Math.abs(kd.d - kd.k).toFixed(1)}、前一天${Math.abs(kd.prevD - kd.prevK).toFixed(1)}，${days(e.kdEst)}交叉）；MACD 的 DIF ${fmtMacd(m.dif)}${golden ? "仍低於" : "仍高於"}訊號線 ${fmtMacd(m.signal)}（柱狀體 ${fmtMacd(m.prevDif - m.prevSignal)}→${fmtMacd(m.dif - m.signal)}，${days(e.macdEst)}交叉）`;
}

/** 數值條件（RSI／K值／D值）名單最多列幾檔（掃描範圍最多 120＋60 檔）。 */
export const CONDITION_LIST_SHOW_LIMIT = 40;
/** 條件＋評等時，最多對幾檔符合條件者算評等（依成交金額由大到小；每檔可能要抓日K）。 */
export const CONDITION_RATING_LIMIT = 24;
/** 算評等最多等多久；逾時就只用已算好的，並在資料裡照實寫「只檢查了幾檔」。 */
const CONDITION_RATING_WAIT_MS = 22_000;
const CONDITION_RATING_CONCURRENCY = 5;

/** 逐檔算評等，到期限就回傳已完成的（不中斷背景請求，它們會順便暖快取）。 */
async function rateWithDeadline(
  targets: TechScreenItem[],
  waitMs: number
): Promise<{ ratings: Map<string, StockRatingResult>; checked: number }> {
  const ratings = new Map<string, StockRatingResult>();
  let checked = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const r = await getStockRating(t.symbol, t.market, "tech-screen").catch(() => null);
      checked++;
      if (r) ratings.set(t.symbol.toUpperCase(), r);
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(CONDITION_RATING_CONCURRENCY, targets.length) }, worker)),
    new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
  ]);
  return { ratings: new Map(ratings), checked };
}

/**
 * 使用者問的「數值條件」（RSI70以下、K值低於30…，可再加「建議買進」）由程式逐檔比對掃描範圍、列出名單（跟個股資料同一份指標、同一個 RSI）。
 * 2026-10-07 使用者回報：問「RSI70以下建議買進的股票」，AI 沒有名單，沿用上文台表科還編了 RSI 65（程式算出是 83）。
 */
async function buildConditionGrounding(
  all: Array<{ items: TechScreenItem[]; label: string }>,
  conds: IndicatorCondition[],
  rated: boolean
): Promise<string> {
  const condText = conds.map(describeCondition).join(" 且 ");
  const sections: string[] = [];
  const matchedAll: TechScreenItem[] = [];
  for (const { items, label } of all) {
    if (items.length === 0) continue;
    const matched = items.filter((i) => matchesAllConditions(i.state, conds)).sort((a, b) => b.turnover - a.turnover);
    matchedAll.push(...matched);
    const shown = matched.slice(0, CONDITION_LIST_SHOW_LIMIT);
    sections.push(
      `${label}符合「${condText}」者共${matched.length}檔（掃描範圍${items.length}檔，依成交金額由大到小${matched.length > shown.length ? `，只列前${shown.length}檔` : ""}）：${
        matched.length === 0 ? "（一檔都沒有，這是實際逐檔比對後的結果）" : "\n" + shown.map((i) => `- ${describeTechState(i)}`).join("\n")
      }`
    );
  }
  let ratedText = "";
  if (rated && matchedAll.length > 0) {
    const targets = matchedAll.slice(0, CONDITION_RATING_LIMIT);
    const { ratings, checked } = await rateWithDeadline(targets, CONDITION_RATING_WAIT_MS);
    const buys = targets
      .map((t) => ratings.get(t.symbol.toUpperCase()))
      .filter((r): r is StockRatingResult => r != null && isRecommendable(r.rating))
      .map((r, i) => ({ r, i }))
      .sort((a, b) => confidenceRank(a.r.rating) - confidenceRank(b.r.rating) || a.i - b.i)
      .map(({ r }) => r);
    const checkedNote = `成功算出${ratings.size}檔${checked < targets.length ? `、時間內只檢查到${checked}檔` : ""}`;
    const scope =
      matchedAll.length > targets.length
        ? `符合條件共${matchedAll.length}檔，依成交金額由大到小只算了前${targets.length}檔的本站綜合評等（${checkedNote}）`
        : `符合條件共${matchedAll.length}檔，已逐檔算本站綜合評等（${checkedNote}）`;
    ratedText = `\n\n【符合「${condText}」且本站綜合評等為「建議買進」的股票（程式逐檔算好；${scope}；回答只能列這份，結論照抄評等字樣、每檔一定寫出把握程度）】\n${
      buys.length === 0
        ? "（目前一檔都沒有：符合指標條件的股票本站評等都是「建議先不要買」或暫時算不出來，這是實際逐檔算過的結果，直接告訴使用者目前沒有，並可簡短說明符合指標條件但評等不建議買的原因）"
        : buys.map((r) => describeSiteRating(r.name, r.symbol, r.rating)).join("\n")
    }`;
  }
  return `【依使用者問的條件「${condText}${rated ? " 且 本站評等為建議買進" : ""}」由程式逐檔比對的名單（優先用這份回答；指標數值是用該檔日K（到最近一個已收盤的交易日）算好的 RSI(14)／KD，同一檔在個股資料裡是同一個數字）】\n${sections.join("\n\n")}${ratedText}`;
}

/**
 * 「多重技術指標同時符合」的篩選資料。
 *
 * 使用者要求：問「現在有沒有MACD與KD線都在黃金交叉，適合明天買入的股票?」
 * 這種同時要符合多個技術條件的問題時，要真的去查證資料、確定回答內容正確。
 * 2026-09-16 實測的真實 bug：當天市場上確實有股票同時符合（嘉基6715），
 * AI 卻回答「資料裡沒有同時列出MACD與KD都黃金交叉的股票」——因為舊的
 * 「技術訊號共振股」只掃當日漲跌幅前15檔（見 getTechnicalScreen 的註解），
 * 而且舊的 KD 訊號只認低檔交叉（見 lib/signals.ts 的 KD 註解），兩個原因
 * 疊在一起讓正確答案根本不可能出現在 AI 手上。
 *
 * 這裡把常見組合先用程式算好交集（而不是把一堆資料丟給 AI 讓它自己配對，
 * 那正是會出錯的地方），同時附上完整的指標明細表，讓沒有事先列舉到的
 * 其他組合（例如「均線多頭排列＋RSI未過熱＋站上20日均線」）也有真實數值
 * 可以逐檔核對。
 */
export interface TechScreenQuery {
  question?: string;
  /** 上一個使用者問句（「那建議買進的呢」這種接續題沿用上一題的數值條件） */
  lastUserTurn?: string;
}

export async function buildTechScreenGrounding(query: TechScreenQuery = {}): Promise<string> {
  const [tw, us] = await Promise.all([
    getTechnicalScreen("TW").catch(() => [] as TechScreenItem[]),
    getTechnicalScreen("US").catch(() => [] as TechScreenItem[]),
  ]);
  if (tw.length === 0 && us.length === 0) return "";

  const blockFor = (items: TechScreenItem[], marketLabel: string, scanned: number): string => {
    if (items.length === 0) return "";
    const fmtList = (list: TechScreenItem[]) =>
      list.length === 0
        ? "（最新交易日在掃描範圍內一檔都沒有，這是實際比對過每一檔指標後的結果，可以直接回答「最新交易日沒有」）"
        : list.map((i) => `- ${describeTechState(i)}`).join("\n");

    const macdGolden = items.filter((i) => i.state.macdCross === "golden");
    const macdDeath = items.filter((i) => i.state.macdCross === "death");
    const kdGolden = items.filter((i) => i.state.kd?.cross === "golden");
    const kdDeath = items.filter((i) => i.state.kd?.cross === "death");
    const bothGolden = items.filter((i) => i.state.macdCross === "golden" && i.state.kd?.cross === "golden");
    const bothDeath = items.filter((i) => i.state.macdCross === "death" && i.state.kd?.cross === "death");
    const bullishMaHealthyRsi = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.rsi != null && i.state.rsi < 70
    );
    const bullishMaMacdGolden = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.macdCross === "golden"
    );
    const oversoldTurning = items.filter(
      (i) => i.state.kd?.cross === "golden" && i.state.rsi != null && i.state.rsi <= 40
    );

    // 依推估天數由近到遠排，最可能先交叉的排前面。
    const byEst = (pick: (i: TechScreenItem) => number | undefined) => (a: TechScreenItem, b: TechScreenItem) =>
      (pick(a) ?? Infinity) - (pick(b) ?? Infinity);
    const kdNearGolden = items
      .filter((i) => i.state.kdNearCross?.direction === "golden")
      .sort(byEst((i) => i.state.kdNearCross?.estDays));
    const kdNearDeath = items
      .filter((i) => i.state.kdNearCross?.direction === "death")
      .sort(byEst((i) => i.state.kdNearCross?.estDays));
    const macdNearGolden = items
      .filter((i) => i.state.macdNearCross?.direction === "golden")
      .sort(byEst((i) => i.state.macdNearCross?.estDays));
    const macdNearDeath = items
      .filter((i) => i.state.macdNearCross?.direction === "death")
      .sort(byEst((i) => i.state.macdNearCross?.estDays));
    const dualGolden = rankDualNearCross(items, "golden");
    const dualDeath = rankDualNearCross(items, "death");
    const fmtDual = (list: DualNearEntry[], direction: CrossDirection, emptyText: string) =>
      list.length === 0 ? emptyText : list.map((e) => `- ${describeDualNearCross(e, direction)}`).join("\n");
    const fmtNear = (list: TechScreenItem[], describe: (i: TechScreenItem) => string) =>
      list.length === 0
        ? "（掃描範圍內目前一檔都沒有符合條件，這是實際逐檔比對後的結果）"
        : list.map((i) => `- ${describe(i)}`).join("\n");
    const nearHeader = (label: string, count: number, rule: string) =>
      `${marketLabel}【即將${label}（尚未交叉、僅為推估）】共${count}檔；條件：${rule}。注意：${NEAR_CROSS_DISCLAIMER}。`;

    const crossed = items.filter((i) => i.state.macdCross !== null || i.state.kd?.cross != null);
    const crossedSymbols = new Set(crossed.map((i) => i.symbol));
    const extras = items
      .slice()
      .sort((a, b) => b.turnover - a.turnover)
      .filter((i) => !crossedSymbols.has(i.symbol))
      .slice(0, TECH_TABLE_EXTRA_BY_TURNOVER);
    const tableRows = [...crossed, ...extras];

    return [
      `【${marketLabel}多重技術指標篩選】掃描範圍：依今日成交金額由大到小的前 ${scanned} 檔${marketLabel}（不是全部上市櫃股票；這個排序跟「有沒有發生指標交叉」完全無關，所以不會系統性漏掉某一類股票，但極冷門、幾乎沒有成交的股票不在範圍內）。以下每一檔的指標都是用該檔近3個月真實日K線當場算出來的，不是估計值。`,
      `${marketLabel}「MACD黃金交叉 且 KD黃金交叉」同時成立（共${bothGolden.length}檔）：\n${fmtList(bothGolden)}`,
      `${marketLabel}「MACD死亡交叉 且 KD死亡交叉」同時成立（共${bothDeath.length}檔）：\n${fmtList(bothDeath)}`,
      `${marketLabel}最新交易日 MACD黃金交叉（共${macdGolden.length}檔）：\n${fmtList(macdGolden)}`,
      `${marketLabel}最新交易日 KD黃金交叉（K值上穿D值，共${kdGolden.length}檔；括號裡會註明發生在低檔/中間/高檔，低檔交叉是最標準的轉強訊號，高檔交叉要留意追高風險）：\n${fmtList(kdGolden)}`,
      `${marketLabel}最新交易日 MACD死亡交叉（共${macdDeath.length}檔）：\n${fmtList(macdDeath)}`,
      `${marketLabel}最新交易日 KD死亡交叉（共${kdDeath.length}檔）：\n${fmtList(kdDeath)}`,
      `${marketLabel}【MACD與KD「兩種線都快黃金交叉」（尚未交叉、僅為推估）】兩者都符合各自「即將交叉」門檻者共${dualGolden.both.length}檔（使用者問「兩種線快線都快超過慢線」「MACD跟KD都快黃金交叉」就是這份；本站回測：這種同時即將交叉的訊號很少見，約每25檔每月出現1次，所以常常是0檔）。注意：${NEAR_CROSS_DISCLAIMER}。\n${fmtDual(dualGolden.both, "golden", "（掃描範圍內目前一檔都沒有同時符合，這是實際逐檔比對後的結果，直接告訴使用者目前沒有，不是沒有這個功能）")}\n最接近的幾檔（沒有同時符合門檻，但KD與MACD都還在黃金交叉前、差距都在縮小；依兩者較慢的推估天數由近到遠，最多${DUAL_CLOSEST_LIMIT}檔，天數≤${DUAL_CLOSEST_MAX_EST_DAYS}天；沒有同時符合時用這份當「最接近」回答，並明講它們還沒到門檻）：\n${fmtDual(dualGolden.closest, "golden", "（也沒有）")}`,
      `${marketLabel}【MACD與KD「兩種線都快死亡交叉」（尚未交叉、僅為推估）】兩者都符合各自「即將交叉」門檻者共${dualDeath.both.length}檔：\n${fmtDual(dualDeath.both, "death", "（掃描範圍內目前一檔都沒有同時符合）")}`,
      `${nearHeader("KD黃金交叉", kdNearGolden.length, `K值仍低於D值、差距在${KD_NEAR_CROSS_MAX_GAP}點內且連續${KD_NEAR_CROSS_CONVERGING_DAYS}天縮小、K值今天上升、照目前速度約${KD_NEAR_CROSS_MAX_EST_DAYS}個交易日內交叉`)}
${fmtNear(kdNearGolden, describeKdNearCross)}`,
      `${nearHeader("MACD黃金交叉", macdNearGolden.length, `DIF仍低於訊號線、柱狀體(DIF−訊號線)為負且連續${MACD_NEAR_CROSS_CONVERGING_DAYS}天往0收斂、照目前速度約${MACD_NEAR_CROSS_MAX_EST_DAYS}個交易日內歸零`)}
${fmtNear(macdNearGolden, describeMacdNearCross)}`,
      `${nearHeader("KD死亡交叉", kdNearDeath.length, `K值仍高於D值、差距在${KD_NEAR_CROSS_MAX_GAP}點內且連續${KD_NEAR_CROSS_CONVERGING_DAYS}天縮小、K值今天下降、照目前速度約${KD_NEAR_CROSS_MAX_EST_DAYS}個交易日內交叉`)}
${fmtNear(kdNearDeath, describeKdNearCross)}`,
      `${nearHeader("MACD死亡交叉", macdNearDeath.length, `DIF仍高於訊號線、柱狀體為正且連續${MACD_NEAR_CROSS_CONVERGING_DAYS}天往0收斂、照目前速度約${MACD_NEAR_CROSS_MAX_EST_DAYS}個交易日內歸零`)}
${fmtNear(macdNearDeath, describeMacdNearCross)}`,
      `${marketLabel}「均線多頭排列 且 RSI未過熱（RSI<70）」（共${bullishMaHealthyRsi.length}檔）：\n${fmtList(bullishMaHealthyRsi)}`,
      `${marketLabel}「均線多頭排列 且 MACD黃金交叉」（共${bullishMaMacdGolden.length}檔）：\n${fmtList(bullishMaMacdGolden)}`,
      `${marketLabel}「KD黃金交叉 且 RSI仍低（RSI≤40，尚未漲多）」（共${oversoldTurning.length}檔）：\n${fmtList(oversoldTurning)}`,
      `${marketLabel}技術指標明細表（最新交易日有發生任一交叉的全部列出，另補上成交金額最大的幾檔；使用者問到上面沒有預先列出的其他指標組合時，一律從這張表逐檔比對後回答，不要自己回想或推測）：\n${tableRows.map((i) => `- ${describeTechState(i)}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  const ratingsText = await describeBothGoldenRatings([...tw, ...us]).catch(() => "");
  const { conds, rated } = conditionsForQuestion(query.question ?? "", query.lastUserTurn);
  const conditionText =
    conds.length > 0
      ? await buildConditionGrounding(
          [
            { items: tw, label: "台股" },
            { items: us, label: "美股" },
          ],
          conds,
          rated
        ).catch(() => "")
      : "";
  return [conditionText, ratingsText, blockFor(tw, "台股", tw.length), blockFor(us, "美股", us.length)].filter(Boolean).join("\n\n");
}
