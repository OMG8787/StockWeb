"use client";

import { useEffect, useRef, useState } from "react";
import StockTable from "@/components/StockTable";
import MarketTabs from "@/components/MarketTabs";
import MarketStatusBadge from "@/components/MarketStatusBadge";
import { getMarketStatus, type MarketStatus } from "@/lib/marketStatus";
import type { Market, SearchItem, VolumeTrend } from "@/lib/data";
import type { ChipsRatiosBatchResponse } from "@/lib/chipsRatiosList";
import { seedChipsRatios } from "@/lib/useChipsRatios";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";

// 一頁筆數：排序／篩選仍在伺服器對全市場完成，前端一次只渲染這麼多列，往下捲或按
// 「顯示更多」再取下一批（2026-10-05：一次渲染約 2,000 列＋375KB 回應，最後一個區塊
// 要 5.2 秒才出現）。
const PAGE_SIZE = 100;

interface SearchPage {
  items: SearchItem[];
  total?: number;
  snapshot?: string;
  /** 只有 withChips=1 且伺服器在時限內查到時才有；沒有就由各列自己漸進載入。 */
  chips?: ChipsRatiosBatchResponse;
}

// Short enough that a filter toggle still feels instant, long enough that
// typing a keyword or a price doesn't fire a search per character.
const SEARCH_DEBOUNCE_MS = 250;

// Quick-fill shortcuts for the customizable min/max change% inputs below —
// clicking one just populates those inputs (still freely editable
// afterwards), it's not a separate fixed-choice mechanism of its own.
const CHANGE_SHORTCUTS: Array<{ label: string; min?: number; max?: number }> = [
  { label: "全部" },
  { label: "上漲", min: 0 },
  { label: "下跌", max: 0 },
  { label: "漲幅 > 3%", min: 3 },
  { label: "跌幅 > 3%", max: -3 },
];

const VOLUME_TREND_OPTIONS: Array<{ value: VolumeTrend; label: string }> = [
  { value: "buy-leaning", label: "價漲量增（偏多）" },
  { value: "sell-leaning", label: "價跌量增（偏空）" },
  { value: "neutral", label: "量能不明顯" },
];

type SortBy = "changePercent" | "volume" | "price" | "turnover" | "major" | "foreign" | "margin" | "short";
type SortDir = "asc" | "desc";

export default function SearchClient() {
  const [query, setQuery] = useState("");
  const [minChangePercent, setMinChangePercent] = useState("");
  const [maxChangePercent, setMaxChangePercent] = useState("");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">搜尋 / 篩選股票</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">台股、美股分開顯示，各自可依產業、股價、成交量、成交金額、漲跌幅、價量關係篩選；台股另可依大戶／外資／融資／融券比例排序。</p>
      </div>

      <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4 space-y-4">
        <div className="flex flex-wrap gap-4">
          <Field label="關鍵字（套用到台股與美股）">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="代碼或名稱"
              className="rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1.5 text-sm w-56"
            />
          </Field>

          <Field label="漲跌幅 %（自訂區間，可只填一邊）">
            <div className="flex items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                placeholder="最低"
                value={minChangePercent}
                onChange={(e) => setMinChangePercent(e.target.value)}
                className="w-20 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1.5 text-sm"
              />
              <span className="text-(--text-muted)">–</span>
              <input
                type="number"
                inputMode="decimal"
                placeholder="最高"
                value={maxChangePercent}
                onChange={(e) => setMaxChangePercent(e.target.value)}
                className="w-20 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1.5 text-sm"
              />
            </div>
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          {CHANGE_SHORTCUTS.map((s) => (
            <button
              key={s.label}
              onClick={() => {
                setMinChangePercent(s.min !== undefined ? String(s.min) : "");
                setMaxChangePercent(s.max !== undefined ? String(s.max) : "");
              }}
              className="rounded-full px-3 py-1 text-xs font-medium border border-(--gridline) text-(--text-secondary) hover:bg-(--page-plane)"
              title="快速套用到左邊的自訂區間，套用後仍可自行修改"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <MarketTabs
        tw={<MarketSection market="TW" query={query} minChangePercent={minChangePercent} maxChangePercent={maxChangePercent} />}
        us={<MarketSection market="US" query={query} minChangePercent={minChangePercent} maxChangePercent={maxChangePercent} />}
      />
    </div>
  );
}

function MarketSection({
  market,
  query,
  minChangePercent,
  maxChangePercent,
}: {
  market: Market;
  query: string;
  minChangePercent: string;
  maxChangePercent: string;
}) {
  const [sectors, setSectors] = useState<string[]>([]);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [maxVolume, setMaxVolume] = useState("");
  const [minTurnover, setMinTurnover] = useState("");
  const [maxTurnover, setMaxTurnover] = useState("");
  const [volumeTrends, setVolumeTrends] = useState<VolumeTrend[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>("changePercent");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // 分頁用：目前這組篩選的查詢字串（不含分頁參數）、伺服器回的排序快照 id、已載入的列。
  // 「顯示更多」帶同一個快照 id，伺服器切同一份已排序結果，盤中價格變動不會讓下一頁
  // 和前一頁重複或漏股票；快照過期時回傳不同 id，改重載目前已顯示的整段範圍。
  const baseQueryRef = useRef("");
  const snapshotRef = useRef<string | undefined>(undefined);
  const itemsRef = useRef<SearchItem[]>([]);
  const loadingMoreRef = useRef(false);
  const loadMoreCtrlRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 盤中輪詢：與「顯示更多」「換篩選」的競態保護（見 refreshLoaded）。
  const pollCtrlRef = useRef<AbortController | null>(null);
  const searchPendingRef = useRef(true);
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus(market));
  // Tracks whether the search effect below has ever run — see its own
  // comment for why the very first run skips the debounce delay.
  const isFirstRunRef = useRef(true);
  const [sectorOptions, setSectorOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sectors?market=${market}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSectorOptions(data.sectors ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market]);

  useEffect(() => {
    const params = new URLSearchParams({ market, sortBy, sortDir });
    if (sectors.length > 0) params.set("sectors", sectors.join(","));
    if (query) params.set("q", query);
    if (minPrice) params.set("minPrice", minPrice);
    if (maxPrice) params.set("maxPrice", maxPrice);
    if (minVolume) params.set("minVolume", minVolume);
    if (maxVolume) params.set("maxVolume", maxVolume);
    if (minTurnover) params.set("minTurnover", minTurnover);
    if (maxTurnover) params.set("maxTurnover", maxTurnover);
    if (volumeTrends.length > 0) params.set("volumeTrends", volumeTrends.join(","));
    if (minChangePercent) params.set("min", minChangePercent);
    if (maxChangePercent) params.set("max", maxChangePercent);

    // Debounced: the keyword and number boxes re-run this on every
    // keystroke, so typing "2330" used to fire four full searches (and
    // typing a price, one per digit) — each one re-filtering the whole
    // universe server-side — with only the last result ever displayed.
    //
    // The very first run (page just mounted, nothing typed yet) has nothing
    // to debounce against — there's no rapid-fire prior request this delay
    // is protecting against — so it was just adding a flat 250ms of pure
    // waiting before a first-time visitor ever saw a single result. Skipped
    // here; every subsequent run (an actual filter change) still debounces
    // as before.
    const base = params.toString();
    baseQueryRef.current = base;
    loadMoreCtrlRef.current?.abort();
    pollCtrlRef.current?.abort();
    searchPendingRef.current = true;
    // 台股一併把這一頁的籌碼比例帶回來（withChips），列一掛載就直接命中，不必再等
    // 列進到畫面後發第二次請求；美股沒有籌碼資料。
    const firstPageQuery = `${base}&limit=${PAGE_SIZE}${market === "TW" ? "&withChips=1" : ""}`;
    const controller = new AbortController();
    const isFirstRun = isFirstRunRef.current;
    isFirstRunRef.current = false;
    const runSearch = () => {
      fetch(`/api/search?${firstPageQuery}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data: SearchPage) => {
          loadMoreCtrlRef.current?.abort();
          loadingMoreRef.current = false;
          setLoadingMore(false);
          searchPendingRef.current = false;
          applyPage(data, false);
        })
        .catch(() => {});
    };
    if (isFirstRun) {
      runSearch();
      return () => controller.abort();
    }
    const timer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [market, sectors, query, minChangePercent, maxChangePercent, minPrice, maxPrice, minVolume, maxVolume, minTurnover, maxTurnover, volumeTrends, sortBy, sortDir]);

  /** 套用一頁結果：append＝接在目前列後面（以代號去重），否則整份取代。 */
  function applyPage(data: SearchPage, append: boolean) {
    const incoming = data.items ?? [];
    if (data.chips) seedChipsRatios(data.chips);
    let next = incoming;
    if (append) {
      const seen = new Set(itemsRef.current.map((i) => `${i.market}:${i.symbol}`));
      next = [...itemsRef.current, ...incoming.filter((i) => !seen.has(`${i.market}:${i.symbol}`))];
    }
    itemsRef.current = next;
    snapshotRef.current = data.snapshot;
    setItems(next);
    setTotal(data.total ?? next.length);
  }

  async function loadMore() {
    if (loadingMoreRef.current) return;
    const loaded = itemsRef.current.length;
    if (loaded === 0 || loaded >= total) return;
    pollCtrlRef.current?.abort(); // 使用者剛按的「顯示更多」優先，進行中的輪詢作廢
    const base = baseQueryRef.current;
    const chipsParam = market === "TW" ? "&withChips=1" : "";
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const controller = new AbortController();
    loadMoreCtrlRef.current = controller;
    const get = async (query: string): Promise<SearchPage> => {
      const res = await fetch(`/api/search?${base}&${query}`, { signal: controller.signal });
      return res.json();
    };
    try {
      const sent = snapshotRef.current;
      let data = await get(`offset=${loaded}&limit=${PAGE_SIZE}${sent ? `&snapshot=${sent}` : ""}${chipsParam}`);
      if (controller.signal.aborted || baseQueryRef.current !== base) return;
      if (sent && data.snapshot !== sent) {
        // 原本那份排序快照已過期：用新資料把已顯示的整段範圍（加一頁）重新載入，
        // 避免新舊兩份排序拼在一起造成重複或漏股票。
        data = await get(`offset=0&limit=${loaded + PAGE_SIZE}${chipsParam}`);
        if (controller.signal.aborted || baseQueryRef.current !== base) return;
        applyPage(data, false);
      } else {
        applyPage(data, true);
      }
    } catch {
      // 網路錯誤／被取消：保留目前已顯示的列，使用者可再按「顯示更多」。
    } finally {
      if (loadMoreCtrlRef.current === controller) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }
  /**
   * 盤中輪詢：以最新資料重抓第一頁起、長度＝目前已載入列數（不帶快照 id，伺服器 10 秒內
   * 共用同一份、過期就整份重排），整段取代並重新排序，不只更新數字。列以代號為 key、
   * 列數不變，瀏覽器捲動位置不會跳動。競態規則（以最後一次使用者操作為準）：
   * 換篩選尚未回來／「顯示更多」進行中 → 這輪略過；輪詢進行中使用者按顯示更多或換篩選 → 輪詢作廢。
   */
  async function refreshLoaded() {
    const loaded = itemsRef.current.length;
    if (loaded === 0 || searchPendingRef.current || loadingMoreRef.current) return;
    const base = baseQueryRef.current;
    pollCtrlRef.current?.abort();
    const controller = new AbortController();
    pollCtrlRef.current = controller;
    const chipsParam = market === "TW" ? "&withChips=1" : "";
    const res = await fetch(`/api/search?${base}&limit=${Math.min(loaded, 5000)}${chipsParam}`, { signal: controller.signal });
    if (!res.ok) return;
    const data: SearchPage = await res.json();
    if (controller.signal.aborted || baseQueryRef.current !== base || loadingMoreRef.current) return;
    if (!Array.isArray(data.items) || data.items.length === 0) return; // 保留最後一次成功的資料
    applyPage(data, false);
  }
  const refreshLoadedRef = useRef(refreshLoaded);
  refreshLoadedRef.current = refreshLoaded;

  // 與首頁 LiveMoversBoard 同一套節奏：台股／美股各依自己的交易時段，盤後不輪詢，背景分頁暫停。
  useLivePolling({
    restartKey: market,
    decide: (now, settledDayKey) => {
      setStatus(getMarketStatus(market, now));
      return getPollDecision(market, now, settledDayKey);
    },
    onFetch: () => refreshLoadedRef.current(),
  });

  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // 往下捲接近表格底部（預留 400px）就自動載入下一批；按鈕保留作為後備。
  // items.length 變動就重新觀察，才能在新增一批後（哨兵仍在視窗內時）接著判斷。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current();
      },
      { rootMargin: "400px 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [items?.length, total, loadingMore]);

  function toggleSector(s: string) {
    setSectors((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  function toggleVolumeTrend(t: VolumeTrend) {
    setVolumeTrends((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SectorMultiSelect options={sectorOptions} selected={sectors} onToggle={toggleSector} onClear={() => setSectors([])} />

        <VolumeTrendMultiSelect selected={volumeTrends} onToggle={toggleVolumeTrend} onClear={() => setVolumeTrends([])} />

        <div className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            placeholder="最低價"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="w-20 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
          <span className="text-(--text-muted)">–</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="最高價"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className="w-20 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
        </div>

        <div className="flex items-center gap-1" title="成交量門檻，台股單位為「股」（例如 10000000 = 1萬張）">
          <input
            type="number"
            inputMode="numeric"
            placeholder="最低量(股)"
            value={minVolume}
            onChange={(e) => setMinVolume(e.target.value)}
            className="w-24 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
          <span className="text-(--text-muted)">–</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="最高量(股)"
            value={maxVolume}
            onChange={(e) => setMaxVolume(e.target.value)}
            className="w-24 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
        </div>

        <div
          className="flex items-center gap-1"
          title={`成交金額門檻，單位${market === "TW" ? "新台幣" : "美元"}（例如 100000000 = ${market === "TW" ? "1億元" : "1億美元"}）；成交金額＝股價×成交量`}
        >
          <input
            type="number"
            inputMode="numeric"
            placeholder="最低金額"
            value={minTurnover}
            onChange={(e) => setMinTurnover(e.target.value)}
            className="w-24 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
          <span className="text-(--text-muted)">–</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="最高金額"
            value={maxTurnover}
            onChange={(e) => setMaxTurnover(e.target.value)}
            className="w-24 rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
        >
          <option value="changePercent">漲跌幅</option>
          <option value="volume">成交量</option>
          <option value="turnover">成交金額</option>
          <option value="price">股價</option>
          {market === "TW" && (
            <>
              <option value="major">大戶持股比例（週）</option>
              <option value="foreign">外資持股比例</option>
              <option value="margin">融資使用率</option>
              <option value="short">融券使用率</option>
            </>
          )}
        </select>
        <button
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          className="rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs"
          title="切換排序方向"
        >
          {sortDir === "desc" ? "高→低" : "低→高"}
        </button>
      </div>

      {items === null ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-(--page-plane)" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-(--text-muted)">
            <MarketStatusBadge status={status} />
            <span>
              共 {total} 筆{items.length < total ? `，已顯示 ${items.length}` : ""}
              {total === 0 ? "（可能是篩選條件過嚴，或即時資料暫時無法取得）" : ""}
            </span>
          </div>
          <StockTable items={items} />
          {items.length < total && (
            <div ref={sentinelRef} className="flex justify-center pt-2">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-md border border-(--gridline) bg-(--surface-2) px-4 py-2 text-sm hover:bg-(--page-plane) disabled:opacity-60"
              >
                {loadingMore ? "載入中…" : `顯示更多（還有 ${total - items.length} 筆）`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VolumeTrendMultiSelect({
  selected,
  onToggle,
  onClear,
}: {
  selected: VolumeTrend[];
  onToggle: (t: VolumeTrend) => void;
  onClear: () => void;
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs">
        價量關係{selected.length > 0 ? `（已選 ${selected.length}）` : "：全部"}
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-(--gridline) bg-(--surface-1) p-2 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[13px] text-(--text-muted)">多選；依「今日量 vs 自身近期均量」推論</span>
          <button onClick={onClear} className="text-[13px] text-(--accent) hover:underline">
            清除
          </button>
        </div>
        {VOLUME_TREND_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-(--page-plane)">
            <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => onToggle(opt.value)} />
            {opt.label}
          </label>
        ))}
        <p className="mt-1 border-t border-(--gridline) pt-1 text-[13px] text-(--text-muted)">
          這是傳統技術分析的價量關係推論（價漲/跌量增），不是真實的委買委賣單成交量統計。這項功能剛上線，均量資料要累積約5個交易日才會準確，這幾天內看到大量股票顯示「量能不明顯」是正常現象、不是故障，之後會逐漸準確。
        </p>
      </div>
    </details>
  );
}

function SectorMultiSelect({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: string[];
  selected: string[];
  onToggle: (s: string) => void;
  onClear: () => void;
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs">
        產業{selected.length > 0 ? `（已選 ${selected.length}）` : "：全部"}
      </summary>
      {/* left-0, not right-0: this is the first (leftmost-in-DOM-order) control
          in a `justify-end` flex-wrap row, so it sits close to the row's own
          left edge — anchoring the dropdown's right edge here (right-0) let a
          192px-wide menu extend left past the viewport on first open (measured
          left: -61.5px at a normal 894px desktop width, not just on mobile).
          Anchoring from the left edge instead only ever extends rightward,
          where this row actually has room. */}
      <div className="absolute left-0 z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-md border border-(--gridline) bg-(--surface-1) p-2 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[13px] text-(--text-muted)">多選產業</span>
          <button onClick={onClear} className="text-[13px] text-(--accent) hover:underline">
            清除
          </button>
        </div>
        {options.map((s) => (
          <label key={s} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-(--page-plane)">
            <input type="checkbox" checked={selected.includes(s)} onChange={() => onToggle(s)} />
            {s}
          </label>
        ))}
      </div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-(--text-muted)">
      {label}
      {children}
    </label>
  );
}
