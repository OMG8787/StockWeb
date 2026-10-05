"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import WatchlistTable, { type HoldingItem, type WatchlistQuote } from "@/components/WatchlistTable";
import MarketTabs from "@/components/MarketTabs";
import type { Market } from "@/lib/data";
import type { MarketScope } from "@/lib/marketStatus";
import { getPollDecision, mergePollDecisions, shouldRefreshSymbol } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { breakEvenPrice, computeHoldingPnl, investedAmount } from "@/lib/portfolio";
import {
  hasHolding,
  hasManualUnheldOrder,
  WATCHLIST_CHANGED_EVENT,
  getWatchlist,
  type WatchlistItem,
} from "@/lib/watchlist";
import { sortByFineIndustry } from "@/lib/fineIndustry";
import { ensureChipsRatios } from "@/lib/useChipsRatios";
import {
  QUOTES_BATCH_MAX_SYMBOLS,
  quoteBatchKey,
  type QuoteWithSector,
  type QuotesBatchResponse,
} from "@/lib/quotesBatchApi";

function subscribe(callback: () => void) {
  window.addEventListener(WATCHLIST_CHANGED_EVENT, callback);
  return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, callback);
}

const EMPTY: WatchlistItem[] = [];

/** 跟 WatchlistTable 裡同名的比較函式一致：缺 order 視為 0，讓還沒被拖過的
 *  舊資料維持原本的加入順序。 */
function byOrder(a: HoldingItem, b: HoldingItem): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

/** CSV 欄位刻意跟畫面上的 WatchlistTable 完全對應（含 2026-09-15 那次改版
 *  新增的持有股數/購買價格/損益平衡價/投資金額/損益）——原本只匯出
 *  股價/漲跌幅/成交量，使用者匯出自己的關注清單時，最想留存的持股與損益
 *  資料反而整批遺失。數字一律走 lib/portfolio.ts 的同一組函式，確保
 *  CSV 裡的金額跟畫面上看到的逐格相同，不會出現兩套算法。
 *  僅關注（沒填持股）的那幾檔，這些欄位留空字串而不是 0——空白代表
 *  「沒有這筆資料」，填 0 會被試算表當成真的持有 0 股、成本 0 元。 */
function exportCsv(items: HoldingItem[]) {
  const header = [
    "市場",
    "代碼",
    "名稱",
    "股價",
    "漲跌幅(%)",
    "成交量",
    "狀態",
    "持有股數",
    "購買價格",
    "損益平衡價",
    "投資金額",
    "損益",
    "損益(%)",
  ];
  const rows = items.map((i) => {
    const held = hasHolding(i);
    const breakEven = held ? breakEvenPrice(i.costBasis!, i.shares!, i.market) : null;
    const invested = held ? investedAmount(i.costBasis!, i.shares!, i.market) : null;
    // 報價暫缺（price === null）的那幾檔，股價/漲跌幅/成交量/損益一律留空字串，
    // 跟「僅關注沒填持股」同樣的處理原則：空白＝沒有這筆資料，填 0 會被試算表
    // 當成真的股價 0 元、損益 0 元。
    const { pnl, pnlPercent } = held && i.price != null
      ? computeHoldingPnl(i.price, i.costBasis!, i.shares!, i.market)
      : { pnl: null, pnlPercent: null };
    return [
      i.market === "TW" ? "台股" : "美股",
      i.symbol,
      i.name,
      i.price ?? "",
      i.changePercent ?? "",
      i.volume ?? "",
      held ? "持有中" : "僅關注",
      held ? i.shares! : "",
      held ? i.costBasis! : "",
      breakEven ?? "",
      invested ?? "",
      pnl ?? "",
      pnlPercent ?? "",
    ];
  });
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Some browsers silently drop a non-ASCII `download` attribute and fall
  // back to a bare "download" filename — keep it ASCII-only (the CSV
  // *content* is still full Traditional Chinese, only the filename isn't).
  a.download = `stockradar-watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 一次批次取得多檔報價（超過上限就分批並行）。整批請求失敗時該批每一檔都視為抓不到，
 * 交給呼叫端的「失敗重試一次」處理。
 */
async function fetchQuotesBatch(targets: WatchlistItem[]): Promise<Map<string, QuoteWithSector | null>> {
  const out = new Map<string, QuoteWithSector | null>();
  const chunks: WatchlistItem[][] = [];
  for (let i = 0; i < targets.length; i += QUOTES_BATCH_MAX_SYMBOLS) chunks.push(targets.slice(i, i + QUOTES_BATCH_MAX_SYMBOLS));
  await Promise.all(
    chunks.map(async (group) => {
      try {
        const items = group.map((w) => quoteBatchKey(w.market, w.symbol)).join(",");
        const res = await fetch(`/api/quotes?items=${encodeURIComponent(items)}`);
        if (!res.ok) return;
        const body = (await res.json()) as QuotesBatchResponse;
        for (const [key, q] of Object.entries(body.items)) out.set(key, q);
      } catch {
        // 整批失敗：這批每一檔都留在 out 之外＝抓不到。
      }
    })
  );
  return out;
}

export default function WatchlistSection() {
  const list = useSyncExternalStore(
    subscribe,
    getWatchlist,
    () => EMPTY // server snapshot: localStorage isn't available during SSR
  );
  // null = not fetched yet for the current list。逐檔報價的結果型別是
  // WatchlistQuote（＝允許 price/changePercent/volume/turnover 為 null 的
  // SearchItem），因為抓不到報價的那一檔現在也要照樣留在清單裡顯示「資料暫缺」。
  const [items, setItems] = useState<WatchlistQuote[] | null>(null);

  /**
   * 關注清單裡哪幾檔是興櫃（交易到 15:00，不是 13:30）。
   * localStorage 的 WatchlistItem 只存 market（"TW"/"US"），沒有板別；而且舊資料
   * 也不可能追加。所以改成「抓到報價時順手記下來」——每次掛載一定會先全部抓
   * 一次（fetchOnMount），回來的 Quote.board 就說得出哪幾檔是興櫃，之後幾輪的
   * 節奏判斷就有依據了。用 ref 而不是 state：它只影響下一輪輪詢的判斷，
   * 不需要（也不該）因此重新 render 整張表。
   */
  const emergingSymbols = useRef<Set<string>>(new Set());
  const scopeOf = (w: { market: Market; symbol: string }): MarketScope =>
    w.market === "TW" && emergingSymbols.current.has(w.symbol.toUpperCase()) ? "TW-EMERGING" : w.market;

  // 籌碼比例（大戶／外資／融資／融券）跟報價**同時**發出：原本要等報價回來、表格掛載後
  // WatchlistTable 才去要，整張表最後一段要多等一輪。這裡用關注清單本身（localStorage，
  // 不需要報價）的台股代號直接先登記，走同一個 store／批次 API／前端快取，表格掛載後
  // 的 ensureChipsRatios／逐列登記會直接命中，不會重打。
  const twSymbolsKey = list
    .filter((w) => w.market === "TW")
    .map((w) => w.symbol.toUpperCase())
    .join(",");
  useEffect(() => {
    if (twSymbolsKey) void ensureChipsRatios(twSymbolsKey.split(","));
  }, [twSymbolsKey]);

  // 這份清單會同時混著台股跟美股，兩邊交易時段完全不同，所以刷新節奏是
  // 「各市場各自判斷」：台股 08:30~14:30 每 10 秒重抓、收盤後停、14:40 補一次；
  // 美股維持原本的盤中每 20 秒；興櫃則是自己的 09:00~15:10。掛載那一次一律全部
  // 抓（不分市場、不分開收盤），否則收盤時段打開頁面會永遠停在骨架載入畫面。
  // 沒被重抓的那些（例如台股盤後的台股檔）保留上一次成功的數字，不會被清掉。
  useLivePolling({
    restartKey: list.map((w) => `${w.market}:${w.symbol}`).join(","),
    fetchOnMount: true,
    decide: (now, settledDayKey) => {
      const scopes = Array.from(new Set(list.map(scopeOf)));
      return mergePollDecisions(scopes.map((s) => getPollDecision(s, now, settledDayKey)));
    },
    onFetch: async (ctx) => {
      if (list.length === 0) return;
      const targets = list.filter((w) => shouldRefreshSymbol(scopeOf(w), ctx.now, ctx));
      if (targets.length === 0) return;
      // 2026-10-04 改成一次批次（/api/quotes，見 lib/data/quoteBatch.ts）：原本逐檔打
      // /api/quote/[symbol]，表格要 4~6 秒才完整出現。抓失敗的檔**不回 null**（回 null
      // 會讓它整列從畫面上消失，使用者以為關注清單資料掉了）：失敗的那幾檔 1.2 秒後再
      // 用同一支批次 API 重試一次（多數失敗是上游那一刻剛好逾時，伺服器端失敗只快取 1 秒，
      // 重試會真的重抓），兩次都失敗才回報價欄位全為 null 的「佔位列」，由 WatchlistTable
      // 顯示「資料暫缺」——名稱/代號/市場用 localStorage 的關注清單資料。產業別由伺服器端
      // 查官方股票清單附加（client 端不能 import findInUniverse：那個模組圖會把 node:tls
      // 之類 server-only 依賴拉進瀏覽器 bundle，實測 build 會失敗）。
      let quotes = await fetchQuotesBatch(targets);
      const failed = targets.filter((w) => !quotes.get(quoteBatchKey(w.market, w.symbol)));
      if (failed.length > 0) {
        await new Promise((r) => setTimeout(r, 1200));
        const retried = await fetchQuotesBatch(failed);
        quotes = new Map([...quotes, ...Array.from(retried).filter(([, q]) => q)]);
      }
      const results = targets.map((w): WatchlistQuote => {
        const q = quotes.get(quoteBatchKey(w.market, w.symbol));
        if (!q) {
          return {
            symbol: w.symbol,
            market: w.market,
            name: w.name,
            sector: "自選",
            price: null,
            changePercent: null,
            volume: null,
            turnover: null,
            volumeTrend: "neutral",
          } satisfies WatchlistQuote;
        }
        // 記下興櫃檔，下一輪的節奏判斷才知道它交易到 15:00（見上面 scopeOf）。
        if (q.board === "emerging") emergingSymbols.current.add(q.symbol.toUpperCase());
        return {
          symbol: q.symbol,
          market: q.market,
          name: q.name,
          sector: q.sector || "自選",
          price: q.price,
          changePercent: q.changePercent,
          volume: q.volume,
          turnover: q.price * q.volume,
          // 這裡是單檔報價，沒有搜尋列表那份「近期平均量」可比，算不出真的
          // volumeTrend（見 lib/data/volumeHistory.ts）；"neutral" 是誠實的「沒有訊號」。
          volumeTrend: "neutral",
        } satisfies WatchlistQuote;
      });
      setItems((prev) => {
        const keyOf = (i: WatchlistQuote) => `${i.market}:${i.symbol.toUpperCase()}`;
        const prevByKey = new Map((prev ?? []).map((i) => [keyOf(i), i]));
        // 這一輪失敗、但上一輪有抓到過的那幾檔，沿用上一次成功的數字而不是
        // 直接降級成「資料暫缺」——單一輪的暫時性失敗不該讓已經在畫面上的
        // 數字閃成空白（跟收盤後不重抓時「保留上次成功資料」的行為一致）。
        // 只有從頭到現在都沒抓到過的那幾檔才真的顯示「資料暫缺」。
        const merged = results.map((item) => {
          if (item.price != null) return item;
          const old = prevByKey.get(keyOf(item));
          return old?.price != null ? old : item;
        });
        if (ctx.mount || prev === null) return merged;
        const byKey = new Map(prevByKey);
        for (const item of merged) byKey.set(keyOf(item), item);
        return Array.from(byKey.values());
      });
    },
  });

  // Filtered against the *current* list (not just whatever the last fetch
  // returned) so removing every watched stock immediately clears the sort/
  // export controls and the export button, instead of them lingering with
  // stale data from before the list was emptied.
  // Uppercased on both sides: stored watchlist entries are always written
  // uppercase by WatchlistButton, but comparing case-insensitively means a
  // stray lowercase entry (e.g. hand-edited localStorage) degrades to
  // "unavailable" for that one symbol instead of silently dropping it here
  // while a real quote for it was actually fetched successfully.
  const holdingByKey = new Map(list.map((w) => [`${w.market}:${w.symbol.toUpperCase()}`, w]));
  const displayItemsRaw: HoldingItem[] = (items ?? [])
    .filter((i) => holdingByKey.has(`${i.market}:${i.symbol.toUpperCase()}`))
    .map((i) => {
      const holding = holdingByKey.get(`${i.market}:${i.symbol.toUpperCase()}`);
      return { ...i, costBasis: holding?.costBasis, shares: holding?.shares, order: holding?.order };
    })
    ;

  // Held-first, then each group in the same order WatchlistTable renders it —
  // so the CSV export (which uses this same array) comes out in the order the
  // user actually sees on screen. The 僅關注 group's default is the curated
  // fine-industry grouping (lib/fineIndustry.ts) until the user has actually
  // dragged/sorted it themselves on that market, which is exactly the rule
  // WatchlistTable applies; keeping the two in sync is what stops the CSV
  // from silently coming out in a different order than the table.
  const heldItems = displayItemsRaw.filter(hasHolding).sort(byOrder);
  const unheldItems = (["TW", "US"] as Market[]).flatMap((m) => {
    const group = displayItemsRaw.filter((i) => !hasHolding(i) && i.market === m);
    return hasManualUnheldOrder(m) ? group.sort(byOrder) : sortByFineIndustry(group);
  });
  const displayItems: HoldingItem[] = [...heldItems, ...unheldItems];

  // xl（>=1280px）時比主內容欄（max-w-6xl）更寬：關注清單欄位多，桌機要一次全部顯示、不用橫向捲動。
  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4 xl:ml-[calc((100%-min(100vw-2rem,1760px))/2)] xl:w-[min(calc(100vw-2rem),1760px)]">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">我的關注</h2>
        {displayItems.length > 0 && (
          <button
            onClick={() => exportCsv(displayItems)}
            className="rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs hover:bg-(--page-plane)"
            title="匯出成 CSV"
          >
            匯出 CSV
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-(--text-muted)">
          點股票列表或個股頁面的 ☆ 即可加入關注清單，方便下次快速查看
        </p>
      ) : items === null ? (
        <div className="space-y-2">
          {Array.from({ length: Math.min(list.length, 4) }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-(--page-plane)" />
          ))}
        </div>
      ) : displayItems.length === 0 ? (
        <div className="py-4">
          <p className="text-center text-sm text-(--text-muted)">目前無法取得關注股票的即時報價，可能是資料來源暫時無法連線</p>
          <ul className="mt-3 flex flex-wrap justify-center gap-2 text-xs text-(--text-secondary)">
            {list.map((w) => (
              <li key={`${w.market}:${w.symbol}`} className="rounded-full border border-(--gridline) px-2.5 py-1">
                {w.name}（{w.symbol}）
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <MarketTabs
          tw={<WatchlistTable items={displayItems.filter((i) => i.market === "TW")} emptyLabel="尚未關注任何台股" />}
          us={<WatchlistTable items={displayItems.filter((i) => i.market === "US")} emptyLabel="尚未關注任何美股" />}
        />
      )}
    </section>
  );
}
