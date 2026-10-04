import { fineIndustryOf } from "@/lib/fineIndustry";
import { getOilQuotes, type OilQuote } from "@/lib/data/commodities";

/**
 * 個股資料的「產業關鍵外部因子」區塊：某些產業的獲利主要被外部價格牽動（油價→航空燃油成本、
 * 塑化原料成本與產品售價），只看個股自己的技術／籌碼會漏掉最關鍵的變數。
 * 2026-10-04 使用者📝回報華航案例：AI 沒有考慮油價下跌。
 * askSystemCompose.ts 依標題 SECTOR_FACTORS_TITLE 判斷要不要帶 RULE_SECTOR_FACTORS，兩邊共用這個常數。
 */
export const SECTOR_FACTORS_TITLE = "產業關鍵外部因子";

interface OilSensitivity {
  pattern: RegExp;
  /** 油價對這個產業的「通常」影響方向，給模型當推論依據（因果一律用『通常／可能』） */
  effect: string;
  /** 油價近期「下跌」時，對這個產業通常偏利多還是利空（null＝方向不明確） */
  onOilDown: "偏利多" | "偏利空" | null;
}

const OIL_SENSITIVE: OilSensitivity[] = [
  { pattern: /航空/, effect: "燃油是航空公司最大成本之一：油價下跌通常降低成本、有利獲利；油價上漲則壓縮獲利", onOilDown: "偏利多" },
  { pattern: /油輪/, effect: "油價與油品運輸需求、運價常同向波動，影響方向需搭配運價判斷", onOilDown: null },
  { pattern: /塑化|石化|塑膠|化纖|合成橡膠|泛用塑膠/, effect: "原油是原料成本來源：油價下跌通常壓低產品售價與庫存價值（短期可能有庫存損失），但也降低原料成本，利差變化才是關鍵", onOilDown: null },
  { pattern: /油品|加油站|石油天然氣|工業用油/, effect: "營收與油價高度連動：油價上漲通常有利、下跌通常不利", onOilDown: "偏利空" },
];

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`;
}

function describeOil(o: OilQuote): string {
  return `${o.label} ${o.price}美元（${o.date}），近1日${fmtPct(o.change1dPct)}、近1週${fmtPct(o.change1wPct)}、近1個月${fmtPct(o.change1mPct)}`;
}

/** 近1週變動超過這個百分比才算「上漲／下跌」，否則視為持平（本站自訂門檻）。 */
const OIL_TREND_THRESHOLD_PCT = 1;

/**
 * 把「近期方向＋對這個產業的意義」先算好寫成一句話。2026-10-04 正式站實測：只給數字時，
 * 模型會只寫「高油價壓縮獲利」而忽略「近1週已經下跌」——使用者要的正是這個變化。
 */
function trendVerdict(oil: OilQuote[], hit: OilSensitivity): string {
  const w = oil.map((o) => o.change1wPct).filter((v): v is number => v != null);
  if (w.length === 0) return "";
  const avg = w.reduce((a, b) => a + b, 0) / w.length;
  const dir = avg <= -OIL_TREND_THRESHOLD_PCT ? "下跌" : avg >= OIL_TREND_THRESHOLD_PCT ? "上漲" : "持平";
  const meaning =
    dir === "持平" || hit.onOilDown == null
      ? ""
      : `，對這個產業通常${dir === "下跌" ? hit.onOilDown : hit.onOilDown === "偏利多" ? "偏利空" : "偏利多"}`;
  return `【結論】油價近1週${dir}（平均${avg >= 0 ? "+" : ""}${Math.round(avg * 100) / 100}%）${meaning}——回答時必須講出這個方向，不可只說油價高低。`;
}

/** 有對應產業因子時回傳一行文字，否則 undefined（一般股票不多抓任何資料）。 */
export async function describeSectorFactors(item: { symbol: string; market: "TW" | "US"; sector: string }): Promise<string | undefined> {
  const industry = fineIndustryOf(item);
  const hit = OIL_SENSITIVE.find((s) => s.pattern.test(industry));
  if (!hit) return undefined;
  const oil = await getOilQuotes().catch(() => [] as OilQuote[]);
  if (oil.length === 0) return `${SECTOR_FACTORS_TITLE}（油價）：這檔屬於「${industry}」，油價是關鍵外部因子，但這次油價資料暫時抓不到`;
  return `${SECTOR_FACTORS_TITLE}（油價，近即時期貨報價，判斷買賣時必須納入）：這檔屬於「${industry}」——${hit.effect}。${oil.map(describeOil).join("；")}。${trendVerdict(oil, hit)}`;
}
