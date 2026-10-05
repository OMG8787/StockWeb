import type { Candle, Chips, ChipsRatios, Earnings } from "@/lib/data/types";
import { computeIndicatorState } from "@/lib/signals";
import type { ChaseMetrics } from "../chaseGuards";
import { NEAR_ZONE_PCT, type PriceFramework } from "../grounding/priceLevels";
import type { MarketRegime } from "./regime";

/**
 * AI 經驗累積第一階段（2026-10-05）：評等當下「所有判斷依據」的具體狀態（純邏輯、無 I/O，有測試）。
 *
 * 儲存原則：
 * - 數值存「原始值（四捨五入到 1 位小數）」而不是區間——區間切法（FEATURE_BUCKETS）日後要改，
 *   舊紀錄不用重寫，重新分桶即可。
 * - 欄位名稱刻意用 2～3 字母縮寫，每筆約 0.2KB；評等紀錄一年約幾萬筆，控制 Redis 用量。
 * - 舊紀錄（2026-10-05 之前）沒有這個物件，所有讀取端都要允許 undefined。
 */

export interface RatingFeatures {
  /** schema 版本 */
  v: 1;
  /** RSI(14) */
  rsi: number | null;
  /** 近 5／10／20 個交易日漲幅（%） */
  r5: number | null;
  r10: number | null;
  r20: number | null;
  /** 現價距 MA20／MA60（%） */
  b20: number | null;
  b60: number | null;
  /** 量能倍數：最新一根日K量 ÷ 前 20 日均量 */
  vr: number | null;
  /** KD 的 K 值、今天 KD 交叉（g＝黃金、d＝死亡） */
  k: number | null;
  kx: "g" | "d" | null;
  /** MACD 今天交叉、DIF 在 0 軸上（1）或下（0） */
  mx: "g" | "d" | null;
  m0: 1 | 0 | null;
  /** 三大法人合計／外資／投信 當日買賣超方向（1 買超、-1 賣超、0 持平；沒資料 null） */
  ii: 1 | -1 | 0 | null;
  fi: 1 | -1 | 0 | null;
  ti: 1 | -1 | 0 | null;
  /** 法人連續同方向天數（正＝連買、負＝連賣）。正式站評等路徑目前沒有逐日法人資料，先預留（null）。 */
  ist: number | null;
  /** 融資使用率（%）與較前一日變化（百分點） */
  mu: number | null;
  mud: number | null;
  /** 最新月營收年增率（%） */
  ry: number | null;
  /** 產業外部因子方向（目前只有油價）：+ 偏利多、- 偏利空；非敏感產業或方向不明 null */
  sf: "+" | "-" | null;
  /** 近 3 日內有漲停 */
  lu: 1 | 0;
  /** 價位位置：broke＝破底（沒有買進區間）、below＝低於區間、in＝區間內、near＝高於上緣但在 NEAR_ZONE_PCT 內、above＝高於上緣 */
  pos: "broke" | "below" | "in" | "near" | "above" | null;
}

const r1 = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sign = (v: number | null | undefined): 1 | -1 | 0 | null => (v == null ? null : v > 0 ? 1 : v < 0 ? -1 : 0);

export interface FeatureInput {
  candles: Candle[] | null | undefined;
  price: number;
  chase: ChaseMetrics | null;
  chips: Chips | null;
  chipsRatios: ChipsRatios | null;
  earnings: Earnings | null;
  framework: PriceFramework | null;
  sectorDirection: "+" | "-" | null;
}

export function pricePosition(framework: PriceFramework | null): RatingFeatures["pos"] {
  if (!framework) return null;
  const z = framework.zone;
  if (!z) return "broke";
  const p = framework.price;
  if (p < z.low) return "below";
  if (p <= z.high) return "in";
  return (p - z.high) / z.high < NEAR_ZONE_PCT ? "near" : "above";
}

export function computeRatingFeatures(input: FeatureInput): RatingFeatures {
  const { chase, chips, chipsRatios, earnings } = input;
  const ind = input.candles && input.candles.length >= 5 ? computeIndicatorState(input.candles, input.price) : null;
  const m = chipsRatios?.margin;
  return {
    v: 1,
    rsi: r1(chase?.rsi ?? ind?.rsi),
    r5: r1(chase?.ret5),
    r10: r1(chase?.ret10),
    r20: r1(chase?.ret20),
    b20: r1(chase?.ma20BiasPct),
    b60: r1(chase?.ma60BiasPct),
    vr: ind?.volumeRatio != null ? Math.round(ind.volumeRatio * 100) / 100 : null,
    k: r1(ind?.kd?.k),
    kx: ind?.kd?.cross === "golden" ? "g" : ind?.kd?.cross === "death" ? "d" : null,
    mx: ind?.macdCross === "golden" ? "g" : ind?.macdCross === "death" ? "d" : null,
    m0: ind?.macdAboveZero == null ? null : ind.macdAboveZero ? 1 : 0,
    ii: sign(chips?.institutionalNetShares),
    fi: sign(chips?.foreignNetShares),
    ti: sign(chips?.trustNetShares),
    ist: null,
    mu: r1(m?.utilizationPercent),
    mud: m?.prevUtilizationPercent != null ? Math.round((m.utilizationPercent - m.prevUtilizationPercent) * 100) / 100 : null,
    ry: r1(earnings?.monthlyRevenueYoyPercent),
    sf: input.sectorDirection,
    lu: chase?.limitUpWithin3 ? 1 : 0,
    pos: pricePosition(input.framework),
  };
}

// ── 分桶：把原始值轉成「判斷依據」鍵（權重、相似案例、教訓比對共用） ──

/** 數值分桶切點（含左不含右，最後一桶開放）。改切點不影響已存的原始值。 */
export const FEATURE_BUCKETS = {
  rsi: [30, 50, 70, 75],
  r5: [-5, 0, 5, 10, 15],
  r20: [-10, 0, 10, 25],
  b20: [-5, 0, 5, 10],
  b60: [-10, 0, 10, 25],
  vr: [0.7, 1.5, 3],
  k: [20, 80],
  ry: [0, 20],
} as const;

/** 融資使用率單日變化超過這個百分點才算「升／降」。 */
export const MARGIN_CHANGE_MIN_PTS = 0.5;

export type BucketFeature = keyof typeof FEATURE_BUCKETS;

/** 回傳區間標籤，例如 "70~75"、"<30"、"≥75"；值是 null 回傳 null。 */
export function bucketOf(feature: BucketFeature, value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const cuts = FEATURE_BUCKETS[feature];
  if (value < cuts[0]) return `<${cuts[0]}`;
  for (let i = 1; i < cuts.length; i++) if (value < cuts[i]) return `${cuts[i - 1]}~${cuts[i]}`;
  return `≥${cuts[cuts.length - 1]}`;
}

const DIR_LABEL = { 1: "買超", "-1": "賣超", 0: "持平" } as const;
const POS_LABEL: Record<NonNullable<RatingFeatures["pos"]>, string> = {
  broke: "破底",
  below: "低於買進區間",
  in: "買進區間內",
  near: "接近區間上緣",
  above: "高於區間上緣",
};

export const FEATURE_LABEL: Record<string, string> = {
  rsi: "RSI",
  r5: "5日漲幅%",
  r20: "20日漲幅%",
  b20: "距MA20%",
  b60: "距MA60%",
  vr: "量能倍數",
  k: "KD的K值",
  kx: "KD交叉",
  mx: "MACD交叉",
  m0: "MACD零軸",
  ii: "三大法人",
  fi: "外資",
  ti: "投信",
  margin: "融資使用率",
  ry: "月營收年增%",
  sf: "產業外部因子",
  lu: "近3日漲停",
  pos: "價位位置",
  facet: "面向評級",
  chase: "追高防護",
  ai: "AI調整",
};

/**
 * 一筆紀錄的「判斷依據」鍵清單，格式 `類別:值`（例如 `rsi:70~75`、`facet:籌碼面:不支持`、`chase:surge`）。
 * 權重、成績看板都以這個鍵為單位；新資料新增鍵時自然從中性起步（沒有樣本＝權重 0）。
 */
export function featureBases(
  f: RatingFeatures | undefined,
  facets?: Record<string, string>,
  chaseHits?: string[],
  aiDelta?: number | null
): string[] {
  const out: string[] = [];
  if (f) {
    for (const key of ["rsi", "r5", "r20", "b20", "b60", "vr", "k", "ry"] as const) {
      const b = bucketOf(key, f[key]);
      if (b) out.push(`${key}:${b}`);
    }
    if (f.kx) out.push(`kx:${f.kx === "g" ? "黃金交叉" : "死亡交叉"}`);
    if (f.mx) out.push(`mx:${f.mx === "g" ? "黃金交叉" : "死亡交叉"}`);
    if (f.m0 != null) out.push(`m0:${f.m0 ? "零軸上" : "零軸下"}`);
    for (const key of ["ii", "fi", "ti"] as const) {
      const d = f[key];
      if (d != null) out.push(`${key}:${DIR_LABEL[d]}`);
    }
    if (f.mud != null) out.push(`margin:${f.mud >= MARGIN_CHANGE_MIN_PTS ? "升" : f.mud <= -MARGIN_CHANGE_MIN_PTS ? "降" : "平"}`);
    if (f.sf) out.push(`sf:${f.sf === "+" ? "偏利多" : "偏利空"}`);
    if (f.lu) out.push("lu:有");
    if (f.pos) out.push(`pos:${POS_LABEL[f.pos]}`);
  }
  for (const [name, verdict] of Object.entries(facets ?? {})) {
    if (verdict && verdict !== "無資料") out.push(`facet:${name}:${verdict}`);
  }
  for (const id of chaseHits ?? []) out.push(`chase:${id}`);
  if (aiDelta) out.push(`ai:${aiDelta > 0 ? "調升" : "調降"}`);
  return out;
}

/** 依據鍵的中文說明（看板用），例如 `rsi:70~75` → `RSI 70~75`。 */
export function describeBasis(basis: string): string {
  const [cat, ...rest] = basis.split(":");
  return `${FEATURE_LABEL[cat] ?? cat} ${rest.join(":")}`;
}

/** 相似案例的比對鍵：同市況＋同 RSI 區間＋同 5 日漲幅區間（任一缺值就無法比對）。 */
export function similarKey(f: RatingFeatures | undefined, regime: MarketRegime | null | undefined): string | null {
  if (!f || !regime) return null;
  const rsi = bucketOf("rsi", f.rsi);
  const r5 = bucketOf("r5", f.r5);
  if (!rsi || !r5) return null;
  return `${regime}|${rsi}|${r5}`;
}
