"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import type { Market, SearchItem } from "@/lib/data";
import { formatAmount, formatAmountChange, formatPercent, formatPrice, formatVolume, priceDirectionClass } from "@/lib/format";
import { hasHolding, hasManualUnheldOrder, markManualUnheldOrder, reorderGroup, updateHolding } from "@/lib/watchlist";
import { breakEvenPrice, computeHoldingPnl, investedAmount } from "@/lib/portfolio";
import { FINE_INDUSTRY_HINT, fineIndustryOf, sortByFineIndustry } from "@/lib/fineIndustry";
import WatchlistButton from "./WatchlistButton";

/**
 * 關注清單自己的列型別。跟 `SearchItem` 最大的差別是**報價欄位允許 null**：
 * 關注清單是逐檔打 `/api/quote/<代號>` 的（不是批次清單），某一檔的請求失敗
 * （上游逾時等）時，以前的做法是讓那一檔整列從畫面上消失，使用者會以為自己
 * 的關注清單資料掉了。現在改成照樣渲染那一列、只把數字欄位顯示成「資料暫缺／
 * —」（2026-09-21 根治，取代原本只在 WatchlistSection 重試一次的緩解措施）。
 *
 * 刻意只放寬**這個**型別而不是全站共用的 `SearchItem`：排行榜/搜尋/篩選頁走的
 * 是批次清單，抓不到的股票本來就不會進到清單裡（沒有「該在但不見了」的問題），
 * 讓它們的 price 一起變成 null 只會讓幾十處計算多出無意義的 null 判斷。
 */
export interface WatchlistQuote extends Omit<SearchItem, "price" | "changePercent" | "volume" | "turnover"> {
  /** null＝這一檔目前抓不到報價（含 WatchlistSection 的自動重試也失敗）。 */
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  turnover: number | null;
}

/** 一列＝一檔關注股票的報價 ＋ 使用者自己填的持股資料（localStorage）。 */
export interface HoldingItem extends WatchlistQuote {
  costBasis?: number;
  shares?: number;
  order?: number;
}

/** 抓不到報價時那一列顯示的字樣，與全站「抓不到就誠實說沒有」的慣例一致。 */
const NO_QUOTE_LABEL = "資料暫缺";
const NO_QUOTE_HINT = "這一檔的即時報價暫時抓不到（資料來源逾時等），股票仍在你的關注清單裡，下一輪自動重抓就會恢復";

function byOrder(a: HoldingItem, b: HoldingItem): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

function groupKey(item: HoldingItem): string {
  return `${item.market}:${item.symbol}`;
}

/** 0 when a field is missing/invalid — used for the 總成本/總市值 aggregates
 *  and the held-group sort, where a per-item "—" doesn't make sense to fold
 *  into a sum or a sort key. Per-row display goes through
 *  investedAmount()/computeHoldingPnl() directly instead, so a genuinely
 *  missing value still renders as "—" there, not a silent 0. */
function investedAmountOrZero(item: HoldingItem): number {
  if (item.costBasis == null || item.shares == null) return 0;
  return investedAmount(item.costBasis, item.shares, item.market);
}

/** null（不是 0）＝這一檔沒有報價或沒有持股資料，算不出損益%。排序時 null
 *  一律墊底（見 sortForField）——當成 0% 會讓報價暫缺的股票插在漲跌的正負之間，
 *  看起來像真的「不漲不跌」。 */
function pnlPercentOrNull(item: HoldingItem): number | null {
  if (item.costBasis == null || item.shares == null || item.price == null) return null;
  return computeHoldingPnl(item.price, item.costBasis, item.shares, item.market).pnlPercent;
}

/** 「依產業」不是數值指標，所以不能跟其他三個一樣用 metric 相減比較——它走
 *  lib/fineIndustry.ts 的族群順序，也沒有「高→低／低→高」的意義。 */
type HeldSortField = "investedAmount" | "changePercent" | "pnlPercent" | "fineIndustry";
const HELD_SORT_METRICS: Record<Exclude<HeldSortField, "fineIndustry">, (item: HoldingItem) => number | null> = {
  investedAmount: investedAmountOrZero,
  changePercent: (item) => item.changePercent,
  pnlPercent: pnlPercentOrNull,
};

function sortForField(items: HoldingItem[], field: HeldSortField, dir: "asc" | "desc"): HoldingItem[] {
  if (field === "fineIndustry") return sortByFineIndustry(items);
  const metric = HELD_SORT_METRICS[field];
  return [...items].sort((a, b) => {
    const av = metric(a);
    const bv = metric(b);
    // 算不出數字的（報價暫缺）兩個方向都墊底，不參與大小比較——否則 null 會
    // 被當成 NaN 讓整個排序結果變得不可預期。
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    return dir === "desc" ? bv - av : av - bv;
  });
}

/**
 * Watchlist-specific table (not the shared StockTable): adds editable
 * 持有股數/購買價格 so a holding's unrealized P&L can be computed and shown,
 * plus (per a user request) splits into two drag-reorderable groups — 持有中
 * (real shares > 0 and a purchase price on file) always rendered above
 * 僅關注 (watch-only) — so holdings stay visually prioritized. Dragging is
 * confined to within one group; an item only ever changes groups
 * automatically, by filling in or clearing its holding info in
 * updateHolding(). Editing writes straight to localStorage — there's no
 * separate "save" step, matching how the ☆ button already works elsewhere.
 */
export default function WatchlistTable({ items, emptyLabel }: { items: HoldingItem[]; emptyLabel?: string }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-(--text-muted)">{emptyLabel ?? "沒有符合條件的股票"}</p>;
  }

  const held = items.filter(hasHolding).sort(byOrder);
  // 僅關注那一組的「預設順序」= 依細分產業分組（使用者要求：同產業的排在一起，
  // 不要照加入清單的先後散亂排列）。只有在使用者**真的親手排過**這個市場的
  // 僅關注清單之後（拖曳或按過「依產業排序」，見 lib/watchlist.ts 的
  // hasManualUnheldOrder），才改回完全照 order 顯示——否則每次重新整理都會把
  // 使用者剛調好的順序強制打回產業排序。
  const unheldItems = items.filter((i) => !hasHolding(i));
  const market = items[0].market; // 一張表只會有同一個市場（上層已用 MarketTabs 分開）
  const unheld = hasManualUnheldOrder(market) ? unheldItems.sort(byOrder) : sortByFineIndustry(unheldItems);

  // 總成本 includes the buy-side commission actually paid (TW only — see
  // lib/portfolio.ts), so it's real money spent, not just 購買價格×股數.
  // 總市值 stays the plain gross valuation (股價×股數) — the conventional
  // meaning of "market value", not a liquidation-proceeds figure. 總損益 is
  // the sum of each row's own fee-aware 損益 (which also nets out the
  // SELL-side commission/tax) rather than 總市值-總成本: those two totals
  // mix a gross figure with a fee-inclusive one, so subtracting them
  // wouldn't match summing the individually-correct per-row numbers — a
  // small, expected gap (the not-yet-incurred sell-side friction), not a
  // bug in either total.
  //
  // 報價暫缺（price === null）的那幾檔算不出市值與損益，所以 總市值/總損益 只
  // 加總「有報價」的那幾檔，並在旁邊標明有幾檔沒計入——直接把它們當 0 元會讓
  // 總市值/總損益 默默少一大塊，比誠實說「有幾檔暫缺」危險得多。
  // 總成本 不受影響照樣算全部：那是已經花掉的錢，跟抓不抓到現價無關。
  // 百分比的分母則刻意只取「有報價那幾檔的成本」（pricedCost），這樣分子分母
  // 是同一批股票，不會出現「分子少一檔、分母多一檔」的失真百分比。
  const priced = held.filter((i) => i.price != null);
  const missingQuoteCount = held.length - priced.length;
  const totalCost = held.reduce((sum, i) => sum + investedAmount(i.costBasis!, i.shares!, i.market), 0);
  const pricedCost = priced.reduce((sum, i) => sum + investedAmount(i.costBasis!, i.shares!, i.market), 0);
  const totalValue = priced.reduce((sum, i) => sum + i.price! * i.shares!, 0);
  const totalPnl = priced.reduce((sum, i) => sum + (computeHoldingPnl(i.price!, i.costBasis!, i.shares!, i.market).pnl ?? 0), 0);
  const currency = held[0]?.market === "TW" ? "TWD" : "USD";

  return (
    <div className="space-y-4">
      {held.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm">
          <span>
            <span className="text-(--text-muted)">總成本：</span>
            <span className="font-medium tabular-nums">{formatAmount(totalCost, currency)}</span>
          </span>
          <span>
            <span className="text-(--text-muted)">總市值：</span>
            <span className="font-medium tabular-nums">{priced.length > 0 ? formatAmount(totalValue, currency) : "—"}</span>
          </span>
          <span>
            <span className="text-(--text-muted)">總損益：</span>
            {priced.length > 0 ? (
              <span className={`font-semibold tabular-nums ${priceDirectionClass(totalPnl)}`}>
                {formatAmountChange(totalPnl, currency)}
                {" "}({pricedCost ? formatPercent((totalPnl / pricedCost) * 100) : "—"})
              </span>
            ) : (
              <span className="font-semibold tabular-nums text-(--text-muted)">—</span>
            )}
          </span>
          {missingQuoteCount > 0 && (
            <span className="text-xs text-(--text-muted)" title={NO_QUOTE_HINT}>
              （{missingQuoteCount} 檔報價暫缺，未計入總市值／總損益）
            </span>
          )}
        </div>
      )}
      {/* On a narrow (mobile) screen this table is wider than the viewport —
          overflow-x-auto below makes it scrollable, but a plain scrollable
          <table> with no visual cue looks identical to a fully-visible one,
          so most people never discover the swipe. A user reported being
          unable to clear a holding's 平均成本 at all; the field was never
          broken, it was just off-screen with nothing telling them to swipe
          to reach it (persistent-成本欄位不可見, silent-cut-off-columns).
          A persistent hint (not scroll-triggered — those get missed on a
          quick glance) makes the swipe discoverable without redesigning the
          table into a stacked mobile layout. sm: hides it once the table
          actually fits without scrolling. */}
      <p className="text-[13px] text-(--text-muted) sm:hidden">← 可左右滑動查看持有股數／購買價格／損益 →</p>
      {held.length > 0 && <DraggableGroup title="持有中" items={held} sortable market={held[0].market} group="held" />}
      <DraggableGroup title={held.length > 0 ? "僅關注（未持有）" : undefined} items={unheld} market={market} group="unheld" />
    </div>
  );
}

/** One drag-reorderable group (either all-held or all-watch-only — never
 *  mixed, since reorderGroup() only makes sense compared within one group).
 *  Dragging is implemented with the Pointer Events API (not native HTML5
 *  drag-and-drop, which doesn't fire on touch) so the same code works with
 *  mouse and touch alike: the drag handle captures the pointer on press, and
 *  as it moves the dragged row is spliced past whichever sibling's vertical
 *  midpoint it has crossed — a live "swap as you pass" reorder rather than a
 *  cursor-following floating clone, which is simpler to get right and
 *  plenty for a short personal watchlist. `sortable` (held group only) adds
 *  a quick "sort by X, high/low" control that writes its result straight
 *  into the same persisted order a drag would — a one-shot bulk rearrange
 *  that further drags can then fine-tune, not a separate always-on mode. */
function DraggableGroup({
  title,
  items,
  sortable = false,
  market,
  group,
}: {
  title?: string;
  items: HoldingItem[];
  sortable?: boolean;
  market?: Market;
  /** 這一組是持有中還是僅關注——決定要不要在拖曳後記下「使用者手動排過」
   *  （只有僅關注那組有「沒排過就預設依產業排序」的行為需要區分）。 */
  group: "held" | "unheld";
}) {
  const [order, setOrder] = useState<string[]>(() => items.map(groupKey));
  const [sortField, setSortField] = useState<HeldSortField>("investedAmount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const draggingKeyRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const byKey = new Map(items.map((i) => [groupKey(i), i]));

  // Re-sync from the persisted/live-refreshed items whenever they change —
  // except mid-drag, where the in-progress visual order takes precedence
  // over whatever the last quote-poll tick recomputed from localStorage.
  useEffect(() => {
    if (draggingKeyRef.current) return;
    setOrder(items.map(groupKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map(groupKey).join(",")]);

  function handlePointerDown(e: ReactPointerEvent<HTMLButtonElement>, key: string) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingKeyRef.current = key;
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const dragKey = draggingKeyRef.current;
    if (!dragKey) return;
    const y = e.clientY;
    let overIndex = order.length - 1;
    for (let i = 0; i < order.length; i++) {
      const el = rowRefs.current.get(order[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        overIndex = i;
        break;
      }
    }
    const fromIndex = order.indexOf(dragKey);
    if (fromIndex === -1 || fromIndex === overIndex) return;
    const next = [...order];
    next.splice(fromIndex, 1);
    next.splice(overIndex, 0, dragKey);
    setOrder(next);
  }

  /** 把這次排出來的順序寫進 localStorage；僅關注那組同時記下「使用者親手排過」，
   *  之後就不再套用預設的依產業排序，改為完全尊重使用者排的結果。 */
  function persistOrder(ordered: HoldingItem[]) {
    reorderGroup(ordered);
    if (group === "unheld" && market) markManualUnheldOrder(market);
  }

  function handlePointerUp() {
    const dragKey = draggingKeyRef.current;
    draggingKeyRef.current = null;
    if (!dragKey) return;
    const ordered = order.map((k) => byKey.get(k)).filter((i): i is HoldingItem => i != null);
    persistOrder(ordered);
  }

  function applySort(field: HeldSortField, dir: "asc" | "desc") {
    setSortField(field);
    setSortDir(dir);
    const sorted = sortForField(items, field, dir);
    setOrder(sorted.map(groupKey));
    persistOrder(sorted);
  }

  if (items.length === 0) return null;

  // 只有一檔時排序沒有意義，按鈕只會變成誤導（按了畫面完全沒變）。
  const showIndustryButton = group === "unheld" && items.length > 1;

  return (
    <div>
      {/* 手機寬度下標題與排序控制項會擠在一起，所以用 flex-wrap＋gap 讓控制項
          整組掉到下一行，而不是硬擠成一列把按鈕文字壓到換行。整列都沒東西時
          （沒標題、沒排序控制項）整個 header 不渲染，免得留一條空白間距。 */}
      {(title || sortable || showIndustryButton) && (
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {title && <h3 className="text-xs font-semibold text-(--text-muted)">{title}</h3>}
        {sortable && (
          <div className="ml-auto flex items-center gap-1.5">
            <select
              value={sortField}
              onChange={(e) => applySort(e.target.value as HeldSortField, sortDir)}
              className="rounded-md border border-(--gridline) bg-(--surface-2) px-1.5 py-0.5 text-xs"
              title={sortField === "fineIndustry" ? FINE_INDUSTRY_HINT : undefined}
            >
              <option value="investedAmount">依投資金額</option>
              <option value="changePercent">依漲跌幅</option>
              <option value="pnlPercent">依損益%</option>
              <option value="fineIndustry">依產業</option>
            </select>
            {/* 依產業沒有「高→低」的意義（族群順序不是數值），所以這顆方向鈕
                只在數值型排序時出現，改附上分類來源說明。 */}
            {sortField === "fineIndustry" ? (
              <span className="text-[11px] text-(--text-muted)" title={FINE_INDUSTRY_HINT}>
                （分類為本站整理）
              </span>
            ) : (
              <button
                type="button"
                onClick={() => applySort(sortField, sortDir === "desc" ? "asc" : "desc")}
                className="rounded-md border border-(--gridline) bg-(--surface-2) px-1.5 py-0.5 text-xs"
                title="切換排序方向"
              >
                {sortDir === "desc" ? "高→低" : "低→高"}
              </button>
            )}
          </div>
        )}
        {/* 僅關注這組沒有持股數字可排，但使用者要能一鍵把清單重新依產業分組
            （例如之前手動拖過、現在想改回產業排序）。按下去等同一次性的手動
            排序：會寫進 order、之後照樣可以再拖曳微調，不是鎖定模式。 */}
        {showIndustryButton && (
          <button
            type="button"
            onClick={() => applySort("fineIndustry", "desc")}
            className="ml-auto rounded-md border border-(--gridline) bg-(--surface-2) px-1.5 py-0.5 text-xs hover:bg-(--page-plane)"
            title={FINE_INDUSTRY_HINT}
          >
            依產業排序
          </button>
        )}
      </div>
      )}
      <div className="overflow-x-auto">
        <table className={`w-full text-sm ${sortable ? "min-w-[960px]" : "min-w-[800px]"}`}>
          <thead>
            <tr className="border-b border-(--gridline) text-left text-(--text-muted)">
              <th className="w-6" />
              <th className="w-8" />
              <th className="py-2 pr-4 font-medium">代碼 / 名稱</th>
              <th className="py-2 pr-4 font-medium" title={FINE_INDUSTRY_HINT}>
                產業
              </th>
              <th className="py-2 pr-4 font-medium text-right">股價</th>
              <th className="py-2 pr-4 font-medium text-right">漲跌幅</th>
              <th className="py-2 pr-4 font-medium text-right">成交量</th>
              <th className="py-2 pr-4 font-medium text-right">持有股數</th>
              <th className="py-2 pr-4 font-medium text-right">購買價格</th>
              {sortable && (
                <th
                  className="py-2 pr-4 font-medium text-right"
                  title={
                    market === "TW"
                      ? "假設買賣手續費各0.1425%、賣出證券交易稅0.3%（一般網路券商常見費率，實際依個人開戶條件為準），無條件進位到分— 股價達到此價才保證真正扣除成本後不虧"
                      : "美股各券商手續費結構差異大（不少已是免手續費），暫不試算，直接以購買價格顯示"
                  }
                >
                  損益平衡價
                </th>
              )}
              {sortable && (
                <th
                  className="py-2 pr-4 font-medium text-right"
                  title={market === "TW" ? "購買價格×股數，已計入買進手續費0.1425%（捨去到整數元，與券商實際計費方式一致）" : "購買價格×股數"}
                >
                  投資金額
                </th>
              )}
              <th
                className="py-2 pr-4 font-medium text-right"
                title={
                  market === "TW"
                    ? "以現在股價全部賣出、扣掉賣出手續費0.1425%與證交稅0.3%（皆捨去到整數元）後的淨收入，減去投資金額（已含買進手續費）"
                    : "(現在股價－購買價格)×股數"
                }
              >
                損益
              </th>
            </tr>
          </thead>
          <tbody>
            {order.map((key) => {
              const item = byKey.get(key);
              if (!item) return null;
              return (
                <HoldingRow
                  key={key}
                  item={item}
                  showHoldingColumns={sortable}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(key, el);
                    else rowRefs.current.delete(key);
                  }}
                  onHandlePointerDown={(e) => handlePointerDown(e, key)}
                  onHandlePointerMove={handlePointerMove}
                  onHandlePointerUp={handlePointerUp}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HoldingRow({
  item,
  showHoldingColumns,
  rowRef,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
}: {
  item: HoldingItem;
  showHoldingColumns: boolean;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const [shares, setShares] = useState(item.shares?.toString() ?? "");
  const [costBasis, setCostBasis] = useState(item.costBasis?.toString() ?? "");
  const currency = item.market === "TW" ? "TWD" : "USD";

  function commit() {
    const sharesNum = shares.trim() === "" ? undefined : Number(shares);
    const costNum = costBasis.trim() === "" ? undefined : Number(costBasis);
    updateHolding(item.symbol, item.market, {
      shares: sharesNum != null && Number.isFinite(sharesNum) && sharesNum >= 0 ? sharesNum : undefined,
      costBasis: costNum != null && Number.isFinite(costNum) && costNum >= 0 ? costNum : undefined,
    });
  }

  // 2026-09-21 Opus 規則二實測抓到的真實bug：填好持有股數/購買價格後，如果在
  // 欄位還focus著的狀態下就按F5重新整理（沒有先點別的地方讓欄位blur），輸入的
  // 購買價格會完全不見——因為原本唯一的寫入時機是 onBlur，使用者打完字但還沒
  // blur 就離開頁面，這次輸入就從沒真正寫進 localStorage 過。這跟這個元件自己
  // 註解宣稱的「編輯直接寫進localStorage、沒有另外的儲存步驟」設計本身矛盾——
  // 打完字之後應該很快就自動存檔，不該要靠使用者剛好做了「跳到下一格」這個
  // 動作才存到。改成打完字停下來一小段時間後自動存檔（debounce，不是每個按鍵
  // 都存，避免每敲一下就寫一次localStorage並觸發全清單重繪），onBlur 繼續保留
  // 當作「立刻跳到下一格」時的即時儲存，兩者互不衝突。
  useEffect(() => {
    const timer = setTimeout(commit, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit 是純粹讀 shares/costBasis 算出結果再呼叫 updateHolding，這兩個已經是效果真正的依賴
  }, [shares, costBasis]);

  const sharesNum = Number(shares);
  const costNum = Number(costBasis);
  const hasHoldingInput = shares.trim() !== "" && costBasis.trim() !== "" && Number.isFinite(sharesNum) && Number.isFinite(costNum);
  // Zero (or blank) 購買價格 makes a *percentage* undefined (dividing by
  // zero) even though the absolute 損益 can still be a perfectly real
  // number — rendering used to force this through a non-null assertion
  // assuming "pnl exists" implied "pnlPercent exists too", which crashed
  // formatPercent(null) the moment someone actually typed 0 as a cost basis
  // (a user hit this live: the page broke and stayed broken on reload,
  // since the bad value was already persisted to localStorage). Now shown
  // as "—" instead of asserted away. computeHoldingPnl() itself already
  // returns { pnl: null, pnlPercent: null } for a non-positive cost basis.
  // 現價抓不到（item.price === null）時損益同樣無法計算，一律顯示「—」——
  // 持股數字還是照樣留在輸入框裡可以編輯，不會因為報價暫缺就不能改持股。
  const { pnl, pnlPercent } = hasHoldingInput && item.price != null
    ? computeHoldingPnl(item.price, costNum, sharesNum, item.market)
    : { pnl: null, pnlPercent: null };
  const breakEven = hasHoldingInput ? breakEvenPrice(costNum, sharesNum, item.market) : null;
  const invested = hasHoldingInput ? investedAmount(costNum, sharesNum, item.market) : null;

  return (
    <tr ref={rowRef} className="border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
      <td className="py-2.5 pl-1">
        <button
          type="button"
          aria-label={`拖曳調整 ${item.name} 的順序`}
          title="拖曳調整順序"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          style={{ touchAction: "none" }}
          className="flex h-6 w-6 cursor-grab select-none items-center justify-center rounded text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text-secondary) active:cursor-grabbing"
        >
          ⠿
        </button>
      </td>
      <td className="py-2.5 pl-1">
        <WatchlistButton symbol={item.symbol} market={item.market} name={item.name} />
      </td>
      <td className="py-2.5 pr-4">
        <Link href={`/stock/${item.symbol}?market=${item.market}`} className="font-medium hover:text-(--accent)">
          {item.name}
          <span className="ml-1.5 text-(--text-muted) tabular-nums">{item.symbol}</span>
        </Link>
        <span className="ml-2 rounded bg-(--page-plane) px-1.5 py-0.5 text-[12px] text-(--text-muted)">
          {item.market === "TW" ? "台股" : "美股"}
        </span>
      </td>
      <td className="py-2.5 pr-4 text-(--text-secondary)">{fineIndustryOf(item)}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums">
        {item.price != null ? (
          formatPrice(item.price, currency)
        ) : (
          <span className="text-xs whitespace-nowrap text-(--text-muted)" title={NO_QUOTE_HINT}>
            {NO_QUOTE_LABEL}
          </span>
        )}
      </td>
      <td
        className={`py-2.5 pr-4 text-right font-medium tabular-nums ${
          item.changePercent != null ? priceDirectionClass(item.changePercent) : "text-(--text-muted)"
        }`}
      >
        {item.changePercent != null ? formatPercent(item.changePercent) : "—"}
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-secondary)">
        {item.volume != null ? formatVolume(item.volume, item.market) : "—"}
      </td>
      <td className="py-2.5 pr-4 text-right">
        <input
          type="number"
          min="0"
          value={shares}
          onChange={(e) => setShares(e.target.value)}
          onBlur={commit}
          placeholder="—"
          className="w-20 rounded border border-(--gridline) bg-(--surface-2) px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
      </td>
      <td className="py-2.5 pr-4 text-right">
        <input
          type="number"
          min="0"
          step="0.01"
          value={costBasis}
          onChange={(e) => setCostBasis(e.target.value)}
          onBlur={commit}
          placeholder="—"
          className="w-20 rounded border border-(--gridline) bg-(--surface-2) px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
      </td>
      {showHoldingColumns && (
        <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-secondary)">
          {breakEven != null ? formatPrice(breakEven, currency) : "—"}
        </td>
      )}
      {showHoldingColumns && (
        <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-secondary)">
          {invested != null ? formatAmount(invested, currency) : "—"}
        </td>
      )}
      <td className={`py-2.5 pr-4 text-right tabular-nums ${pnl != null ? priceDirectionClass(pnl) : "text-(--text-muted)"}`}>
        {pnl != null ? (
          <>
            {formatAmountChange(pnl, currency)}
            {pnlPercent != null && <span className="ml-1 text-xs">({formatPercent(pnlPercent)})</span>}
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
