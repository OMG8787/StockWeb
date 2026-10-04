import { cached } from "./cache";
import { HEAVY_SWR_MS } from "./swrPolicy";
import { fetchUsCandles } from "./us";

/**
 * 原油價格（近即時，Yahoo 期貨日K：WTI＝CL=F、Brent＝BZ=F）。
 *
 * 2026-10-04 使用者用📝回報：問「明天可以買華航嗎」，AI 完全沒考慮「油價已經降了」。
 * 原因有二：①本站唯一的油價來自 FRED DCOILWTICO，FRED 約每週才批次更新，最新一筆可能落後
 * 一週，根本看不到最近幾天的變化；②個股資料沒有「產業關鍵外部因子」，模型不會主動想到。
 * 這裡補上近即時的油價（含近1日／1週／1個月變化），由 grounding/sectorFactors.ts 只附給
 * 油價敏感產業（航空、塑化、油輪…）。免費、不需金鑰（零花費原則）。
 */
export interface OilQuote {
  label: string;
  price: number;
  date: string;
  change1dPct: number | null;
  change1wPct: number | null;
  change1mPct: number | null;
}

const OIL_TTL_MS = 30 * 60_000;
const OIL_SERIES = [
  { symbol: "CL=F", label: "WTI原油期貨" },
  { symbol: "BZ=F", label: "Brent原油期貨" },
] as const;

function pctChange(now: number, then: number | undefined): number | null {
  return then && then > 0 ? Math.round((now / then - 1) * 10000) / 100 : null;
}

async function loadOil(): Promise<OilQuote[]> {
  const out: OilQuote[] = [];
  for (const s of OIL_SERIES) {
    try {
      const c = await fetchUsCandles(s.symbol, "3m");
      if (c.length < 2) continue;
      const last = c[c.length - 1];
      out.push({
        label: s.label,
        price: Math.round(last.close * 100) / 100,
        date: last.time,
        change1dPct: pctChange(last.close, c[c.length - 2]?.close),
        change1wPct: pctChange(last.close, c[c.length - 6]?.close),
        change1mPct: pctChange(last.close, c[c.length - 22]?.close),
      });
    } catch {
      // fail open：抓不到就少一項，不拖垮個股回答
    }
  }
  return out;
}

export function getOilQuotes(): Promise<OilQuote[]> {
  return cached("commodities:oil:v1", OIL_TTL_MS, loadOil, { staleWhileRevalidateMs: HEAVY_SWR_MS });
}
