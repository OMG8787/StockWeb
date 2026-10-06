import type { Signal } from "@/lib/signals";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT, SCORED_FACET_COUNT, type Facet } from "./actionScoring";
import { NEAR_ZONE_PCT, type PriceFramework } from "./grounding/priceLevels";
import { ACTIVE_CHASE_GUARDS, evaluateChaseGuards, type ChaseGuardHit, type ChaseGuardId, type ChaseMetrics } from "./chaseGuards";
import { stripNameMarker } from "./fuzzyName";
import { applyRatingConfirmation, type ConfirmState } from "./ratingStability";

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
 *     技術面【不支持】一票否決（VETO_FACETS，2026-10-05 擴大回測唯一穩健訊號）。
 *     急漲（surge）只附「短線波動風險」提示、不改結論（RISK_NOTE_ONLY_GUARDS，同一份回測）。
 *  2. 價位：現價下方沒有支撐（破底）→ 建議先不要買；其餘 → 建議買進（果斷二分，2026-10-05 起不再有「等回檔」）。
 *     有 RSI 超買／布林上緣這類漲多警訊、急漲，或現價高於支撐區上緣超過 NEAR_ZONE_PCT 時，結論仍是建議買進，
 *     只附「單一個」拉回加碼參考價（支撐區上緣）與短線風險，例如「建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）」。
 *  3. 持有中：買進→可分批加碼（現價偏高時續抱、拉回加碼）；不要買→破底出場、不支持≥2 減碼、其餘續抱不加碼。
 *  4. 大盤偏弱（加權 60 日報酬 < WEAK_MARKET_RET60_PCT）時，建議買進附弱市況提示，不改結論。
 *  5. 先不要買：不給買進區間、不給出場價，只給「什麼條件出現才會改判建議買進」（upgradeCondition）。
 */

/**
 * "buy-on-pullback"（等回檔）只為了讀舊的評等紀錄／學習資料而保留在型別裡：2026-10-05 起 computeSiteRating
 * 不再產生（見規則 2），新程式不要再依賴它。
 */
export type RatingCode = "buy" | "buy-on-pullback" | "avoid";
export type HoldingCode = "add" | "hold" | "reduce" | "exit";

export const RATING_LABEL: Record<RatingCode, string> = {
  buy: "建議買進",
  "buy-on-pullback": "建議等回檔再買（舊紀錄）",
  avoid: "建議先不要買",
};

export const HOLDING_LABEL: Record<HoldingCode, string> = {
  add: "可分批加碼",
  hold: "續抱",
  reduce: "建議減碼",
  exit: "建議出場",
};

/**
 * 一票否決的面向：這些面向是【不支持】就一律「建議先不要買」（不可為建議買進／等回檔），即使其他面向支持、
 * 不支持總數 ≤ QUALIFY_MAX_AGAINST。
 * 出處：擴大回測（docs/backtest/2026-10-wide-summary.md，198 檔×99 週、2024-10～2026-08、減同日同市值層級平均）——
 * 技術面「不支持」10 日 −0.37%、20 日 −0.65%，全期、後半期、大型與小型分層都可靠為負，是唯一穩健的訊號。
 */
export const VETO_FACETS = ["技術面"] as const;

/**
 * 只當「短線波動風險提示」、不改結論的追高防護。
 * 出處：同上擴大回測——追高組（5日>15% 或 RSI≥75）5 日 −0.23%（不顯著），但 20 日 +1.64%（t=1.90，
 * 上漲市況與後半期可靠為正）；60 檔小樣本「追高最差」沒有重現，所以急漲不再自動改成等回檔，
 * 改在理由附提示（評等紀錄的 chaseHits 仍記錄觸發，給學習循環用）。
 */
export const RISK_NOTE_ONLY_GUARDS: readonly ChaseGuardId[] = ["surge"];

/** 漲多警訊（跟 actionScoring.ts 的 OVERHEAT_PATTERNS 同義：不是買進理由）。 */
export const OVERHEAT_SIGNAL_PATTERNS = ["超買", "布林通道上緣"];

/**
 * 弱市況提示門檻：加權指數近 60 個交易日報酬 < 這個百分比＝大盤偏弱（＝報告的市況定義 A 的「弱」）。
 * 出處：docs/backtest/2026-10-regime.md（研究 C，commit 82c78bd）——技術面支持組在樣本外（2022-01～2024-09）弱市況
 * 10 日超額 −0.56%、20 日 −0.98%（t −3.92）可靠為負；本站「建議買進」弱市況方向為負但未達可靠標準，
 * 且 2025 年 V 型反彈時硬開關會整段錯過——所以只提示、不改結論。
 */
export const WEAK_MARKET_RET60_PCT = 5;

export function weakMarketNote(ret60Pct: number): string {
  const r = Math.round(ret60Pct * 10) / 10;
  return `大盤偏弱提示：近60日加權報酬 ${r > 0 ? "+" : ""}${r}%，歷史上此時技術強勢股常落後（之後 10～20 日平均落後同類股約 0.5～1%），宜降低部位或分批`;
}

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
  /** 加權指數近 60 個交易日報酬（%）；有給且 < WEAK_MARKET_RET60_PCT 時，建議買進附弱市況提示（不改結論） */
  marketRet60Pct?: number | null;
  /**
   * 翻轉確認（ratingStability.ts）：有給（含 prev＝null）就套「新結論要連續 2 個交易日才換」；
   * undefined＝不套（舊行為，回測比較用）。day＝這次評等的台北交易日。
   */
  confirm?: { prev: ConfirmState | null; day: string };
}

/** 內部用：翻轉確認期間，強制公布前一交易日的結論（不對外）。 */
interface ForcedResult {
  code: RatingCode;
  holdingCode: HoldingCode;
}

export interface SiteRating {
  code: RatingCode;
  /** 未持有的結論，例如「建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）」——三個入口一律照抄這串 */
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
  /** 觸發的追高防護（沒觸發是空陣列；只當風險提示的也記在這裡） */
  chaseHits: ChaseGuardHit[];
  /** 短線風險提示（急漲／漲多警訊／高於支撐區，不改結論）；沒有是 null */
  riskNote: string | null;
  /** 建議買進但現價偏高時的單一拉回加碼參考價；沒有是 null（舊快取沒有這欄） */
  pullbackAdd?: number | null;
  /** 弱市況提示（不改結論）；沒有是 null（舊快取沒有這欄） */
  marketNote?: string | null;
  /** 先不要買時，什麼條件出現才會改判建議買進（不給買進區間、不給出場價）；買進時 null */
  upgradeCondition?: string | null;
  /**
   * 今天的資料指向不同結論、但還在「連續 2 個交易日確認」期間（維持前一交易日結論）時的白話說明；
   * 沒有是 null（舊快取沒有這欄）。見 ratingStability.ts。
   */
  pendingChange?: string | null;
  /** 翻轉確認狀態（下一個交易日的評等要用；舊快取沒有這欄） */
  confirmState?: ConfirmState | null;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 本站綜合評等。有給 input.confirm 時套翻轉確認：今天算出的結論（raw）跟前一交易日公布的大類不同、且還沒連續 2 天，
 * 就維持前一交易日的結論（label／價位依今天的資料重組），並在 pendingChange／理由寫明「今天的變化、明天仍如此才改判」；
 * 破底（硬性風險）立即生效。
 */
export function computeSiteRating(input: RatingInput): SiteRating {
  const raw = computeRawSiteRating(input, null);
  if (!input.confirm) return raw;
  const brokeDown = !!input.framework && !input.framework.zone;
  const st = applyRatingConfirmation(input.confirm.prev, {
    code: raw.code,
    holdingCode: raw.holdingCode,
    hardRisk: brokeDown,
    day: input.confirm.day,
  });
  if (st.code === raw.code && st.holdingCode === raw.holdingCode) return { ...raw, pendingChange: null, confirmState: st };
  const held = computeRawSiteRating(input, { code: st.code, holdingCode: st.holdingCode });
  const parts = [
    (st.code === "buy") !== (raw.code === "buy") ? `未持有「${raw.label}」` : "",
    holdClassOf(st.holdingCode) !== holdClassOf(raw.holdingCode) ? `已持有「${raw.holdingLabel}」` : "",
  ].filter(Boolean);
  const pendingChange = `今天的資料指向${parts.join("、") || `「${raw.label}」`}（${raw.reason.split("；")[0]}），本站改判需連續 2 個交易日確認，下一個交易日仍如此才改判，今天維持前一交易日的結論`;
  return { ...held, reason: `${held.reason}；${pendingChange}`, pendingChange, confirmState: st };
}

function holdClassOf(h: HoldingCode): "keep" | "reduce" | "exit" {
  return h === "add" || h === "hold" ? "keep" : h;
}

function computeRawSiteRating(input: RatingInput, forced: ForcedResult | null): SiteRating {
  const { facets, supportCount, againstCount, signals, framework } = input;
  const chaseHits = input.chase ? evaluateChaseGuards(input.chase, input.guards ?? ACTIVE_CHASE_GUARDS) : [];
  const foreignSell = chaseHits.find((h) => h.id === "foreignSell");
  const heatHits = chaseHits.filter((h) => h.id !== "foreignSell" && !RISK_NOTE_ONLY_GUARDS.includes(h.id));
  const riskHits = chaseHits.filter((h) => RISK_NOTE_ONLY_GUARDS.includes(h.id));
  const vetoed = facets.filter((f) => f.verdict === "不支持" && VETO_FACETS.some((v) => f.name.startsWith(v)));
  const chipsAgainst = facets.some((f) => f.name === "籌碼面" && f.verdict === "不支持");
  const against = facets.filter((f) => f.verdict === "不支持").map((f) => f.name.replace(/（.*$/, ""));
  const support = facets.filter((f) => f.verdict === "支持").map((f) => f.name.replace(/（.*$/, ""));
  const qualifiedByData =
    supportCount >= QUALIFY_MIN_SUPPORT && againstCount <= QUALIFY_MAX_AGAINST && !chipsAgainst && !foreignSell && vetoed.length === 0;
  // 翻轉確認期間強制公布前一交易日的結論（computeSiteRating）；破底不會被強制（硬性風險立即生效）。
  const qualified = forced ? forced.code !== "avoid" : qualifiedByData;
  const overheat = signals.filter((s) => s.tone === "up" && OVERHEAT_SIGNAL_PATTERNS.some((p) => s.label.includes(p)));
  const zone = framework?.zone ? { low: framework.zone.low, high: framework.zone.high } : null;
  const noChase = framework?.noChase.price ?? null;
  const exit = framework?.exit?.price ?? null;
  const brokeDown = !!framework && !framework.zone;
  const score = `支持面向 ${supportCount}/${SCORED_FACET_COUNT}${support.length ? `（${support.join("、")}）` : ""}、不支持 ${againstCount} 項${against.length ? `（${against.join("、")}）` : ""}`;

  let code: RatingCode;
  let reason: string;
  /** 建議買進但現價偏高時，單一個拉回加碼參考價（支撐區上緣）；不是買進前提 */
  let pullbackAdd: number | null = null;
  const shortRisks: string[] = [];
  if (!qualified) {
    code = "avoid";
    reason = qualifiedByData
      ? `${score}，今天已達買進門檻，但前一交易日評等為建議先不要買`
      : vetoed.length > 0
      ? `${score}；${vetoed.map((f) => f.name.replace(/（.*$/, "")).join("、")}不支持（空方訊號多於多方），本站一票否決、不列為買進（擴大回測：技術面不支持的股票 10 日平均落後同類股約 0.4%）`
      : chipsAgainst
      ? `${score}；三大法人賣超（籌碼面不支持），本站不列為買進`
      : foreignSell && supportCount >= QUALIFY_MIN_SUPPORT && againstCount <= QUALIFY_MAX_AGAINST
        ? `${score}；但${foreignSell.message}，本站不列為買進`
        : `${score}，未達本站買進門檻（至少 ${QUALIFY_MIN_SUPPORT} 項支持、不支持最多 ${QUALIFY_MAX_AGAINST} 項）`;
    if (brokeDown) reason += "；且現價已跌破所有均線與近期低點";
  } else if (brokeDown && !forced) {
    code = "avoid";
    const trigger = framework!.resistances[0]?.price ?? framework!.noChase.price;
    reason = `${score}，但現價已跌破所有均線與近期低點（破底），要等重新站回 ${fmt(trigger)} 以上再考慮`;
  } else {
    // 2026-10-05 使用者：「每次都給購買區間，到了區間反而說不建議買、一直漲就一直觀望，該買的都沒買到——改掉優柔寡斷」。
    // 擴大回測：原本的「等回檔」組 10 日 +0.32%／20 日 +0.76%，點估計不比「建議買進」差（追高組 20 日 +1.64%），
    // 把體質過關的股票推到「現價不買」沒有證據支持。改為果斷二分：體質過關就是建議買進，
    // 現價偏高時只附「單一個」拉回加碼參考價與短線風險，不再寫「現價不買」。
    code = "buy";
    const extended =
      heatHits.length > 0 ||
      (!!zone && !!framework && (overheat.length > 0 || (framework.price - zone.high) / zone.high >= NEAR_ZONE_PCT));
    if (extended) {
      pullbackAdd = zone ? zone.high : null;
      shortRisks.push(
        ...heatHits.map((h) => h.message),
        ...(overheat.length > 0 ? [`技術面出現漲多警訊（${overheat.map((s) => s.label).join("、")}）`] : []),
        ...(zone && framework && framework.price > zone.high
          ? [`現價高於支撐區上緣 ${fmt(zone.high)} 約 ${fmt(Math.round(((framework.price - zone.high) / zone.high) * 1000) / 10)}%`]
          : [])
      );
    }
    const lead = qualifiedByData ? `${score}，體質達買進門檻` : `${score}，前一交易日評等為建議買進`;
    reason = !zone
      ? `${lead}（日K資料不足、未算出參考價位，宜小量分批）`
      : pullbackAdd != null && framework
        ? `${lead}，現價 ${fmt(framework.price)} 可分批買；若拉回到 ${fmt(pullbackAdd)} 附近可加碼`
        : `${lead}，且現價接近支撐區上緣 ${fmt(zone.high)}，可分批買進`;
  }

  // 急漲只附風險提示、不改結論（見 RISK_NOTE_ONLY_GUARDS）；結論是先不要買時不用再提示追價風險。
  if (code === "buy") shortRisks.push(...riskHits.map((h) => h.message));
  const riskNote = shortRisks.length > 0 ? `短線風險：${shortRisks.join("、")}，宜分批、不要一次買滿` : null;
  if (riskNote) reason += `；${riskNote}`;

  const label =
    code === "buy" && pullbackAdd != null && framework
      ? `${RATING_LABEL.buy}（現價 ${fmt(framework.price)} 可分批買；若拉回到 ${fmt(pullbackAdd)} 附近可加碼）`
      : RATING_LABEL[code];
  const holdingCode: HoldingCode = forced
    ? forced.holdingCode === "add" || forced.holdingCode === "hold"
      ? code === "buy" ? (pullbackAdd != null ? "hold" : "add") : "hold"
      : forced.holdingCode
    : code === "buy" ? (pullbackAdd != null ? "hold" : "add") : brokeDown ? "exit" : againstCount >= 2 ? "reduce" : "hold";
  const holdingLabel =
    code === "buy" && pullbackAdd != null
      ? `續抱（拉回到 ${fmt(pullbackAdd)} 附近可加碼）`
      : holdingCode === "hold" && code === "avoid"
        ? "續抱觀察、不加碼"
        : HOLDING_LABEL[holdingCode];

  // 弱市況提示（不改結論）：見 WEAK_MARKET_RET60_PCT。
  const marketNote =
    code === "buy" && input.marketRet60Pct != null && input.marketRet60Pct < WEAK_MARKET_RET60_PCT
      ? weakMarketNote(input.marketRet60Pct)
      : null;
  if (marketNote) reason += `；${marketNote}`;

  const upgradeCondition =
    code === "avoid"
      ? [
          qualifiedByData && forced ? "下一個交易日仍達買進門檻（本站改判需連續 2 個交易日確認）" : "",
          brokeDown ? `重新站回 ${fmt(framework!.resistances[0]?.price ?? framework!.noChase.price)} 以上` : "",
          vetoed.length > 0 ? "技術面轉為支持（例如站回 20 日均線、空方訊號消失）" : "",
          chipsAgainst || foreignSell ? "三大法人轉為買超" : "",
          supportCount < QUALIFY_MIN_SUPPORT ? `支持面向增加到至少 ${QUALIFY_MIN_SUPPORT} 項` : "",
          againstCount > QUALIFY_MAX_AGAINST ? `不支持面向減少到 ${QUALIFY_MAX_AGAINST} 項以內` : "",
        ]
          .filter(Boolean)
          .join("且") || "評等條件轉好"
      : null;

  return {
    code,
    label,
    holdingCode,
    holdingLabel,
    reason,
    supportCount,
    againstCount,
    zone,
    noChase,
    exit,
    chaseHits,
    riskNote,
    pullbackAdd,
    marketNote,
    upgradeCondition,
  };
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
    message: `買進後曾漲到約 ${fmt(peakPrice)}（獲利約 ${Math.round(peakGainPct * 10) / 10}%），現價 ${fmt(price)} 已跌回成本 ${fmt(costBasis)} 以下、由賺轉賠，依停利紀律建議減碼（買進日未知，最高價以日K中第一次成交到購買價格之後的最高價近似）`,
  };
}

/**
 * 依使用者的購買價格調整「已持有」結論（評等本身是全站共用快取、不含個人成本，所以另外套）。
 * 觸發停利提示時：原本是「出場」維持出場，其他一律改成「建議減碼」。
 *
 * 2026-10-06 使用者回報：AI 把程式的持有建議寫成「建議停損／全部賣出」「減碼或出場」，虧損中的股票寫「獲利已吐回」。
 * 結論字樣只給「一個」動作（不再是「減碼或出場」二選一），括號只講事實（曾獲利多少、現在已跌回成本以下），
 * 不寫「獲利已吐回」（觸發時現價一定 ≤ 成本＝虧損中，使用者讀起來像還有獲利）。
 */
export function takeProfitHoldingLabel(check: TakeProfitCheck): string {
  return `${HOLDING_LABEL.reduce}（買進後曾獲利約 ${Math.round(check.peakGainPct)}%，現已跌回成本以下）`;
}

export function applyHoldingCost(r: SiteRating, check: TakeProfitCheck | null): SiteRating {
  if (!check || r.holdingCode === "exit") return r;
  return { ...r, holdingCode: "reduce", holdingLabel: takeProfitHoldingLabel(check), reason: `${r.reason}；持有中：${check.message}` };
}

/** 是否應列進今日建議／全市場推薦名單（建議買進；舊快取的等回檔也算，過渡用）。 */
export function isRecommendable(r: SiteRating): boolean {
  return r.code === "buy" || r.code === "buy-on-pullback";
}

export const SITE_RATING_TITLE = "【本站綜合評等】";

export type RatingConfidence = "高" | "中" | "低";

/** 把握程度「高」需要公布的建議買進已連續這麼多個交易日（含今天）。 */
export const CONFIDENCE_HIGH_MIN_STREAK = 3;
/** 剛轉為建議買進（連續 ≤ 這個天數）且大盤偏弱 → 把握程度低。 */
export const CONFIDENCE_LOW_MAX_STREAK = 2;
export const CONFIDENCE_ORDER: Record<RatingConfidence, number> = { 高: 0, 中: 1, 低: 2 };

/**
 * 本站把握程度（只給「建議買進」；程式判定、AI 照抄不可改）。2026-10-06 使用者：「建議及問答的部分，都優先顯示把握程度最高的」，
 * 13:28 回報：問「有把握程度高的推薦嗎」AI 卻寫「把握程度中」。
 * 規則（docs/backtest/2026-10-stability.md「把握程度」節，198＋194 檔每日評等，樣本內外 10／20 日超額都單調：高＞中＞低）：
 * - 高：大盤不偏弱（沒有弱市況提示）且建議買進已連續 ≥ CONFIDENCE_HIGH_MIN_STREAK 個交易日
 * - 低：大盤偏弱且剛轉為建議買進（連續 ≤ CONFIDENCE_LOW_MAX_STREAK 天）
 * - 中：其餘
 * 連續天數來自翻轉確認狀態（confirmState.streak）；沒有狀態（例如沒有 Redis）當作剛轉買（1 天）。
 */
export function ratingConfidence(r: SiteRating): { level: RatingConfidence; why: string } | null {
  if (r.code !== "buy") return null;
  const streak = r.confirmState?.streak ?? 1;
  const weak = !!r.marketNote;
  const days = `已連續 ${streak} 個交易日建議買進`;
  if (!weak && streak >= CONFIDENCE_HIGH_MIN_STREAK) return { level: "高", why: `大盤不偏弱、${days}` };
  if (weak && streak <= CONFIDENCE_LOW_MAX_STREAK) return { level: "低", why: `大盤偏弱、${streak <= 1 ? "今天剛轉為建議買進" : days}` };
  return { level: "中", why: `${weak ? "大盤偏弱" : "大盤不偏弱"}、${streak <= 1 ? "今天剛轉為建議買進" : days}` };
}

/** 依把握程度排序用（高→中→低→沒有把握程度）；同級維持原順序。 */
export function confidenceRank(r: SiteRating): number {
  const c = ratingConfidence(r);
  return c ? CONFIDENCE_ORDER[c.level] : 3;
}

/** 程式字樣「本站把握程度：高（…）」，名單與 AI 參考資料共用。 */
export function confidenceText(r: SiteRating): string {
  const c = ratingConfidence(r);
  return c ? `本站把握程度：${c.level}（${c.why}；回測：高＞中＞低，非勝率保證）` : "";
}

export const CONFIDENCE_GRADES_TITLE = "【本站把握程度分級（程式算好；使用者問把握程度高的，只能照這份回答）】";

/**
 * 「把握程度高的有哪些」由程式分級回答（2026-10-06 13:28 使用者回報：問高把握卻被答「把握中」）。
 * 只列建議買進；沒有「高」就照實寫（無），AI 必須照實說目前沒有程式判定為高把握的。
 */
export function describeConfidenceGrades(entries: Array<{ name: string; symbol: string; rating: SiteRating }>): string {
  const by: Record<RatingConfidence, string[]> = { 高: [], 中: [], 低: [] };
  for (const e of entries) {
    const c = ratingConfidence(e.rating);
    if (c) by[c.level].push(`${stripNameMarker(e.name)}(${e.symbol})（${c.why}）`);
  }
  const line = (lv: RatingConfidence) => `${lv}：${by[lv].length ? by[lv].join("、") : "（無）"}`;
  return `${CONFIDENCE_GRADES_TITLE}${line("高")}；${line("中")}；${line("低")}。`;
}

/** 給 AI 的一行評等（個股資料最上面、全市場名單每檔都用同一格式）。 */
export function describeSiteRating(name: string, symbol: string, r: SiteRating): string {
  // 2026-10-05：先不要買時不給任何價位（AI 曾把觀察用支撐 134.5 寫成「買進後跌破 134.5 出場」），只給改判條件；
  // 建議買進不給「高於 X 不追價」（跟「現價可買」矛盾），只給單一拉回加碼參考價與買進後出場價。
  const levels =
    r.code === "avoid"
      ? []
      : [
          r.pullbackAdd != null ? `拉回加碼參考價 ${fmt(r.pullbackAdd)}` : r.zone ? `支撐區 ${fmt(r.zone.low)}～${fmt(r.zone.high)}` : "",
          r.exit != null ? `買進後跌破 ${fmt(r.exit)} 出場` : "",
        ].filter(Boolean);
  const tail =
    r.code === "avoid"
      ? `改判建議買進的條件：${r.upgradeCondition ?? "評等條件轉好"}（先不要買時不提任何買進或出場價位）。`
      : levels.length > 0
        ? `價位：${levels.join("；")}。`
        : "";
  const conf = confidenceText(r);
  return `${SITE_RATING_TITLE}${stripNameMarker(name)}(${symbol})：未持有：「${r.label}」／已持有：「${r.holdingLabel}」。理由：${r.reason}。${tail}${conf ? `${conf}。` : ""}`;
}

/** 模型偶爾把評等標籤原樣抄出（「未持有：「建議買進」」），回答送出前拿掉標籤、只留字樣。 */
export function stripRatingTags(answer: string): string {
  return answer
    .replace(/(未持有|已持有)[：:]\s*「([^」]*)」/g, "$2")
    .replace(/^(\s*(?:[-•]\s*)?)(未持有|已持有)[：:]\s*/gm, "$1");
}
