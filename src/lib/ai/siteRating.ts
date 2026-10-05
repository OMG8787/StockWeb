import type { Signal } from "@/lib/signals";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT, SCORED_FACET_COUNT, type Facet } from "./actionScoring";
import { NEAR_ZONE_PCT, type PriceFramework } from "./grounding/priceLevels";
import { ACTIVE_CHASE_GUARDS, evaluateChaseGuards, type ChaseGuardHit, type ChaseGuardId, type ChaseMetrics } from "./chaseGuards";

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
  /** 追高指標（chaseGuards.ts）；沒給就不套追高防護（例如回測工具算「舊版基準」時） */
  chase?: ChaseMetrics | null;
  /** 要套用哪些追高防護，預設 ACTIVE_CHASE_GUARDS（回測工具逐條比較時才會指定） */
  guards?: readonly ChaseGuardId[];
}

export interface SiteRating {
  code: RatingCode;
  /** 未持有的結論，例如「建議等回檔再買（現價不買，等回到 120～125）」——三個入口一律照抄這串 */
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
  /** 觸發的追高防護（沒觸發是空陣列） */
  chaseHits: ChaseGuardHit[];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function computeSiteRating(input: RatingInput): SiteRating {
  const { facets, supportCount, againstCount, signals, framework } = input;
  const chaseHits = input.chase ? evaluateChaseGuards(input.chase, input.guards ?? ACTIVE_CHASE_GUARDS) : [];
  const foreignSell = chaseHits.find((h) => h.id === "foreignSell");
  const heatHits = chaseHits.filter((h) => h.id !== "foreignSell");
  const chipsAgainst = facets.some((f) => f.name === "籌碼面" && f.verdict === "不支持");
  const against = facets.filter((f) => f.verdict === "不支持").map((f) => f.name.replace(/（.*$/, ""));
  const support = facets.filter((f) => f.verdict === "支持").map((f) => f.name.replace(/（.*$/, ""));
  const qualified = supportCount >= QUALIFY_MIN_SUPPORT && againstCount <= QUALIFY_MAX_AGAINST && !chipsAgainst && !foreignSell;
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
      : foreignSell && supportCount >= QUALIFY_MIN_SUPPORT && againstCount <= QUALIFY_MAX_AGAINST
        ? `${score}；但${foreignSell.message}，本站不列為買進`
        : `${score}，未達本站買進門檻（至少 ${QUALIFY_MIN_SUPPORT} 項支持、不支持最多 ${QUALIFY_MAX_AGAINST} 項）`;
    if (brokeDown) reason += "；且現價已跌破所有均線與近期低點";
  } else if (brokeDown) {
    code = "avoid";
    const trigger = framework!.resistances[0]?.price ?? framework!.noChase.price;
    reason = `${score}，但現價已跌破所有均線與近期低點（破底），要等重新站回 ${fmt(trigger)} 以上再考慮`;
  } else if (
    heatHits.length > 0 ||
    (zone && framework && (overheat.length > 0 || (framework.price - zone.high) / zone.high >= NEAR_ZONE_PCT))
  ) {
    code = "buy-on-pullback";
    const why = [
      heatHits.length > 0 ? `已經急漲／過熱（${heatHits.map((h) => h.message).join("、")}）` : "",
      overheat.length > 0 ? `技術面出現漲多警訊（${overheat.map((s) => s.label).join("、")}）` : "",
      zone && framework && framework.price > zone.high ? `現價 ${fmt(framework.price)} 高於買進區間上緣 ${fmt(zone.high)}` : "",
    ]
      .filter(Boolean)
      .join("、");
    reason = zone
      ? `${score}，體質達買進門檻；但${why}，現價不買，等回檔到 ${fmt(zone.low)}～${fmt(zone.high)} 再分批買`
      : `${score}，體質達買進門檻；但${why}，現價不買，等回檔整理後再評估`;
  } else {
    code = "buy";
    reason = zone
      ? `${score}，體質達買進門檻，且現價已接近買進區間上緣 ${fmt(zone.high)}，可分批買進`
      : `${score}，體質達買進門檻（日K資料不足、未算出買進區間，宜小量分批）`;
  }

  const label =
    code === "buy-on-pullback"
      ? zone
        ? `${RATING_LABEL[code]}（現價不買，等回到 ${fmt(zone.low)}～${fmt(zone.high)}）`
        : `${RATING_LABEL[code]}（現價不買）`
      : RATING_LABEL[code];
  const holdingCode: HoldingCode =
    code === "buy" ? "add" : code === "buy-on-pullback" ? "hold" : brokeDown ? "exit" : againstCount >= 2 ? "reduce" : "hold";
  const holdingLabel = holdingCode === "hold" && code === "avoid" ? "續抱觀察、不加碼" : HOLDING_LABEL[holdingCode];

  return { code, label, holdingCode, holdingLabel, reason, supportCount, againstCount, zone, noChase, exit, chaseHits };
}

// ── 持有中停利提示（2026-10-05 檢討：使用者持股曾經獲利、沒有停利紀律又跌回成本） ──
// 沒回測（需要真實買進日與成本，歷史樣本做不出來），先當紀律提示；之後用評等紀錄（ratingLog）追蹤效果。

/** 持有期間曾經獲利達到這個百分比… */
export const TAKE_PROFIT_PEAK_GAIN_PCT = 8;
/** …之後現價跌回「成本 ×（1 + 這個百分比）」以下，就提示減碼或出場（0＝跌回成本）。 */
export const TAKE_PROFIT_GIVEBACK_FLOOR_PCT = 0;

export interface TakeProfitCheck {
  /** 買進後（近似）最高價相對成本的最大獲利（%） */
  peakGainPct: number;
  peakPrice: number;
  /** 一句話提示（含「近似」說明） */
  message: string;
}

/**
 * 持有中是否觸發「曾獲利 ≥8% 後跌回成本」。買進日不知道（關注清單只有購買價格），
 * 近似做法：日K中「第一根成交區間涵蓋購買價格」的那天當買進日，取那天之後（含今天現價）的最高價；
 * 日K裡從沒成交到購買價格（買在更早以前）就從日K第一根開始算。
 */
export function checkTakeProfit(
  costBasis: number,
  candles: Array<{ high: number; low: number }>,
  price: number
): TakeProfitCheck | null {
  if (!(costBasis > 0) || candles.length === 0) return null;
  const start = Math.max(0, candles.findIndex((c) => c.low <= costBasis && costBasis <= c.high));
  const peakPrice = Math.max(price, ...candles.slice(start).map((c) => c.high));
  const peakGainPct = (peakPrice / costBasis - 1) * 100;
  const floor = costBasis * (1 + TAKE_PROFIT_GIVEBACK_FLOOR_PCT / 100);
  if (peakGainPct < TAKE_PROFIT_PEAK_GAIN_PCT || price > floor) return null;
  return {
    peakGainPct,
    peakPrice,
    message: `買進後曾漲到約 ${fmt(peakPrice)}（獲利約 ${Math.round(peakGainPct * 10) / 10}%），現價 ${fmt(price)} 已跌回成本 ${fmt(costBasis)} 以下，獲利全部吐回，建議減碼或出場（停利紀律；買進日未知，最高價以日K中第一次成交到購買價格之後的最高價近似）`,
  };
}

/**
 * 依使用者的購買價格調整「已持有」結論（評等本身是全站共用快取、不含個人成本，所以另外套）。
 * 觸發停利提示時：原本是「出場」維持出場，其他一律改成「建議減碼或出場」。
 */
export function applyHoldingCost(r: SiteRating, check: TakeProfitCheck | null): SiteRating {
  if (!check || r.holdingCode === "exit") return r;
  return { ...r, holdingCode: "reduce", holdingLabel: "建議減碼或出場（獲利已吐回）", reason: `${r.reason}；持有中：${check.message}` };
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

/** 模型偶爾把評等標籤原樣抄出（「未持有：「建議買進」」），回答送出前拿掉標籤、只留字樣。 */
export function stripRatingTags(answer: string): string {
  return answer
    .replace(/(未持有|已持有)[：:]\s*「([^」]*)」/g, "$2")
    .replace(/^(\s*(?:[-•]\s*)?)(未持有|已持有)[：:]\s*/gm, "$1");
}
