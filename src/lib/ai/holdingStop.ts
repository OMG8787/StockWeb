import { tickSize } from "./grounding/priceLevels";

/**
 * 持有中的出場／停損價（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 使用者回報：分析關注清單時，友達(2409) 現價 39.05 卻寫「跌破 32.65 建議停損」（−16%，
 * 隔天跌停約 35.15 根本到不了）、和益(1709) 64.3 寫跌破 42.5（−34%）。根因：持有中沿用 priceLevels.ts
 * 給「還沒買、準備在買進區間進場」的人用的出場價——那是買進區間下緣再往下的遠端支撐，不是持有者的停損。
 *
 * 持有中改用近端參考：MA10／MA20／近10日低之中「現價下方、離現價最近」的一個（至少低 HOLDING_STOP_MIN_GAP，
 * 避免貼著現價被盤中雜訊洗掉）；離現價超過 HOLDING_STOP_MAX_PCT 就改用現價下方 HOLDING_STOP_MAX_PCT；
 * 台股上市櫃另保證高於下一個交易日的跌停價（以現價當參考價 ×(1−TW_DAILY_LIMIT_PCT)），興櫃／美股沒有漲跌幅限制。
 */

/** 持有中出場價離現價最多這麼遠（8%）。 */
export const HOLDING_STOP_MAX_PCT = 0.08;
/** 出場價至少比現價低這麼多（1%），太貼近現價的均線不當出場價。 */
export const HOLDING_STOP_MIN_GAP_PCT = 0.01;
/** 台股上市櫃單日漲跌幅限制 10%。 */
export const TW_DAILY_LIMIT_PCT = 0.1;

export type HoldingStopKind = "stop-loss" | "trailing-profit" | "protect" | "unknown-cost";

export interface HoldingStop {
  price: number;
  /** 依據，例如「MA20」或「現價下方8%（最近支撐 32.65 離現價 16.4% 太遠）」 */
  label: string;
  /** 出場價在現價下方幾 %（正數） */
  pctBelow: number;
  /** 已虧損＝停損；出場價仍高於成本＝移動停利；目前獲利但出場價低於成本＝保本停損；沒給成本＝unknown-cost */
  kind: HoldingStopKind;
  /** 是否因為支撐太遠而改用上限 */
  capped: boolean;
  /** 台股上市櫃：下一個交易日的跌停價（以現價為參考價），興櫃／美股為 null */
  limitDown: number | null;
}

type CandleLike = { high: number; low: number; close: number };

function roundTick(v: number, market: "TW" | "US", mode: "floor" | "ceil"): number {
  const t = tickSize(v, market);
  const n = mode === "floor" ? Math.floor(v / t + 1e-9) : Math.ceil(v / t - 1e-9);
  return Number((n * t).toFixed(2));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function computeHoldingStop(input: {
  candles: CandleLike[];
  price: number;
  costBasis?: number | null;
  market: "TW" | "US";
  /** 興櫃（沒有漲跌幅限制） */
  emerging?: boolean;
}): HoldingStop | null {
  const { price, market } = input;
  if (!Number.isFinite(price) || price <= 0) return null;
  const valid = input.candles.filter((c) => c.close > 0 && c.low > 0);
  const closes = valid.map((c) => c.close);
  const ma = (n: number) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const raw: Array<{ price: number | null; label: string }> = [
    { price: ma(10), label: "MA10" },
    { price: ma(20), label: "MA20" },
    { price: valid.length >= 10 ? Math.min(...valid.slice(-10).map((c) => c.low)) : null, label: "近10日低" },
  ];
  const minGapPrice = price * (1 - HOLDING_STOP_MIN_GAP_PCT);
  const candidates = raw
    .filter((r): r is { price: number; label: string } => r.price != null && Number.isFinite(r.price))
    .map((r) => ({ price: roundTick(r.price, market, "floor"), label: r.label }))
    .filter((r) => r.price > 0 && r.price <= minGapPrice)
    .sort((a, b) => b.price - a.price);

  const limitDown = market === "TW" && !input.emerging ? roundTick(price * (1 - TW_DAILY_LIMIT_PCT), market, "ceil") : null;
  // 上限：現價下方 8%；台股另保證高於跌停價（8% 本來就比 10% 近，這裡是保險）。
  let floor = roundTick(price * (1 - HOLDING_STOP_MAX_PCT), market, "ceil");
  if (limitDown != null && floor <= limitDown) floor = roundTick(limitDown + tickSize(limitDown, market), market, "ceil");

  const nearest = candidates[0];
  let stopPrice: number;
  let label: string;
  let capped = false;
  if (nearest && nearest.price >= floor) {
    // 同一價位有好幾個依據時一起列出（例如 MA20 與近10日低重疊）。
    stopPrice = nearest.price;
    label = candidates.filter((c) => c.price === nearest.price).map((c) => c.label).join("、");
  } else {
    stopPrice = floor;
    capped = true;
    label = nearest
      ? `現價下方${HOLDING_STOP_MAX_PCT * 100}%（最近支撐 ${fmt(nearest.price)}（${nearest.label}）離現價 ${(((price - nearest.price) / price) * 100).toFixed(1)}% 太遠）`
      : `現價下方${HOLDING_STOP_MAX_PCT * 100}%（MA10／MA20／近10日低都不在現價下方合理距離內）`;
  }

  const cost = input.costBasis != null && input.costBasis > 0 ? input.costBasis : null;
  const kind: HoldingStopKind =
    cost == null ? "unknown-cost" : price < cost ? "stop-loss" : stopPrice >= cost ? "trailing-profit" : "protect";

  return { price: stopPrice, label, pctBelow: ((price - stopPrice) / price) * 100, kind, capped, limitDown };
}

/** 給 AI 的一段【持有中出場參考】（持有者的停損／停利價一律用這個）。 */
export const HOLDING_STOP_TITLE = "【持有中出場參考】";

export function describeHoldingStop(stop: HoldingStop, price: number, costBasis?: number | null): string {
  const cost = costBasis != null && costBasis > 0 ? costBasis : null;
  const pnlPct = cost ? ((price - cost) / cost) * 100 : null;
  const where = `${fmt(stop.price)}（${stop.label}，現價 ${fmt(price)} 下方 ${stop.pctBelow.toFixed(1)}%）`;
  const action =
    stop.kind === "trailing-profit"
      ? `目前獲利約 ${pnlPct!.toFixed(1)}%（成本 ${fmt(cost!)}），移動停利價 ${where}：收盤跌破就出場、守住獲利（這價位仍高於成本）`
      : stop.kind === "protect"
        ? `目前小賺約 ${pnlPct!.toFixed(1)}%（成本 ${fmt(cost!)}），停損價 ${where}：跌破代表獲利吐光並轉為小虧，建議出場`
        : stop.kind === "stop-loss"
          ? `目前虧損約 ${Math.abs(pnlPct!).toFixed(1)}%（成本 ${fmt(cost!)}），停損價 ${where}：收盤跌破就停損出場`
          : `持有中出場參考價 ${where}：收盤跌破就出場`;
  const limit = stop.limitDown != null ? `；高於下一個交易日跌停價約 ${fmt(stop.limitDown)}` : "";
  return `${HOLDING_STOP_TITLE}${action}（距現價最多 ${HOLDING_STOP_MAX_PCT * 100}%${limit}）。已持有者的停損／停利價一律用這個數字，不可用評等或【價位參考】裡『買進後跌破 X 出場』那個價（那是給還沒買、準備在買進區間進場的人）。`;
}
