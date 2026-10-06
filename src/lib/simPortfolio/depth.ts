import { fetchMisRows } from "@/lib/data/twse";
import { resolveTwExchange } from "@/lib/data/symbols";
import { ensureTwUniverseWarm } from "@/lib/data/universe";
import type { SimDepth } from "./rules";

/**
 * 模擬投資組合成交判斷用的盤口資料（有 I/O）：MIS 的漲停價 u、跌停價 w、最佳五檔賣價 a／賣量 f、買價 b／買量 g、
 * 累積成交量 v（張）、最近成交 z、昨收 y。一般報價（Quote）沒有這些欄位，報價模組也不需要，所以在這裡用
 * twse.ts 已匯出的 fetchMisRows 自己讀，不改報價模組（2026-10-06 使用者：「有些漲停可能買不到或跌停可能賣不掉的也要注意，要讓模擬越真實越好」）。
 * 一次執行只發 1 個 MIS 請求（上市＋上櫃代號合在同一個 ex_ch）；失敗回空 Map，成交判斷退回保守規則並記原因。
 */

interface MisDepthRow {
  c: string;
  z?: string;
  y?: string;
  u?: string;
  w?: string;
  a?: string;
  b?: string;
  f?: string;
  g?: string;
  v?: string;
  d?: string;
  trade?: { z?: string };
}

const SIM_DEPTH_TIMEOUT_MS = 6000;

const num = (s: string | undefined): number | undefined => {
  if (!s || s === "-") return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};
/** "_" 分隔的第一檔（MIS 用 0／空字串表示沒有掛單）。 */
const first = (s: string | undefined) => num(s?.split("_")[0]);

/** 一列 MIS → SimDepth（純函式，測試用）。 */
export function misRowToDepth(row: MisDepthRow): SimDepth | null {
  const prevClose = num(row.y);
  if (prevClose == null) return null;
  const last = num(row.z) ?? num(row.trade?.z);
  const bestAsk = first(row.a);
  const bestBid = first(row.b);
  return {
    last: last ?? null,
    prevClose,
    limitUp: num(row.u) ?? null,
    limitDown: num(row.w) ?? null,
    bestAsk: bestAsk ?? null,
    bestAskVol: bestAsk != null ? (first(row.f) ?? 0) * 1000 : 0,
    bestBid: bestBid ?? null,
    bestBidVol: bestBid != null ? (first(row.g) ?? 0) * 1000 : 0,
    volumeShares: (parseInt(row.v ?? "", 10) || 0) * 1000,
    tradeDate: row.d && /^\d{8}$/.test(row.d) ? `${row.d.slice(0, 4)}-${row.d.slice(4, 6)}-${row.d.slice(6, 8)}` : null,
  };
}

export async function getSimDepth(symbols: string[]): Promise<Map<string, SimDepth>> {
  const out = new Map<string, SimDepth>();
  if (symbols.length === 0) return out;
  try {
    await ensureTwUniverseWarm();
    const exCh = symbols.map((s) => `${resolveTwExchange(s) === "TPEx" ? "otc" : "tse"}_${s}.tw`).join("|");
    const rows = await fetchMisRows<MisDepthRow>(exCh, SIM_DEPTH_TIMEOUT_MS);
    for (const row of rows) {
      const d = misRowToDepth(row);
      if (d && row.c) out.set(row.c.toUpperCase(), d);
    }
  } catch (err) {
    console.warn("[sim-portfolio] 讀不到五檔／漲跌停價，改用保守規則：", err);
  }
  return out;
}
