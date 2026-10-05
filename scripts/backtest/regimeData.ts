/**
 * 市況開關研究的資料讀取（只讀本機快取）。
 * 為什麼不直接用 wideData.ts：那邊的選樣日期與快取目錄寫死在 wideConfig（給樣本內用），
 * 而這裡要用同一套方法套到另一段期間（樣本外）。邏輯與 wideData.buildUniverse／loadChips 相同，只是參數化；
 * 不改 wideData.ts 是因為另一個 agent 正在用它做回測，避免動到既有行為。
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, Chips } from "@/lib/data/types";
import { LARGE_N, MID_N, MID_RANK, SEED, SMALL_N, SMALL_RANK } from "./wideConfig";
import type { Tier, UniverseEntry } from "./wideData";
import type { PeriodConfig } from "./regimeConfig";

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const readJson = <T>(fn: string): T | null => (fs.existsSync(fn) ? (JSON.parse(fs.readFileSync(fn, "utf8")) as T) : null);
const isCommon = (code: string) => /^[1-9]\d{3}$/.test(code) && !code.startsWith("91");

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample<T>(arr: T[], n: number, rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

type Table = { fields?: string[]; data?: string[][] };

/** 與 wideData.buildUniverse 相同的分層抽樣，只是選樣日與快取目錄由 PeriodConfig 決定。 */
export function buildUniverseFor(p: PeriodConfig): { universe: UniverseEntry[]; rankedTotal: number } {
  const dir = path.join(p.cacheDir, "selection");
  const agg = new Map<string, { name: string; market: "TWSE" | "TPEX"; sum: number }>();
  let nDays = 0;
  for (const d of p.selectionDates) {
    const k = d.replace(/-/g, "");
    const tw = readJson<{ tables?: Table[] }>(path.join(dir, `twse_${k}.json`));
    const tp = readJson<{ tables?: Table[] }>(path.join(dir, `tpex_${k}.json`));
    if (!tw?.tables || !tp?.tables) continue;
    nDays++;
    const twT = tw.tables.find((t) => t.fields?.[0] === "證券代號");
    const add = (code: string, name: string, market: "TWSE" | "TPEX", value: number) => {
      if (!isCommon(code) || !Number.isFinite(value)) return;
      const e = agg.get(code) ?? { name, market, sum: 0 };
      e.sum += value;
      agg.set(code, e);
    };
    for (const r of twT?.data ?? []) add(r[0].trim(), r[1].trim(), "TWSE", num(r[4]));
    const tpT = tp.tables[0];
    const iVal = tpT.fields?.indexOf("成交金額(元)") ?? 9;
    for (const r of tpT.data ?? []) add(r[0].trim(), r[1].trim(), "TPEX", num(r[iVal]));
  }
  if (nDays === 0) throw new Error(`沒有選樣期行情（${dir}），先跑 regimeFetch.ts`);
  const ranked = [...agg.entries()]
    .map(([sym, e]) => ({ sym, name: e.name, market: e.market, avgValue: e.sum / nDays / 1e8 }))
    .sort((a, b) => b.avgValue - a.avgValue)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  const rnd = mulberry32(SEED);
  const inRank = ([lo, hi]: [number, number]) => ranked.filter((e) => e.rank >= lo && e.rank <= hi);
  const universe: UniverseEntry[] = [
    ...ranked.slice(0, LARGE_N).map((e) => ({ ...e, tier: "大型" as Tier })),
    ...sample(inRank(MID_RANK), MID_N, rnd).map((e) => ({ ...e, tier: "中型" as Tier })),
    ...sample(inRank(SMALL_RANK), SMALL_N, rnd).map((e) => ({ ...e, tier: "小型" as Tier })),
  ].sort((a, b) => a.rank - b.rank);
  return { universe, rankedTotal: ranked.length };
}

export function loadCandlesFor(p: PeriodConfig, name: string): Candle[] | null {
  const d = readJson<{ candles: Candle[] }>(path.join(p.cacheDir, "charts", `${name}.json`));
  return d?.candles?.length ? d.candles : null;
}

/** 與 wideData.loadChips 相同，目錄參數化。 */
export function loadChipsFor(p: PeriodConfig, date: string): Map<string, Chips> {
  const k = date.replace(/-/g, "");
  const out = new Map<string, Chips>();
  const tw = readJson<{ fields?: string[]; data?: string[][] }>(path.join(p.cacheDir, "chips", `twse_${k}.json`));
  if (tw?.fields && tw.data) {
    const iF = tw.fields.indexOf("外陸資買賣超股數(不含外資自營商)");
    const iT = tw.fields.indexOf("投信買賣超股數");
    const iA = tw.fields.indexOf("三大法人買賣超股數");
    for (const r of tw.data) out.set(r[0].trim(), { institutionalNetShares: num(r[iA]), foreignNetShares: num(r[iF]), trustNetShares: num(r[iT]) });
  }
  const tp = readJson<{ tables?: Array<{ data?: string[][] }> }>(path.join(p.cacheDir, "chips", `tpex_${k}.json`));
  for (const r of tp?.tables?.[0]?.data ?? []) {
    if (r.length < 24) continue;
    out.set(r[0].trim(), { institutionalNetShares: num(r[23]), foreignNetShares: num(r[4]), trustNetShares: num(r[13]) });
  }
  return out;
}
