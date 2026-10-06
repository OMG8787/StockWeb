"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import type { Market, SearchItem } from "@/lib/data";
import { formatAmount, formatAmountChange, formatPercent, formatPrice, formatVolume, priceDirectionClass } from "@/lib/format";
import { hasHolding, hasManualUnheldOrder, hasSoldState, markManualUnheldOrder, reorderGroup, updateHolding } from "@/lib/watchlist";
import type { SaleRecord } from "@/lib/soldRecords";
import { visibleSales } from "@/lib/soldRecords";
import SoldTable from "./SoldTable";
import { breakEvenPrice, computeHoldingPnl, investedAmount } from "@/lib/portfolio";
import { FINE_INDUSTRY_HINT, fineIndustryOf, sortByFineIndustry } from "@/lib/fineIndustry";
import { ensureChipsRatios, getChipsRatioValue, useChipsRatioRow, type ChipsRatioPick } from "@/lib/useChipsRatios";
import { CHIPS_RATIO_PICKS } from "@/lib/chipsRatiosList";
import { ChipsRatioCells, ChipsRatioHeaderCells } from "./ChipsRatioCells";
import { useChipsColumnsVisible, setChipsColumnsVisible } from "@/lib/chipsColumnsStore";
import ChipsColumnsToggle from "./ChipsColumnsToggle";
import IndustryCell from "./IndustryCell";
import StickyTableScroll from "./StickyTableScroll";
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
  /** 上游最近一筆成交時間（ISO，見 Quote.tradeTime）；沒有就不顯示資料時間。 */
  tradeTime?: string;
}

/** 一列＝一檔關注股票的報價 ＋ 使用者自己填的持股資料（localStorage）。 */
export interface HoldingItem extends WatchlistQuote {
  costBasis?: number;
  shares?: number;
  order?: number;
  /** 賣出紀錄（見 lib/soldRecords.ts）；已賣出分組與部分賣出都靠它 */
  sales?: SaleRecord[];
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

/** 籌碼比例的「本期比例」（不是升降幅度）；美股、或這一檔沒有該項資料（興櫃沒有融資／外資、
 *  資料暫缺）回 null → 排序時墊底，不當成 0。呼叫前必須先 await ensureChipsRatios() 取齊。 */
function chipsMetric(pick: ChipsRatioPick) {
  return (item: HoldingItem) => (item.market === "TW" ? getChipsRatioValue(item.symbol, pick) : null);
}

/** 依籌碼比例排序的四個欄位（值＝lib/useChipsRatios.ts 的 ChipsRatioPick）。 */
const CHIPS_SORT_FIELDS: { field: ChipsRatioPick; label: string; title: string }[] = [
  { field: "major", label: "大戶持股", title: "依大戶持股比例（1000張以上大戶，集保週資料）排序" },
  { field: "foreign", label: "外資持股", title: "依外資持股比例排序" },
  { field: "margin", label: "融資使用率", title: "依融資使用率排序" },
  { field: "short", label: "融券使用率", title: "依融券使用率（融券餘額÷融券限額）排序" },
];

function isChipsField(field: HeldSortField): field is ChipsRatioPick {
  return (CHIPS_RATIO_PICKS as readonly string[]).includes(field);
}

/** 「依產業」不是數值指標，所以不能跟其他欄位一樣用 metric 相減比較——它走
 *  lib/fineIndustry.ts 的族群順序，也沒有「高→低／低→高」的意義。 */
type HeldSortField = "investedAmount" | "changePercent" | "pnlPercent" | "fineIndustry" | ChipsRatioPick;
const HELD_SORT_METRICS: Record<Exclude<HeldSortField, "fineIndustry">, (item: HoldingItem) => number | null> = {
  investedAmount: investedAmountOrZero,
  changePercent: (item) => item.changePercent,
  pnlPercent: pnlPercentOrNull,
  major: chipsMetric("major"),
  foreign: chipsMetric("foreign"),
  margin: chipsMetric("margin"),
  short: chipsMetric("short"),
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
  // 已賣出（股數 0、購買價格保留、有賣出紀錄）自成一組，不再混在僅關注裡。
  const soldItems = items.filter(hasSoldState);
  const saleItems = items.filter((i) => visibleSales(i).length > 0);
  const unheldItems = items.filter((i) => !hasHolding(i) && !hasSoldState(i));
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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] text-(--text-muted) xl:hidden">← 可左右滑動查看持有股數／購買價格／損益，表頭與名稱欄會固定 →</p>
        {/* 籌碼四欄一鍵收合：全站共用同一個狀態（lib/chipsColumnsStore.ts），美股表沒有這四欄所以不顯示。 */}
        {market === "TW" && <ChipsColumnsToggle className="ml-auto" />}
      </div>
      {held.length > 0 && (
        <DraggableGroup title={`持有中（${held.length}）`} items={held} sortable market={held[0].market} group="held" />
      )}
      {saleItems.length > 0 && <SoldTable items={saleItems} />}
      <DraggableGroup title={`僅關注（未持有）（${unheld.length}）`} items={unheld} market={market} group="unheld" />
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
  const chipsVisible = useChipsColumnsVisible();
  const [sortField, setSortField] = useState<HeldSortField>("investedAmount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  /** 僅關注組最近一次按的籌碼比例排序（決定按鈕上的箭頭、再按一次切換方向）；只存在這次瀏覽。 */
  const [unheldChipsSort, setUnheldChipsSort] = useState<{ field: ChipsRatioPick; dir: "asc" | "desc" } | null>(null);
  /** 依籌碼比例排序時，等全部台股列的比例取齊這段期間＝true（先不動順序，取齊才一次排好）。 */
  const [chipsLoading, setChipsLoading] = useState(false);
  const sortTokenRef = useRef(0);
  const itemsRef = useRef(items);
  const draggingKeyRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const byKey = new Map(items.map((i) => [groupKey(i), i]));
  const twSymbolsKey = items
    .filter((i) => i.market === "TW")
    .map((i) => i.symbol)
    .join(",");

  useEffect(() => {
    itemsRef.current = items;
  });

  // 關注清單檔數少：一掛載就對這組全部台股列取齊籌碼比例（同一個批次 API＋前端快取，
  // 不是逐檔打），使用者之後選「依大戶／外資／融資／融券」排序時通常已經取好、不用等。
  useEffect(() => {
    if (twSymbolsKey) void ensureChipsRatios(twSymbolsKey.split(","));
  }, [twSymbolsKey]);

  // Re-sync from the persisted/live-refreshed items whenever they change —
  // except mid-drag, where the in-progress visual order takes precedence
  // over whatever the last quote-poll tick recomputed from localStorage.
  useEffect(() => {
    if (draggingKeyRef.current) return;
    setOrder(items.map(groupKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map(groupKey).join(",")]);

  // 拖曳的 move/up/cancel 一律掛在 window 上，不掛在把手按鈕本身——2026-10-01 Opus 正式站
  // 實測抓到：往下拖時 React 重排列會把被拖的那一列 DOM 節點搬位置，瀏覽器因此觸發
  // lostpointercapture，之後的 pointerup 落在一般儲存格上、把手的 onPointerUp 永遠不會被
  // 呼叫 → 拖完的順序從沒寫進 localStorage（重新整理就打回原狀），draggingKeyRef 也一直
  // 卡著讓之後的資料重新同步被擋住。window 監聽不受指標捕捉遺失影響。
  const dragHandlersRef = useRef<{ move: (y: number) => void; up: () => void }>({ move: () => {}, up: () => {} });
  const detachDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachDragRef.current?.(), []);

  function handlePointerDown(e: ReactPointerEvent<HTMLButtonElement>, key: string) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingKeyRef.current = key;
    detachDragRef.current?.();
    const onMove = (ev: PointerEvent) => dragHandlersRef.current.move(ev.clientY);
    const onUp = () => {
      detach();
      dragHandlersRef.current.up();
    };
    function detach() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      detachDragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    detachDragRef.current = detach;
  }

  function handlePointerMove(y: number) {
    const dragKey = draggingKeyRef.current;
    if (!dragKey) return;
    // 手機／平板表格在有上限高度的捲動容器裡（見 globals.css .sticky-scroll）：把手被按住時
    // 瀏覽器不會捲動（touch-action:none），所以指標靠近容器上下緣時手動捲一小段，才拖得到容器外的列。
    const container = rowRefs.current.get(dragKey)?.closest<HTMLElement>(".sticky-scroll");
    if (container && container.scrollHeight > container.clientHeight + 1) {
      const cr = container.getBoundingClientRect();
      if (y > cr.bottom - 48) container.scrollTop += 12;
      else if (y < cr.top + 48) container.scrollTop -= 12;
    }
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

  // 每次 render 把最新的 move/up 交給 window 監聽器用（它們讀的是這次 render 的 order）。
  useEffect(() => {
    dragHandlersRef.current = { move: handlePointerMove, up: handlePointerUp };
  });

  function applySort(field: HeldSortField, dir: "asc" | "desc") {
    setSortField(field);
    setSortDir(dir);
    const token = ++sortTokenRef.current;
    if (!isChipsField(field)) {
      setChipsLoading(false);
      const sorted = sortForField(items, field, dir);
      setOrder(sorted.map(groupKey));
      persistOrder(sorted);
      return;
    }
    // 依籌碼比例：必須先取齊整組台股列的資料才排（不能拿只載到一半的資料先排、之後再跳動）。
    // 等待期間使用者又改了別的排序 → token 不符，這次結果作廢。
    setChipsLoading(true);
    const symbols = itemsRef.current.filter((i) => i.market === "TW").map((i) => i.symbol);
    void ensureChipsRatios(symbols).then(() => {
      if (token !== sortTokenRef.current) return;
      setChipsLoading(false);
      const sorted = sortForField(itemsRef.current, field, dir);
      setOrder(sorted.map(groupKey));
      persistOrder(sorted);
    });
  }

  function applyUnheldChipsSort(field: ChipsRatioPick) {
    const dir = unheldChipsSort?.field === field && unheldChipsSort.dir === "desc" ? "asc" : "desc";
    setUnheldChipsSort({ field, dir });
    applySort(field, dir);
  }

  if (items.length === 0) return null;

  // 只有一檔時排序沒有意義，按鈕只會變成誤導（按了畫面完全沒變）。
  const showIndustryButton = group === "unheld" && items.length > 1;
  // 籌碼比例四欄只在台股表顯示（美股沒有這些公開資料），且使用者沒按「隱藏籌碼欄位」。
  const isTwTable = items[0].market === "TW";
  const showChips = isTwTable && chipsVisible;
  // 籌碼排序目前生效、但欄位被隱藏：排序照常運作（順序仍依籌碼比例），只提示欄位已收合並給一鍵展開。
  const chipsSortActive = group === "held" ? isChipsField(sortField) : unheldChipsSort != null;
  const chipsHiddenHint =
    isTwTable && !chipsVisible && chipsSortActive ? (
      <button
        type="button"
        onClick={() => setChipsColumnsVisible(true)}
        className="text-[11px] text-(--accent) underline"
        title="排序依籌碼比例，但籌碼欄位目前已隱藏；點一下展開欄位"
      >
        籌碼欄位已隱藏，點此顯示
      </button>
    ) : null;

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
            {chipsLoading && <span className="text-[11px] text-(--text-muted)">籌碼資料載入中…</span>}
            {chipsHiddenHint}
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
              {showChips &&
                CHIPS_SORT_FIELDS.map((c) => (
                  <option key={c.field} value={c.field}>
                    依{c.label}
                  </option>
                ))}
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
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {chipsLoading && <span className="text-[11px] text-(--text-muted)">籌碼資料載入中…</span>}
            {chipsHiddenHint}
            <button
              type="button"
              onClick={() => {
                setUnheldChipsSort(null);
                applySort("fineIndustry", "desc");
              }}
              className="rounded-md border border-(--gridline) bg-(--surface-2) px-1.5 py-0.5 text-xs hover:bg-(--page-plane)"
              title={FINE_INDUSTRY_HINT}
            >
              依產業排序
            </button>
            {/* 依籌碼比例：跟「依產業排序」一樣是一次性排好寫進手動順序，之後仍可拖曳；
                再按同一顆切換高→低／低→高。缺資料（興櫃缺項、暫缺）不論方向都排最後。 */}
            {showChips &&
              CHIPS_SORT_FIELDS.map((c) => {
                const active = unheldChipsSort?.field === c.field;
                return (
                  <button
                    key={c.field}
                    type="button"
                    onClick={() => applyUnheldChipsSort(c.field)}
                    aria-pressed={active}
                    className={`rounded-md border px-1.5 py-0.5 text-xs hover:bg-(--page-plane) ${
                      active ? "border-(--accent) bg-(--surface-2) text-(--accent)" : "border-(--gridline) bg-(--surface-2)"
                    }`}
                    title={`${c.title}（再按一次切換高→低／低→高；沒有資料的排最後）`}
                  >
                    {c.label}
                    {active && (unheldChipsSort.dir === "desc" ? " ↓" : " ↑")}
                  </button>
                );
              })}
          </div>
        )}
      </div>
      )}
      <StickyTableScroll>
        {/* 台股表多了籌碼比例四欄（大戶持股(週)／外資持股／融資使用率／融券使用率），最小寬度跟著
            加大，手機照樣靠上方「可左右滑動」提示橫向捲動，不擠壓欄位。 */}
        <table
          className={`sticky-table w-full text-sm xl:min-w-0 ${
            showChips ? (sortable ? "min-w-[1180px]" : "min-w-[1000px]") : sortable ? "min-w-[760px]" : "min-w-[560px]"
          }`}
        >
          <thead>
            <tr className="border-b border-(--gridline) text-left text-[13px] text-(--text-muted)">
              <th className="w-8 pr-1 text-right font-medium">#</th>
              <th className="w-6" />
              <th className="w-8" />
              <th className="sticky-name py-2 pr-1.5 font-medium whitespace-nowrap">代碼 / 名稱</th>
              <th className="py-2 pr-1.5 font-medium" title={FINE_INDUSTRY_HINT}>
                產業
              </th>
              {showChips && <ChipsRatioHeaderCells compact />}
              {/* 2026-10-05 使用者要求：成交量→股價→漲跌幅 依序放在籌碼四欄之後、持有股數之前。 */}
              <th className="py-2 pr-1.5 font-medium text-right text-balance">成交量</th>
              <th className="py-2 pr-1.5 font-medium text-right text-balance">股價</th>
              <th className="py-2 pr-1.5 font-medium text-right text-balance">漲跌幅</th>
              <th className="py-2 pr-1.5 font-medium text-right text-balance">持有股數</th>
              <th className="py-2 pr-1.5 font-medium text-right text-balance">購買價格</th>
              {sortable && (
                <th
                  className="py-2 pr-1.5 font-medium text-right text-balance"
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
                  className="py-2 pr-1.5 font-medium text-right text-balance"
                  title={market === "TW" ? "購買價格×股數，已計入買進手續費0.1425%（捨去到整數元，與券商實際計費方式一致）" : "購買價格×股數"}
                >
                  投資金額
                </th>
              )}
              <th
                className="py-2 pr-1.5 font-medium text-right text-balance"
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
            {order.map((key, index) => {
              const item = byKey.get(key);
              if (!item) return null;
              return (
                <HoldingRow
                  key={key}
                  rowNumber={index + 1}
                  item={item}
                  showHoldingColumns={sortable}
                  showChips={showChips}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(key, el);
                    else rowRefs.current.delete(key);
                  }}
                  onHandlePointerDown={(e) => handlePointerDown(e, key)}
                />
              );
            })}
          </tbody>
        </table>
      </StickyTableScroll>
    </div>
  );
}

function HoldingRow({
  rowNumber,
  item,
  showHoldingColumns,
  showChips,
  rowRef,
  onHandlePointerDown,
}: {
  /** 這一列在目前排序/篩選結果裡的順位（從1開始）——單純反映畫面上「目前看到
   *  第幾個」，不是股票的固定ID，改排序或拖曳後會跟著重新算過，不會維持原本
   *  的數字跟著股票走。 */
  rowNumber: number;
  item: HoldingItem;
  showHoldingColumns: boolean;
  showChips: boolean;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const [shares, setShares] = useState(item.shares?.toString() ?? "");
  const [costBasis, setCostBasis] = useState(item.costBasis?.toString() ?? "");
  const currency = item.market === "TW" ? "TWD" : "USD";

  // 籌碼比例：關注清單是短清單，大戶上一週沒有週快照時允許補查集保官網（見 useChipsRatios）。
  const { rowRef: chipsRowRef, entry: chipsEntry } = useChipsRatioRow(item.symbol, showChips ? item.market : "US", {
    webFallback: true,
  });
  // 拖曳用的 rowRef 是上層每次 render 新建的 inline callback；這裡合併成一個穩定的
  // ref，避免每次重繪都對 <tr> 反覆解除/重掛 IntersectionObserver。
  const dragRowRef = useRef(rowRef);
  useEffect(() => {
    dragRowRef.current = rowRef;
  });
  const combinedRowRef = useCallback(
    (el: HTMLTableRowElement | null) => {
      dragRowRef.current(el);
      chipsRowRef(el);
    },
    [chipsRowRef]
  );

  function commit(fromBlur = false) {
    const sharesNum = shares.trim() === "" ? undefined : Number(shares);
    const costNum = costBasis.trim() === "" ? undefined : Number(costBasis);
    const sharesOk = sharesNum != null && Number.isFinite(sharesNum) && sharesNum >= 0 ? sharesNum : undefined;
    // 持有中的股數欄被清成空白、但購買價格還在：多半是「全選刪掉要重打新股數」的中間狀態，先不動
    // （不然會整檔被清空、連賣出紀錄的來源股數都丟了）；離開欄位時把畫面還原成目前的股數。
    // 整檔要清掉請把兩欄都清空。
    if (sharesOk === undefined && costNum !== undefined && hasHolding(item)) {
      if (fromBlur) setShares(item.shares?.toString() ?? "");
      return;
    }
    updateHolding(
      item.symbol,
      item.market,
      {
        shares: sharesOk,
        costBasis: costNum != null && Number.isFinite(costNum) && costNum >= 0 ? costNum : undefined,
      },
      // 股數減少時，這個價格就是自動記下的賣出價（當下現價；抓不到＝null，由使用者補填）
      { price: item.price }
    );
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
    <tr ref={combinedRowRef} className="whitespace-nowrap border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
      <td className="py-2 pr-1 text-right tabular-nums text-(--text-muted)">{rowNumber}</td>
      <td className="py-2 pl-1">
        <button
          type="button"
          aria-label={`拖曳調整 ${item.name} 的順序`}
          title="拖曳調整順序"
          onPointerDown={onHandlePointerDown}
          style={{ touchAction: "none" }}
          className="flex h-6 w-6 cursor-grab select-none items-center justify-center rounded text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text-secondary) active:cursor-grabbing"
        >
          ⠿
        </button>
      </td>
      <td className="py-2 pl-1">
        <WatchlistButton symbol={item.symbol} market={item.market} name={item.name} />
      </td>
      <td className="sticky-name py-2 pr-1.5">
        {/* 名稱一行、代碼＋市場小字在下一行：比原本「名稱 代碼 [台股]」同一行省約 80px，桌機才塞得下不橫向捲動。 */}
        <Link
          href={`/stock/${item.symbol}?market=${item.market}`}
          prefetch={false}
          className="block whitespace-nowrap font-medium hover:text-(--accent)"
          title={`${item.name} ${item.symbol}（${item.market === "TW" ? "台股" : "美股"}）`}
        >
          {item.name}
          <span className="block text-xs font-normal text-(--text-muted) tabular-nums">
            {item.symbol}
            <span className="ml-1.5 rounded bg-(--page-plane) px-1 py-px text-[11px]">{item.market === "TW" ? "台股" : "美股"}</span>
          </span>
        </Link>
      </td>
      {/* 產業文字可能很長（例如「塑化中游（可塑劑／塑膠原料）」）：桌機限寬單行截斷、完整文字放 title；
          手機最多 2 行完整顯示，點一下展開全文（IndustryCell）。 */}
      <td className="py-2 pr-1.5 text-(--text-secondary)">
        <IndustryCell text={fineIndustryOf(item)} desktopClassName="xl:max-w-[7.5rem] xl:truncate 2xl:max-w-[12rem]" />
      </td>
      {showChips && <ChipsRatioCells entry={chipsEntry} isTw={item.market === "TW"} compact />}
      <td className="py-2 pr-1.5 text-right tabular-nums text-(--text-secondary)">
        {item.volume != null ? formatVolume(item.volume, item.market) : "—"}
      </td>
      <td className="py-2 pr-1.5 text-right tabular-nums">
        {item.price != null ? (
          formatPrice(item.price, currency)
        ) : (
          <span className="text-xs whitespace-nowrap text-(--text-muted)" title={NO_QUOTE_HINT}>
            {NO_QUOTE_LABEL}
          </span>
        )}
      </td>
      <td
        className={`py-2 pr-1.5 text-right font-medium tabular-nums ${
          item.changePercent != null ? priceDirectionClass(item.changePercent) : "text-(--text-muted)"
        }`}
      >
        {item.changePercent != null ? formatPercent(item.changePercent) : "—"}
      </td>
      <td className="py-2 pr-1.5 text-right">
        <input
          type="number"
          min="0"
          value={shares}
          onChange={(e) => setShares(e.target.value)}
          onBlur={() => commit(true)}
          placeholder="—"
          className="w-16 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none rounded border border-(--gridline) bg-(--surface-2) px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
      </td>
      <td className="py-2 pr-1.5 text-right">
        <input
          type="number"
          min="0"
          step="0.01"
          value={costBasis}
          onChange={(e) => setCostBasis(e.target.value)}
          onBlur={() => commit(true)}
          placeholder="—"
          className="w-16 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none rounded border border-(--gridline) bg-(--surface-2) px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
      </td>
      {showHoldingColumns && (
        <td className="py-2 pr-1.5 text-right tabular-nums text-(--text-secondary)">
          {breakEven != null ? formatPrice(breakEven, currency) : "—"}
        </td>
      )}
      {showHoldingColumns && (
        <td className="py-2 pr-1.5 text-right tabular-nums text-(--text-secondary)">
          {invested != null ? formatAmount(invested, currency) : "—"}
        </td>
      )}
      <td className={`py-2 pr-1.5 text-right tabular-nums ${pnl != null ? priceDirectionClass(pnl) : "text-(--text-muted)"}`}>
        {pnl != null ? (
          <>
            {formatAmountChange(pnl, currency)}
            {pnlPercent != null && <span className="block text-xs">({formatPercent(pnlPercent)})</span>}
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
