"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Market } from "./data/types";
import { CHIPS_BATCH_MAX_SYMBOLS, type ChipsRatiosBatchResponse, type ListChipsRatios } from "./chipsRatiosList";

/**
 * 股票列表「籌碼比例」三欄的共用資料來源（StockTable 的搜尋／焦點排行／榜單，
 * 以及 WatchlistTable 的持有中／僅關注兩組都走這裡）。
 *
 * 設計重點：
 * - **漸進載入、不拖慢列表**：列表本體照常先顯示，每一列進到畫面附近（Intersection
 *   Observer，上下預留 600px）才登記要這一檔的比例；同一段時間內登記的代號合併成一
 *   次批次請求（最多 CHIPS_BATCH_MAX_SYMBOLS 檔）。搜尋頁一次渲染上千列時，只會要
 *   實際捲到的那幾十列，不會一次要全部。
 * - **不會錯位**：狀態以「代號」為 key 存在模組層級的 store，每一列只讀自己代號那一格，
 *   換排序／篩選／頁籤造成列表換股票時不可能顯示成別檔的數字；已取得的直接沿用。
 * - 前端記憶體快取 30 分鐘（伺服器資料層本身融資/外資 1 小時、大戶 6 小時才更新），
 *   失敗的代號 1 分鐘後才會再試，避免上游出問題時每次捲動都重打。
 * - **大戶上一週的第二階段**：短清單（關注清單、≤10 列的排行）可傳 webFallback，
 *   週快照沒有上一週的那幾檔會再用 `majorPrev=web` 小批（≤8 檔、一次一批）補查集保
 *   官網；長清單不做，直接顯示「累積中」。每個瀏覽頁面最多補查 MAX_WEB_FALLBACK 檔。
 */

export type ChipsRatioEntry =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ok"; data: ListChipsRatios | null; majorPrevPending?: boolean };

const IDLE: ChipsRatioEntry = { status: "idle" };
const OK_TTL_MS = 30 * 60_000;
const FAILED_RETRY_MS = 60_000;
const FLUSH_DELAY_MS = 80;
const WEB_BATCH = 8;
const MAX_WEB_FALLBACK = 40;

interface Slot {
  entry: ChipsRatioEntry;
  at: number;
}

const store = new Map<string, Slot>();
const listeners = new Map<string, Set<() => void>>();
const metaListeners = new Set<() => void>();
const pending = new Set<string>();
const inFlight = new Set<string>();
const webEligible = new Set<string>();
const webTried = new Set<string>();
const webQueue: string[] = [];
let webRunning = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let meta: { majorDate?: string; majorPrevDate?: string } = {};

/** 任何一檔狀態變動都通知（給 ensureChipsRatios 等「等一整批」的用途）。 */
const anyListeners = new Set<() => void>();

function setEntry(symbol: string, entry: ChipsRatioEntry) {
  store.set(symbol, { entry, at: Date.now() });
  listeners.get(symbol)?.forEach((l) => l());
  anyListeners.forEach((l) => l());
}

function updateMeta(body: ChipsRatiosBatchResponse) {
  const next = { majorDate: body.majorDate ?? meta.majorDate, majorPrevDate: body.majorPrevDate ?? meta.majorPrevDate };
  if (next.majorDate !== meta.majorDate || next.majorPrevDate !== meta.majorPrevDate) {
    meta = next;
    metaListeners.forEach((l) => l());
  }
}

async function fetchBatch(symbols: string[], web: boolean): Promise<ChipsRatiosBatchResponse> {
  const res = await fetch(`/api/chips-ratios?symbols=${symbols.join(",")}${web ? "&majorPrev=web" : ""}`);
  if (!res.ok) throw new Error(`chips-ratios ${res.status}`);
  return (await res.json()) as ChipsRatiosBatchResponse;
}

function maybeQueueWeb(symbol: string) {
  const slot = store.get(symbol);
  if (!webEligible.has(symbol) || webTried.has(symbol) || webTried.size >= MAX_WEB_FALLBACK) return;
  if (slot?.entry.status !== "ok" || !slot.entry.data?.major || slot.entry.data.major[1] != null) return;
  webTried.add(symbol);
  webQueue.push(symbol);
  setEntry(symbol, { ...slot.entry, majorPrevPending: true });
  void runWebQueue();
}

/** 一次只跑一小批，對集保官網的並行量由伺服器端再限制成 2。 */
async function runWebQueue() {
  if (webRunning) return;
  webRunning = true;
  try {
    while (webQueue.length > 0) {
      const batch = webQueue.splice(0, WEB_BATCH);
      const body = await fetchBatch(batch, true).catch(() => undefined);
      if (body) updateMeta(body);
      for (const symbol of batch) {
        const cur = store.get(symbol)?.entry;
        const fresh = body?.items[symbol];
        // 補查失敗就保留原本（只有本週數值）的資料，升降處改顯示「累積中」。
        const data = fresh !== undefined ? fresh : cur?.status === "ok" ? cur.data : null;
        setEntry(symbol, { status: "ok", data, majorPrevPending: false });
      }
    }
  } finally {
    webRunning = false;
  }
}

async function flush() {
  flushTimer = null;
  const symbols = Array.from(pending);
  pending.clear();
  for (let i = 0; i < symbols.length; i += CHIPS_BATCH_MAX_SYMBOLS) {
    const batch = symbols.slice(i, i + CHIPS_BATCH_MAX_SYMBOLS);
    batch.forEach((s) => inFlight.add(s));
    try {
      const body = await fetchBatch(batch, false);
      updateMeta(body);
      for (const symbol of batch) setEntry(symbol, { status: "ok", data: body.items[symbol] ?? null });
      batch.forEach(maybeQueueWeb);
    } catch {
      for (const symbol of batch) {
        const cur = store.get(symbol)?.entry;
        // 背景重新整理失敗時，手上已有的舊資料照樣顯示，不要換成「—」。
        if (cur?.status !== "ok") setEntry(symbol, { status: "failed" });
      }
    } finally {
      batch.forEach((s) => inFlight.delete(s));
    }
  }
}

function request(symbol: string, webFallback: boolean) {
  if (webFallback) webEligible.add(symbol);
  if (inFlight.has(symbol) || pending.has(symbol)) return;
  const slot = store.get(symbol);
  const age = slot ? Date.now() - slot.at : Infinity;
  if (slot?.entry.status === "ok" && age < OK_TTL_MS) {
    maybeQueueWeb(symbol);
    return;
  }
  if (slot?.entry.status === "failed" && age < FAILED_RETRY_MS) return;
  if (slot?.entry.status !== "ok") setEntry(symbol, { status: "loading" });
  pending.add(symbol);
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// 依比例排序用（關注清單）：不等列捲到畫面，直接對整組台股代號取齊資料。
// ---------------------------------------------------------------------------

export type ChipsRatioPick = "major" | "foreign" | "margin";

function isSettled(symbol: string): boolean {
  const s = store.get(symbol)?.entry.status;
  return s === "ok" || s === "failed";
}

/**
 * 對一組台股代號一次登記（沿用同一個 store／80ms 合併批次／30 分鐘快取，已有的不重打），
 * 回傳的 Promise 在**每一檔都有結果**（成功或失敗）時才 resolve，最多等 timeoutMs。
 * 要依比例排序的呼叫端一定要先 await 這個，才能保證不是拿「只載到一半」的資料去排。
 * 只放台股代號進來（美股沒有這些資料，放進來會被當成查無資料）。
 */
export function ensureChipsRatios(symbols: string[], timeoutMs = 15_000): Promise<void> {
  const list = Array.from(new Set(symbols));
  for (const s of list) request(s, false);
  if (list.every(isSettled)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      anyListeners.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (list.every(isSettled)) done();
    };
    const timer = setTimeout(done, timeoutMs);
    anyListeners.add(check);
  });
}

/** 某檔某項的「本期比例」（排序用）；沒資料（載入中／失敗／查無此項）回 null，不當成 0。 */
export function getChipsRatioValue(symbol: string, pick: ChipsRatioPick): number | null {
  const entry = store.get(symbol)?.entry;
  if (entry?.status !== "ok") return null;
  return entry.data?.[pick]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// 一個共用的 IntersectionObserver：列進到畫面附近時才登記要資料（一次性）。
// ---------------------------------------------------------------------------

const visibleCallbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cb = visibleCallbacks.get(e.target);
        observer?.unobserve(e.target);
        visibleCallbacks.delete(e.target);
        cb?.();
      }
    },
    { rootMargin: "600px 0px" }
  );
  return observer;
}

function observeOnce(el: Element, onVisible: () => void): () => void {
  const obs = getObserver();
  if (!obs) {
    onVisible();
    return () => {};
  }
  visibleCallbacks.set(el, onVisible);
  obs.observe(el);
  return () => {
    visibleCallbacks.delete(el);
    obs.unobserve(el);
  };
}

/**
 * 一列股票用：回傳要掛在 `<tr>` 上的 rowRef（穩定的 callback ref，可與其他 ref 合併）
 * 與這一檔目前的狀態。美股（或 enabled=false）不觀察、不請求，永遠是 idle。
 */
export function useChipsRatioRow(
  symbol: string,
  market: Market,
  opts: { webFallback?: boolean } = {}
): { rowRef: (el: Element | null) => void; entry: ChipsRatioEntry } {
  const enabled = market === "TW";
  const webFallback = !!opts.webFallback;
  const elRef = useRef<Element | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const argsRef = useRef({ symbol, enabled, webFallback });

  const attach = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    const el = elRef.current;
    const { symbol: s, enabled: on, webFallback: web } = argsRef.current;
    if (el && on) cleanupRef.current = observeOnce(el, () => request(s, web));
  }, []);

  const rowRef = useCallback(
    (el: Element | null) => {
      elRef.current = el;
      attach();
    },
    [attach]
  );

  // 代號／開關變了（正常情況列是以代號為 key，不會發生，保險起見）就重新觀察。
  useEffect(() => {
    const prev = argsRef.current;
    argsRef.current = { symbol, enabled, webFallback };
    if (prev.symbol !== symbol || prev.enabled !== enabled || prev.webFallback !== webFallback) attach();
  }, [symbol, enabled, webFallback, attach]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(symbol);
      if (!set) listeners.set(symbol, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    [symbol]
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (enabled ? (store.get(symbol)?.entry ?? IDLE) : IDLE),
    () => IDLE
  );
  return { rowRef, entry };
}

/** 大戶週資料的本週／上一週日期（YYYY-MM-DD），給表頭提示用；還沒拿到回傳前是空的。 */
export function useChipsRatiosMeta(): { majorDate?: string; majorPrevDate?: string } {
  return useSyncExternalStore(
    (cb) => {
      metaListeners.add(cb);
      return () => {
        metaListeners.delete(cb);
      };
    },
    () => meta,
    () => meta
  );
}
