"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import WatchlistTable, { type HoldingItem } from "@/components/WatchlistTable";
import MarketTabs from "@/components/MarketTabs";
import type { Market, Quote, SearchItem } from "@/lib/data";
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
    const { pnl, pnlPercent } = held
      ? computeHoldingPnl(i.price, i.costBasis!, i.shares!, i.market)
      : { pnl: null, pnlPercent: null };
    return [
      i.market === "TW" ? "台股" : "美股",
      i.symbol,
      i.name,
      i.price,
      i.changePercent,
      i.volume,
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

export default function WatchlistSection() {
  const list = useSyncExternalStore(
    subscribe,
    getWatchlist,
    () => EMPTY // server snapshot: localStorage isn't available during SSR
  );
  const [items, setItems] = useState<SearchItem[] | null>(null); // null = not fetched yet for the current list

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
      const results = await Promise.all(
        targets.map(async (w): Promise<SearchItem | null> => {
          // 掛載時如果這裡失敗，這一檔就完全不會出現在畫面上（不是顯示「—」，
          // 是整列消失）——尤其是掛載那一次，因為這是這檔股票第一次出現在
          // items 裡，沒有「保留上次成功資料」這個退路可以用。多數失敗是暫時性
          // 的（例如上游那一刻剛好抽到一次逾時），先在這裡自己重試一次再放棄，
          // 大幅降低使用者會實際遇到「清單少一檔」的機率。這是緩解、不是根治
          // ——如果兩次都失敗，這一檔目前還是會照舊消失；真正根治需要讓
          // HoldingItem 允許 price 為 null 並在畫面顯示「—」，那個改動會牽動
          // WatchlistTable 好幾處數字計算，這次先不動，留在 PROGRESS.md。
          const fetchOnce = async (): Promise<Quote | null> => {
            try {
              const res = await fetch(`/api/quote/${encodeURIComponent(w.symbol)}?market=${w.market}`);
              return res.ok ? await res.json() : null;
            } catch {
              return null;
            }
          };
          let q = await fetchOnce();
          if (!q) {
            await new Promise((r) => setTimeout(r, 1200));
            q = await fetchOnce();
          }
          if (!q) return null;
          // 記下興櫃檔，下一輪的節奏判斷才知道它交易到 15:00（見上面 scopeOf）。
          if (q.board === "emerging") emergingSymbols.current.add(q.symbol.toUpperCase());
          return {
            symbol: q.symbol,
            market: q.market,
            name: q.name,
            sector: "自選",
            price: q.price,
            changePercent: q.changePercent,
            volume: q.volume,
            turnover: q.price * q.volume,
            // This view fetches one quote at a time (/api/quote/[symbol]),
            // not the batched search list that has the trailing-average
            // volume map alongside it (see lib/data/volumeHistory.ts) — so
            // there's genuinely no basis to compute a real volumeTrend here.
            // "neutral" is honest (no signal), not a fabricated guess.
            volumeTrend: "neutral",
          } satisfies SearchItem;
        })
      );
      const fresh = results.filter((r): r is SearchItem => r !== null);
      setItems((prev) => {
        if (ctx.mount || prev === null) return fresh;
        const byKey = new Map(prev.map((i) => [`${i.market}:${i.symbol.toUpperCase()}`, i]));
        for (const item of fresh) byKey.set(`${item.market}:${item.symbol.toUpperCase()}`, item);
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

  return (
    <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
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
