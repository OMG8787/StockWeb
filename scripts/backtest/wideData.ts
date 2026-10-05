/**
 * 擴大樣本回測的資料讀取（只讀本機快取，無網路）：股票池、日K、三大法人、月營收。
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, Chips } from "@/lib/data/types";
import { LARGE_N, MID_N, MID_RANK, SEED, SELECTION_DATES, SMALL_N, SMALL_RANK, WIDE_CACHE_DIR } from "./wideConfig";

export type Tier = "大型" | "中型" | "小型";
export interface UniverseEntry {
  sym: string;
  name: string;
  market: "TWSE" | "TPEX";
  tier: Tier;
  rank: number;
  /** 選樣期平均成交金額（億元） */
  avgValue: number;
}

const num = (s: string) => Number(String(s).replace(/,/g, ""));
const readJson = <T>(fn: string): T | null => (fs.existsSync(fn) ? (JSON.parse(fs.readFileSync(fn, "utf8")) as T) : null);
/** 普通股：4 碼數字、不以 0 開頭（ETF）、不是 91xx（存託憑證）。 */
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

/** 依選樣期（訊號期之前）平均成交金額排名、分層隨機抽樣。結果固定（固定種子）。 */
export function buildUniverse(): UniverseEntry[] {
  const dir = path.join(WIDE_CACHE_DIR, "selection");
  const agg = new Map<string, { name: string; market: "TWSE" | "TPEX"; sum: number; days: number }>();
  let nDays = 0;
  for (const d of SELECTION_DATES) {
    const k = d.replace(/-/g, "");
    const tw = readJson<{ tables?: Array<{ fields?: string[]; data?: string[][] }> }>(path.join(dir, `twse_${k}.json`));
    const tp = readJson<{ tables?: Array<{ fields?: string[]; data?: string[][] }> }>(path.join(dir, `tpex_${k}.json`));
    if (!tw?.tables || !tp?.tables) continue;
    nDays++;
    const twT = tw.tables.find((t) => t.fields?.[0] === "證券代號");
    const add = (code: string, name: string, market: "TWSE" | "TPEX", value: number) => {
      if (!isCommon(code) || !Number.isFinite(value)) return;
      const e = agg.get(code) ?? { name, market, sum: 0, days: 0 };
      e.sum += value;
      e.days++;
      agg.set(code, e);
    };
    for (const r of twT?.data ?? []) add(r[0].trim(), r[1].trim(), "TWSE", num(r[4]));
    const tpT = tp.tables[0];
    const iVal = tpT.fields?.indexOf("成交金額(元)") ?? 9;
    for (const r of tpT.data ?? []) add(r[0].trim(), r[1].trim(), "TPEX", num(r[iVal]));
  }
  if (nDays === 0) throw new Error("沒有選樣期行情，先跑 wideFetch.ts --only=selection");
  const ranked = [...agg.entries()]
    .map(([sym, e]) => ({ sym, name: e.name, market: e.market, avgValue: e.sum / nDays / 1e8 }))
    .sort((a, b) => b.avgValue - a.avgValue)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  const rnd = mulberry32(SEED);
  const inRank = ([lo, hi]: [number, number]) => ranked.filter((e) => e.rank >= lo && e.rank <= hi);
  const out: UniverseEntry[] = [
    ...ranked.slice(0, LARGE_N).map((e) => ({ ...e, tier: "大型" as Tier })),
    ...sample(inRank(MID_RANK), MID_N, rnd).map((e) => ({ ...e, tier: "中型" as Tier })),
    ...sample(inRank(SMALL_RANK), SMALL_N, rnd).map((e) => ({ ...e, tier: "小型" as Tier })),
  ];
  return out.sort((a, b) => a.rank - b.rank);
}

/** 選樣期普通股總檔數（報告用）。 */
export function rankedCount(): number {
  const dir = path.join(WIDE_CACHE_DIR, "selection");
  const k = SELECTION_DATES.at(-1)!.replace(/-/g, "");
  const tw = readJson<{ tables: Array<{ fields?: string[]; data?: string[][] }> }>(path.join(dir, `twse_${k}.json`));
  const tp = readJson<{ tables: Array<{ data?: string[][] }> }>(path.join(dir, `tpex_${k}.json`));
  const a = tw?.tables.find((t) => t.fields?.[0] === "證券代號")?.data?.filter((r) => isCommon(r[0].trim())).length ?? 0;
  const b = tp?.tables[0]?.data?.filter((r) => isCommon(r[0].trim())).length ?? 0;
  return a + b;
}

export function loadCandles(name: string): Candle[] | null {
  const d = readJson<{ candles: Candle[] }>(path.join(WIDE_CACHE_DIR, "charts", `${name}.json`));
  return d?.candles?.length ? d.candles : null;
}

/** 交易日曆 → 每週最後一個交易日（start～end）。 */
export function weeklySignalDates(cal: string[], start: string, end: string): string[] {
  const weekKey = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    const dow = (t.getUTCDay() + 6) % 7; // 週一=0
    return new Date(t.getTime() - dow * 86400000).toISOString().slice(0, 10);
  };
  const last = new Map<string, string>();
  for (const d of cal) if (d >= start && d <= end) last.set(weekKey(d), d);
  return [...last.values()].sort();
}

/** 某日上市＋上櫃三大法人（代號 → Chips）；沒資料回傳空 Map。 */
export function loadChips(date: string): Map<string, Chips> {
  const k = date.replace(/-/g, "");
  const out = new Map<string, Chips>();
  const tw = readJson<{ fields?: string[]; data?: string[][]; empty?: boolean }>(path.join(WIDE_CACHE_DIR, "chips", `twse_${k}.json`));
  if (tw?.fields && tw.data) {
    const iF = tw.fields.indexOf("外陸資買賣超股數(不含外資自營商)");
    const iT = tw.fields.indexOf("投信買賣超股數");
    const iA = tw.fields.indexOf("三大法人買賣超股數");
    for (const r of tw.data) out.set(r[0].trim(), { institutionalNetShares: num(r[iA]), foreignNetShares: num(r[iF]), trustNetShares: num(r[iT]) });
  }
  const tp = readJson<{ tables?: Array<{ data?: string[][] }> }>(path.join(WIDE_CACHE_DIR, "chips", `tpex_${k}.json`));
  // 櫃買欄位：[0]代號 [4]外資(不含自營)買賣超 [13]投信買賣超 [23]三大法人合計
  for (const r of tp?.tables?.[0]?.data ?? []) {
    if (r.length < 24) continue;
    out.set(r[0].trim(), { institutionalNetShares: num(r[23]), foreignNetShares: num(r[4]), trustNetShares: num(r[13]) });
  }
  return out;
}

/** 月營收彙總表（Big5 HTML）→ 代號 → 年增率%（上市＋上櫃合併）。 */
function loadRevenueMonth(y: number, m: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const mk of ["sii", "otc"]) {
    const fn = path.join(WIDE_CACHE_DIR, "revenue", `${mk}_${y}_${m}.html`);
    if (!fs.existsSync(fn)) continue;
    const html = new TextDecoder("big5").decode(fs.readFileSync(fn));
    for (const tr of html.split(/<tr/i)) {
      const cells = [...tr.matchAll(/<td[^>]*>([^<]*)<\/td>/gi)].map((x) => x[1].trim());
      if (cells.length >= 7 && /^\d{4}$/.test(cells[0])) {
        const yoy = Number(cells[6].replace(/,/g, ""));
        if (Number.isFinite(yoy)) out.set(cells[0], yoy);
      }
    }
  }
  return out;
}

const revCache = new Map<string, Map<string, number>>();
/** 訊號日當時已公布的最新月營收年增率（法定次月 10 日前公布 → 訊號日 ≥ 次月 11 日才用）。 */
export function revenueYoyAsOf(date: string, sym: string): number | null {
  const [Y, M, D] = date.split("-").map(Number);
  // 最新可用月份：若日 ≥ 11 → 上個月，否則上上個月
  let y = Y, m = M - (D >= 11 ? 1 : 2);
  while (m <= 0) { m += 12; y--; }
  const key = `${y - 1911}_${m}`;
  if (!revCache.has(key)) revCache.set(key, loadRevenueMonth(y - 1911, m));
  return revCache.get(key)!.get(sym) ?? null;
}
