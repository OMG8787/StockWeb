import type { Signal } from "@/lib/signals";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT, SCORED_FACET_COUNT, type Facet } from "./actionScoring";
import { NEAR_ZONE_PCT, type PriceFramework } from "./grounding/priceLevels";

/**
 * 本站綜合評等（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 使用者回報：AI 問答說健鼎「建議買入」，到個股頁按「問AI關於」又說「暫緩觀望」；
 * 今日建議、全市場推薦、個股分析三條路徑各自讓模型自由判斷買不買，結論每次都可能不同。
 * 比照 priceLevels.ts／sectorFactors.ts「程式先算好結論、AI 照用」：買不買只由這裡決定，
 * 三個入口（今日建議、AI 問答全市場推薦、個股問答）都讀同一份（stockRating.ts 快取 10 分鐘）。
 *
 * 規則：
 *  1. 體質門檻（跟今日建議原本的門檻同一組常數）：支持面向 ≥ QUALIFY_MIN_SUPPORT、
 *     不支持 ≤ QUALIFY_MAX_AGAINST，且籌碼面不是【不支持】（法人賣超）——沒過 → 建議先不要買。
 *  2. 價位：現價下方沒有支撐（破底）→ 建議先不要買；有 RSI 超買／布林上緣這類漲多警訊，
 *     或現價高於買進區間上緣超過 NEAR_ZONE_PCT → 建議等回檔再買（附區間）；否則 → 建議買進。
 *  3. 持有中：買進→可分批加碼；等回檔→續抱；不要買→破底出場、不支持≥2 減碼、其餘續抱不加碼。
 */

export type RatingCode = "buy" | "buy-on-pullback" | "avoid";
export type HoldingCode = "add" | "hold" | "reduce" | "exit";

export const RATING_LABEL: Record<RatingCode, string> = {
  buy: "建議買進",
  "buy-on-pullback": "建議等回檔再買",
  avoid: "建議先不要買",
};

export const HOLDING_LABEL: Record<HoldingCode, string> = {
  add: "可分批加碼",
  hold: "續抱",
  reduce: "建議減碼",
  exit: "建議出場",
};

/** 漲多警訊（跟 actionScoring.ts 的 OVERHEAT_PATTERNS 同義：不是買進理由）。 */
export const OVERHEAT_SIGNAL_PATTERNS = ["超買", "布林通道上緣"];

export interface RatingInput {
  facets: Facet[];
  supportCount: number;
  againstCount: number;
  /** 技術訊號（用來判斷漲多警訊） */
  signals: Signal[];
  framework: PriceFramework | null;
}

export interface SiteRating {
  code: RatingCode;
  /** 未持有的結論，例如「建議等回檔再買（區間 120～125）」——三個入口一律照抄這串 */
  label: string;
  holdingCode: HoldingCode;
  /** 持有中的結論，例如「續抱」 */
  holdingLabel: string;
  /** 一句理由摘要（程式組好、AI 解釋時以這個為準） */
  reason: string;
  supportCount: number;
  againstCount: number;
  zone: { low: number; high: number } | null;
  noChase: number | null;
  exit: number | null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function computeSiteRating(input: RatingInput): SiteRating {
  const { facets, supportCount, againstCount, signals, framework } = input;
  const chipsAgainst = facets.some((f) => f.name === "籌碼面" && f.verdict === "不支持");
  const against = facets.filter((f) => f.verdict === "不支持").map((f) => f.name.replace(/（.*$/, ""));
  const support = facets.filter((f) => f.verdict === "支持").map((f) => f.name.replace(/（.*$/, ""));
  const qualified = supportCount >= QUALIFY_MIN_SUPPORT && againstCount <= QUALIFY_MAX_AGAINST && !chipsAgainst;
  const overheat = signals.filter((s) => s.tone === "up" && OVERHEAT_SIGNAL_PATTERNS.some((p) => s.label.includes(p)));
  const zone = framework?.zone ? { low: framework.zone.low, high: framework.zone.high } : null;
  const noChase = framework?.noChase.price ?? null;
  const exit = framework?.exit?.price ?? null;
  const brokeDown = !!framework && !framework.zone;
  const score = `支持面向 ${supportCount}/${SCORED_FACET_COUNT}${support.length ? `（${support.join("、")}）` : ""}、不支持 ${againstCount} 項${against.length ? `（${against.join("、")}）` : ""}`;

  let code: RatingCode;
  let reason: string;
  if (!qualified) {
    code = "avoid";
    reason = chipsAgainst
      ? `${score}；三大法人賣超（籌碼面不支持），本站不列為買進`
      : `${score}，未達本站買進門檻（至少 ${QUALIFY_MIN_SUPPORT} 項支持、不支持最多 ${QUALIFY_MAX_AGAINST} 項）`;
    if (brokeDown) reason += "；且現價已跌破所有均線與近期低點";
  } else if (brokeDown) {
    code = "avoid";
    const trigger = framework!.resistances[0]?.price ?? framework!.noChase.price;
    reason = `${score}，但現價已跌破所有均線與近期低點（破底），要等重新站回 ${fmt(trigger)} 以上再考慮`;
  } else if (zone && framework && (overheat.length > 0 || (framework.price - zone.high) / zone.high >= NEAR_ZONE_PCT)) {
    code = "buy-on-pullback";
    const why = [
      overheat.length > 0 ? `技術面出現漲多警訊（${overheat.map((s) => s.label).join("、")}）` : "",
      `現價 ${fmt(framework.price)} 高於買進區間上緣 ${fmt(zone.high)}`,
    ]
      .filter(Boolean)
      .join("、");
    reason = `${score}，體質達買進門檻；但${why}，不追價，等回檔到 ${fmt(zone.low)}～${fmt(zone.high)} 再分批買`;
  } else {
    code = "buy";
    reason = zone
      ? `${score}，體質達買進門檻，且現價已接近買進區間上緣 ${fmt(zone.high)}，可分批買進`
      : `${score}，體質達買進門檻（日K資料不足、未算出買進區間，宜小量分批）`;
  }

  const label =
    code === "buy-on-pullback" && zone ? `${RATING_LABEL[code]}（區間 ${fmt(zone.low)}～${fmt(zone.high)}）` : RATING_LABEL[code];
  const holdingCode: HoldingCode =
    code === "buy" ? "add" : code === "buy-on-pullback" ? "hold" : brokeDown ? "exit" : againstCount >= 2 ? "reduce" : "hold";
  const holdingLabel = holdingCode === "hold" && code === "avoid" ? "續抱觀察、不加碼" : HOLDING_LABEL[holdingCode];

  return { code, label, holdingCode, holdingLabel, reason, supportCount, againstCount, zone, noChase, exit };
}

/** 是否應列進今日建議／全市場推薦名單（買進或等回檔）。 */
export function isRecommendable(r: SiteRating): boolean {
  return r.code === "buy" || r.code === "buy-on-pullback";
}

export const SITE_RATING_TITLE = "【本站綜合評等】";

/** 給 AI 的一行評等（個股資料最上面、全市場名單每檔都用同一格式）。 */
export function describeSiteRating(name: string, symbol: string, r: SiteRating): string {
  const levels = [
    r.zone ? `買進區間 ${fmt(r.zone.low)}～${fmt(r.zone.high)}` : "",
    r.noChase != null ? `高於 ${fmt(r.noChase)} 不追價` : "",
    r.exit != null ? `買進後跌破 ${fmt(r.exit)} 出場` : "",
  ].filter(Boolean);
  return `${SITE_RATING_TITLE}${name}(${symbol})：未持有：「${r.label}」／已持有：「${r.holdingLabel}」。理由：${r.reason}。${
    levels.length > 0 ? `價位：${levels.join("；")}。` : ""
  }`;
}
