"use client";

import { useEffect, useRef, useState } from "react";
import StockTable from "@/components/StockTable";
import MarketTabs from "@/components/MarketTabs";
import MarketStatusBadge from "@/components/MarketStatusBadge";
import { getMarketStatus } from "@/lib/marketStatus";
import type { Market, SearchItem, VolumeTrend } from "@/lib/data";

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
    const controller = new AbortController();
    const isFirstRun = isFirstRunRef.current;
    isFirstRunRef.current = false;
    const runSearch = () => {
      fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => setItems(data.items ?? []))
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
              <option value="short">券資比</option>
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
            <MarketStatusBadge status={getMarketStatus(market)} />
            <span>
              共 {items.length} 筆{items.length === 0 ? "（可能是篩選條件過嚴，或即時資料暫時無法取得）" : ""}
            </span>
          </div>
          <StockTable items={items} />
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
