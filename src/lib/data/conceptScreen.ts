import { mapWithConcurrency } from "./cache";
import { getChart } from "./chart";
import { getTwFundamentalsMap } from "./companyData";
import { cachedListWithDegradedEmptyTtl } from "./degradedCache";
import { getTaiexDailyCloses } from "./marketHistory";
import { HEAVY_SWR_MS, sessionAwareTtl } from "./swrPolicy";
import { getTechnicalScreen } from "./techScreen";
import type { Candle } from "./types";

/**
 * 概念篩選用的全市場統計（2026-10-07 使用者📝：問「有看起來抗壓性強且有上漲趨勢的股票嗎」，本站沒有這類概念的資料，
 * 模型只能套上文個股、答大盤偏多，甚至自己編股價）。把常見概念對應到程式算得出的條件——
 * 抗壓性＝大盤下跌日相對抗跌、近 60 日最大回撤小、beta 低；上漲趨勢＝站上 20／60 日均線且 20 日均線上升；
 * 低波動＝近 20 日日報酬標準差小；高殖利率＝官方殖利率——每檔算好數字，名單與排序在 ai/grounding/conceptScreen.ts。
 *
 * 母體＝技術指標篩選同一份（成交金額前 120 檔台股，getTechnicalScreen），K 線用同一個 3 個月日K快取
 * （chart:TW:<代號>:3m，技術篩選剛抓過），所以不會對證交所／櫃買多打請求；加權指數日K用 marketHistory 同一份快取。
 * 只做台股（美股母體小、沒有批次殖利率，問美股概念時 grounding 照實說明）。
 */
export interface ConceptStats {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  turnover: number;
  ma20: number | null;
  ma60: number | null;
  /** 20 日均線比 5 個交易日前高 */
  ma20Rising: boolean | null;
  /** 近 20／60 個交易日報酬（%） */
  ret20: number | null;
  ret60: number | null;
  /** 近 60 個交易日最大回撤（%，正數） */
  maxDrawdown60: number | null;
  /** 近 20 個交易日日報酬標準差（%） */
  volatility20: number | null;
  /** 加權指數下跌日（近 60 日）該股平均日報酬減加權指數平均日報酬（百分點；正＝比大盤抗跌） */
  downDayExcess: number | null;
  /** 統計用的加權指數下跌日數 */
  downDays: number;
  /** 近 60 日相對加權指數的 beta */
  beta60: number | null;
  dividendYield: number | null;
  peRatio: number | null;
}

const CONCEPT_SCREEN_TTL_MS = 30 * 60_000;
const CONCEPT_SCREEN_DEGRADED_TTL_MS = 60_000;
/** 跟技術篩選同一個上限，避免對 K 線快取以外的來源扇出。 */
const CONCEPT_CHART_CONCURRENCY = 4;
const LOOKBACK = 60;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function sma(closes: number[], n: number, endExclusiveFromEnd = 0): number | null {
  const end = closes.length - endExclusiveFromEnd;
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += closes[i];
  return s / n;
}

function dailyReturns(candles: Candle[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) out.set(candles[i].time.slice(0, 10), (candles[i].close / prev - 1) * 100);
  }
  return out;
}

/** 純函式（有測試）：一檔的概念統計。taiexReturns＝加權指數日報酬（日期→%）。 */
export function computeConceptStats(
  base: { symbol: string; name: string; price: number; changePercent: number; turnover: number },
  candles: Candle[],
  taiexReturns: Map<string, number>,
  fundamentals?: { dividendYield?: number; peRatio?: number }
): ConceptStats {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const ma20Prev = sma(closes, 20, 5);
  // 3 個月日K約 60～64 根；不足 60 根但有 55 根以上時用全部（標示仍為季線近似）。
  const ma60 = closes.length >= LOOKBACK ? sma(closes, LOOKBACK) : closes.length >= 55 ? sma(closes, closes.length) : null;
  const pct = (from: number | undefined) => (from && from > 0 && last ? round((last / from - 1) * 100, 1) : null);
  const window = candles.slice(-LOOKBACK);
  let peak = 0;
  let mdd = 0;
  for (const c of window) {
    peak = Math.max(peak, c.close);
    if (peak > 0) mdd = Math.max(mdd, (1 - c.close / peak) * 100);
  }
  const rets = dailyReturns(candles.slice(-(LOOKBACK + 1)));
  const last20 = [...rets.values()].slice(-20);
  const mean20 = last20.reduce((a, b) => a + b, 0) / (last20.length || 1);
  const vol20 = last20.length >= 15 ? Math.sqrt(last20.reduce((a, b) => a + (b - mean20) ** 2, 0) / (last20.length - 1)) : null;
  const paired: Array<[number, number]> = [];
  for (const [d, r] of rets) {
    const m = taiexReturns.get(d);
    if (m != null) paired.push([r, m]);
  }
  const down = paired.filter(([, m]) => m < 0);
  const downDayExcess =
    down.length >= 5 ? round(down.reduce((a, [r, m]) => a + (r - m), 0) / down.length, 2) : null;
  let beta60: number | null = null;
  if (paired.length >= 30) {
    const mx = paired.reduce((a, [, m]) => a + m, 0) / paired.length;
    const my = paired.reduce((a, [r]) => a + r, 0) / paired.length;
    const cov = paired.reduce((a, [r, m]) => a + (r - my) * (m - mx), 0);
    const varM = paired.reduce((a, [, m]) => a + (m - mx) ** 2, 0);
    beta60 = varM > 0 ? round(cov / varM, 2) : null;
  }
  return {
    ...base,
    ma20: ma20 != null ? round(ma20) : null,
    ma60: ma60 != null ? round(ma60) : null,
    ma20Rising: ma20 != null && ma20Prev != null ? ma20 > ma20Prev : null,
    ret20: pct(closes[closes.length - 21]),
    ret60: pct(closes[Math.max(0, closes.length - 1 - LOOKBACK)]),
    maxDrawdown60: window.length >= 20 ? round(mdd, 1) : null,
    volatility20: vol20 != null ? round(vol20, 2) : null,
    downDayExcess,
    downDays: down.length,
    beta60,
    dividendYield: fundamentals?.dividendYield != null && fundamentals.dividendYield > 0 ? fundamentals.dividendYield : null,
    peRatio: fundamentals?.peRatio != null && fundamentals.peRatio > 0 ? fundamentals.peRatio : null,
  };
}

/** 台股成交金額前 120 檔的概念統計（30 分鐘快取；收盤後拉長，同技術篩選）。 */
export async function getConceptScreen(): Promise<ConceptStats[]> {
  return cachedListWithDegradedEmptyTtl(
    "concept-screen:TW:v1",
    sessionAwareTtl("TW", CONCEPT_SCREEN_TTL_MS),
    CONCEPT_SCREEN_DEGRADED_TTL_MS,
    async () => {
      const [pool, taiex, fundamentals] = await Promise.all([
        getTechnicalScreen("TW"),
        getTaiexDailyCloses().catch(() => []),
        getTwFundamentalsMap().catch(() => new Map()),
      ]);
      const taiexReturns = new Map<string, number>();
      for (let i = 1; i < taiex.length; i++) {
        if (taiex[i - 1].close > 0) taiexReturns.set(taiex[i].date, (taiex[i].close / taiex[i - 1].close - 1) * 100);
      }
      const rows = await mapWithConcurrency(pool, CONCEPT_CHART_CONCURRENCY, async (item) => {
        try {
          const chart = await getChart(item.symbol, "3m", item.market);
          if (!chart || chart.candles.length < 25) return null;
          return computeConceptStats(item, chart.candles, taiexReturns, fundamentals.get(item.symbol));
        } catch {
          return null;
        }
      });
      return rows.filter((r): r is ConceptStats => r !== null);
    },
    { staleWhileRevalidateMs: HEAVY_SWR_MS }
  );
}
