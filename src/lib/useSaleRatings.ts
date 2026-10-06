"use client";

import { useEffect, useState } from "react";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import {
  mayHaveRatingLog,
  pickRatingAtSale,
  ratingWindowFor,
  type RatingAtSaleEntry,
} from "@/lib/soldRecords";

/**
 * 「已賣出」表格的「賣出當天本站建議」查詢（前端）：對每個不同的賣出日，用 /api/rating-log
 * （symbols 篩選）抓該日往前 SALE_RATING_LOOKBACK_DAYS 天內這幾檔的評等紀錄，再用
 * soldRecords.pickRatingAtSale 挑「當天或之前最近一筆」（跟 AI 的已賣出區塊同一個挑選函式）。
 * 評等紀錄 2026-10-05 才開始，更早的賣出日不打 API，直接「無紀錄」。
 * 賣出日已過的結果不會再變，快取在記憶體；賣出日是今天的 5 分鐘後可再查。
 */

export interface SaleRatingKey {
  symbol: string;
  date: string;
}

type Fetched = { at: number; entries: RatingAtSaleEntry[] };
const cache = new Map<string, Fetched>();
const inflight = new Map<string, Promise<RatingAtSaleEntry[]>>();
const TODAY_TTL_MS = 5 * 60_000;
const MAX_DATES = 15;

async function fetchWindow(date: string, symbols: string[]): Promise<RatingAtSaleEntry[]> {
  const { from, to } = ratingWindowFor(date);
  const key = `${date}|${symbols.join(",")}`;
  const hit = cache.get(key);
  if (hit && (date < taipeiDayKey() || Date.now() - hit.at < TODAY_TTL_MS)) return hit.entries;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetch(`/api/rating-log?from=${from}&to=${to}&symbols=${encodeURIComponent(symbols.join(","))}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { items?: RatingAtSaleEntry[] } | null) => {
      const entries = body?.items ?? [];
      if (body) cache.set(key, { at: Date.now(), entries });
      return entries;
    })
    .catch(() => [] as RatingAtSaleEntry[])
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 回傳 `${symbol}|${date}` → 該日評等（null＝無紀錄；key 不存在＝還在查）。 */
export function useSaleRatings(keys: SaleRatingKey[]): Map<string, RatingAtSaleEntry | null> {
  const [result, setResult] = useState<Map<string, RatingAtSaleEntry | null>>(new Map());
  const signature = keys
    .map((k) => `${k.symbol.toUpperCase()}|${k.date}`)
    .sort()
    .join(";");

  useEffect(() => {
    let cancelled = false;
    const wanted = signature ? signature.split(";").map((s) => s.split("|") as [string, string]) : [];
    const byDate = new Map<string, Set<string>>();
    for (const [symbol, date] of wanted) {
      if (!mayHaveRatingLog(date)) continue;
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date)!.add(symbol);
    }
    const dates = Array.from(byDate.keys()).sort().reverse().slice(0, MAX_DATES);
    const out = new Map<string, RatingAtSaleEntry | null>();
    void Promise.all(
      dates.map(async (date) => {
        const symbols = Array.from(byDate.get(date)!).sort();
        const entries = await fetchWindow(date, symbols);
        for (const s of symbols) out.set(`${s}|${date}`, pickRatingAtSale(entries, s, date));
      })
    ).then(() => {
      if (!cancelled) setResult(out);
    });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  // 評等紀錄開始日之前、或超過一次最多查的賣出日數的：直接「無紀錄」（不必等 API）。
  const merged = new Map(result);
  const queried = new Set(
    Array.from(new Set(keys.map((k) => k.date)))
      .filter(mayHaveRatingLog)
      .sort()
      .reverse()
      .slice(0, MAX_DATES)
  );
  for (const k of keys) {
    if (!queried.has(k.date)) merged.set(`${k.symbol.toUpperCase()}|${k.date}`, null);
  }
  return merged;
}
