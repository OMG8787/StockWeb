/**
 * 個股資料的「價位參考」區塊：由程式從日K算好支撐／壓力與一組自洽的建議框架（純邏輯、無 I/O）。
 *
 * 2026-10-05 正式站：旺矽（6223）現價 5420，AI 給「5000～5300 買進、跌破 5030 出場」（出場價落在區間內），
 * 另一次「5000～5100、跌破 5000 出場」（等於下緣），還兩次都寫「現價已在區間內」（實際不在）。
 * RULE_PRICE_LEVEL_CONSISTENCY 早就要求三者自洽，但模型照樣自己編數字——比照 sectorFactors.ts
 * 「程式先算好結論」的做法，大小關係由這裡保證，提示詞只要求「照抄這組數字」。
 *
 * 保證的不變量（有測試）：買進區間下緣 < 上緣 < 現價；出場價 ≤ 區間下緣 ×(1−EXIT_MIN_GAP)；不追價 > 現價。
 * askSystemCompose.ts 依標題 PRICE_LEVELS_TITLE 判斷要不要帶 RULE_USE_PRICE_FRAMEWORK。
 */
export const PRICE_LEVELS_TITLE = "價位參考（";

/** 兩個價位相差小於這個比例就合併成同一個（例如 MA10 與近20日低幾乎重疊）。 */
export const LEVEL_MERGE_PCT = 0.005;
/** 出場價至少要比區間下緣低這麼多（1%）。 */
export const EXIT_MIN_GAP = 0.01;
/** 只有1個下方支撐時，區間下緣＝支撐再往下這個比例。 */
export const SINGLE_SUPPORT_ZONE_DEPTH = 0.03;
/** 找不到更低的支撐時，出場價＝區間下緣再往下這個比例。 */
export const FALLBACK_EXIT_DEPTH = 0.03;
/** 上方第1個壓力離現價超過這個比例時，不追價改用現價＋NO_CHASE_FALLBACK_PCT（太遠的壓力當不追價沒意義）。 */
export const NO_CHASE_MAX_PCT = 0.05;
export const NO_CHASE_FALLBACK_PCT = 0.03;
/** 現價高於區間上緣不到這個比例時，提示「已接近上緣」。 */
export const NEAR_ZONE_PCT = 0.01;
/** 日K少於這個數量就不算（MA20 都算不出來）。 */
export const MIN_CANDLES = 20;

export interface PriceLevel {
  price: number;
  labels: string[];
}

export interface PriceFramework {
  price: number;
  supports: PriceLevel[]; // 現價下方，由近到遠
  resistances: PriceLevel[]; // 現價上方，由近到遠
  /** null＝現價下方沒有任何支撐（破底），不給買進區間 */
  zone: { low: number; high: number; lowLabel: string; highLabel: string } | null;
  exit: { price: number; label: string } | null;
  noChase: { price: number; label: string };
}

type CandleLike = { high: number; low: number; close: number };

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 台股升降單位；美股 0.01。 */
export function tickSize(price: number, market: "TW" | "US"): number {
  if (market === "US") return 0.01;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

function roundTick(v: number, market: "TW" | "US", mode: "floor" | "ceil"): number {
  const t = tickSize(v, market);
  const n = mode === "floor" ? Math.floor(v / t + 1e-9) : Math.ceil(v / t - 1e-9);
  return Number((n * t).toFixed(2));
}

/** 均線／近期高低點 → 原始價位清單（未排序、未合併）。 */
function rawLevels(candles: CandleLike[]): PriceLevel[] {
  const closes = candles.map((c) => c.close);
  const out: PriceLevel[] = [];
  const ma = (n: number) => (closes.length >= n ? avg(closes.slice(-n)) : null);
  for (const n of [5, 10, 20, 60]) {
    const v = ma(n);
    if (v != null) out.push({ price: v, labels: [`MA${n}`] });
  }
  const last20 = candles.slice(-20);
  out.push({ price: Math.max(...last20.map((c) => c.high)), labels: ["近20日高"] });
  out.push({ price: Math.min(...last20.map((c) => c.low)), labels: ["近20日低"] });
  if (candles.length >= 60) {
    const last60 = candles.slice(-60);
    out.push({ price: Math.max(...last60.map((c) => c.high)), labels: ["近60日高"] });
    out.push({ price: Math.min(...last60.map((c) => c.low)), labels: ["近60日低"] });
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

/** 依離現價由近到遠排序，相差 < LEVEL_MERGE_PCT 的合併（價位取較靠近現價者）。 */
function sortAndMerge(levels: PriceLevel[], price: number): PriceLevel[] {
  const sorted = [...levels].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  const merged: PriceLevel[] = [];
  for (const l of sorted) {
    const hit = merged.find((m) => Math.abs(m.price - l.price) / m.price < LEVEL_MERGE_PCT);
    if (hit) hit.labels.push(...l.labels);
    else merged.push({ price: l.price, labels: [...l.labels] });
  }
  return merged;
}

/**
 * 算支撐／壓力與建議框架。candles＝日K（舊→新），資料不足回 null。
 * 數字已調整到升降單位：支撐往下取、壓力往上取，調整後仍保證上面寫的大小關係。
 */
export function computePriceFramework(candles: CandleLike[], price: number, market: "TW" | "US"): PriceFramework | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const valid = candles.filter((c) => c.close > 0 && c.high > 0 && c.low > 0);
  if (valid.length < MIN_CANDLES) return null;

  // 先調整到升降單位再分邊，避免「捨入後跑到現價另一側」。
  const levels = rawLevels(valid).map((l) => ({
    labels: l.labels,
    price: l.price < price ? roundTick(l.price, market, "floor") : roundTick(l.price, market, "ceil"),
  }));
  const supports = sortAndMerge(levels.filter((l) => l.price < price), price);
  const resistances = sortAndMerge(levels.filter((l) => l.price > price), price);

  let zone: PriceFramework["zone"] = null;
  if (supports.length >= 2) {
    zone = { high: supports[0].price, highLabel: supports[0].labels.join("、"), low: supports[1].price, lowLabel: supports[1].labels.join("、") };
  } else if (supports.length === 1) {
    const low = roundTick(supports[0].price * (1 - SINGLE_SUPPORT_ZONE_DEPTH), market, "floor");
    zone = { high: supports[0].price, highLabel: supports[0].labels.join("、"), low, lowLabel: `${supports[0].labels.join("、")}下方${SINGLE_SUPPORT_ZONE_DEPTH * 100}%` };
  }

  let exit: PriceFramework["exit"] = null;
  if (zone) {
    const maxExit = zone.low * (1 - EXIT_MIN_GAP);
    const next = supports.find((s) => s.price <= maxExit);
    exit = next
      ? { price: next.price, label: next.labels.join("、") }
      : { price: roundTick(zone.low * (1 - FALLBACK_EXIT_DEPTH), market, "floor"), label: `區間下緣下方${FALLBACK_EXIT_DEPTH * 100}%` };
  }

  const r1 = resistances[0];
  const noChase =
    r1 && r1.price <= price * (1 + NO_CHASE_MAX_PCT)
      ? { price: r1.price, label: r1.labels.join("、") }
      : { price: roundTick(price * (1 + NO_CHASE_FALLBACK_PCT), market, "ceil"), label: `現價+${NO_CHASE_FALLBACK_PCT * 100}%` };

  return { price, supports, resistances, zone, exit, noChase };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function pctFrom(a: number, b: number): string {
  return `${(((a - b) / b) * 100).toFixed(1)}%`;
}

/** 給 AI 的文字區塊。 */
export function describePriceFramework(f: PriceFramework | null): string {
  if (!f) return "";
  const list = (ls: PriceLevel[]) => (ls.length ? ls.slice(0, 4).map((l) => `${fmt(l.price)}（${l.labels.join("、")}）`).join("、") : "無");
  const lines = [
    `${PRICE_LEVELS_TITLE}程式依日K算好；要給買進區間／出場價／不追價時一律直接採用下面『建議框架』的數字，不可自己另編或改變大小關係）：`,
    `- 現價 ${fmt(f.price)}`,
    `- 下方支撐（由近到遠）：${list(f.supports)}`,
    `- 上方壓力（由近到遠）：${list(f.resistances)}`,
  ];
  if (f.zone && f.exit) {
    const gap = pctFrom(f.price, f.zone.high);
    lines.push(
      `- 建議框架：分批買進區間 ${fmt(f.zone.low)}～${fmt(f.zone.high)}（上緣＝${f.zone.highLabel}、下緣＝${f.zone.lowLabel}）；` +
        `現價 ${fmt(f.price)} 高於區間上緣 ${gap}，現價『不在』區間內，${
          (f.price - f.zone.high) / f.zone.high < NEAR_ZONE_PCT ? "但已很接近上緣，回到上緣附近可先小量試單" : "要等回檔到區間才分批買"
        }；` +
        `買進後跌破 ${fmt(f.exit.price)}（${f.exit.label}，比區間下緣低 ${(((f.zone.low - f.exit.price) / f.zone.low) * 100).toFixed(1)}%）建議出場；` +
        `若直接漲過 ${fmt(f.noChase.price)}（${f.noChase.label}）就不追價。`
    );
  } else {
    lines.push(
      `- 建議框架：現價已低於所有均線與近期低點（下方沒有可用支撐，屬破底走勢），不給買進區間，結論應為暫緩觀望；` +
        `轉為可考慮買進的觸發條件＝重新站回 ${fmt(f.resistances[0]?.price ?? f.noChase.price)}（${f.resistances[0]?.labels.join("、") ?? f.noChase.label}）以上。`
    );
  }
  return lines.join("\n");
}
