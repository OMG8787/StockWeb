"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { HoldingItem } from "@/components/WatchlistTable";
import { formatAmountChange, formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import { fineIndustryOf, FINE_INDUSTRY_HINT } from "@/lib/fineIndustry";
import { useChipsRatioRow } from "@/lib/useChipsRatios";
import { ChipsRatioCells, ChipsRatioHeaderCells } from "./ChipsRatioCells";
import { useChipsColumnsVisible } from "@/lib/chipsColumnsStore";
import IndustryCell from "./IndustryCell";
import StickyTableScroll from "./StickyTableScroll";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { confirmSale, deleteSale, hasHolding, setAutoSellPrice, updateHolding, updateSale, type SalePatch } from "@/lib/watchlist";
import {
  autoFieldsOf,
  chartRangeForDate,
  closeOnOrBefore,
  computeSaleMetrics,
  isSaleConfirmed,
  isUserField,
  isValidSaleDate,
  SALE_ESTIMATE_NOTE,
  SALE_VERDICT_LABEL,
  sortSalesNewestFirst,
  visibleSales,
  type RatingAtSaleEntry,
  type SaleField,
  type SaleMetrics,
  type SaleRecord,
} from "@/lib/soldRecords";
import { useSaleRatings } from "@/lib/useSaleRatings";

/**
 * 關注清單「已賣出」分組（2026-10-06 使用者要求）：每一筆賣出紀錄一列，用來回頭檢討「賣掉的選擇對或不對」。
 * 全部賣出（股數歸零、購買價格保留）與部分賣出（股票仍在持有中，只是多一筆賣出紀錄）都列在這裡。
 * 計算全部走 lib/soldRecords.ts（已實現損益＝跟持有中同一個 computeHoldingPnl，台股已扣手續費與證交稅估算）。
 * 賣出價／日期／股數／買進價都能改；使用者改過的欄位以使用者為準（自動流程不會覆蓋），沒改過的欄位標「估」。
 */

const INPUT =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none rounded border bg-(--surface-2) px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-(--accent)";
const BORDER_USER = "border-(--gridline)";
const BORDER_AUTO = "border-dashed border-(--text-muted)";
const BTN = "rounded-md border border-(--gridline) bg-(--surface-2) px-1.5 py-0.5 text-xs hover:bg-(--page-plane)";

interface SoldRowData {
  item: HoldingItem;
  rec: SaleRecord;
  /** 這檔在表裡的第一列才放「目前持股／購買價格」的編輯欄 */
  first: boolean;
}

function EstimateTag({ title }: { title: string }) {
  return (
    <span className="ml-0.5 align-top text-[10px] leading-none text-(--text-muted)" title={title}>
      估
    </span>
  );
}

/** 數字欄位：本地輸入、停筆 600ms 或離開欄位才寫入；內容沒變就不寫（避免「只是點進去看看」就被記成使用者改過）。 */
function NumberField({
  value,
  isUser,
  onCommit,
  width = "w-[4.25rem]",
  placeholder = "—",
  label,
  highlightEmpty = false,
  step = "0.01",
}: {
  value: number | undefined;
  isUser: boolean;
  onCommit: (v: number | null) => void;
  width?: string;
  placeholder?: string;
  label: string;
  highlightEmpty?: boolean;
  step?: string;
}) {
  const [text, setText] = useState(value?.toString() ?? "");
  const lastValue = useRef(value);
  useEffect(() => {
    // 外部（例如自動補上收盤價）改了這一格，而使用者沒有正在編輯時，跟著更新顯示。
    if (lastValue.current !== value) {
      lastValue.current = value;
      setText(value?.toString() ?? "");
    }
  }, [value]);
  const commit = useCallback(() => {
    const t = text.trim();
    const n = t === "" ? null : Number(t);
    if (n != null && (!Number.isFinite(n) || n < 0)) {
      setText(value?.toString() ?? "");
      return;
    }
    if ((n ?? undefined) === value) return;
    lastValue.current = n ?? undefined;
    onCommit(n);
  }, [text, value, onCommit]);
  useEffect(() => {
    const timer = setTimeout(commit, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在輸入文字改變時排程
  }, [text]);
  const empty = value == null && highlightEmpty;
  return (
    <span className="inline-flex items-start">
      <input
        type="number"
        min="0"
        step={step}
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder={placeholder}
        className={`${INPUT} ${width} ${empty ? "border-(--price-up)" : isUser ? BORDER_USER : BORDER_AUTO}`}
      />
      {!isUser && value != null && <EstimateTag title="自動帶入的估計值，改過之後就以你填的為準" />}
    </span>
  );
}

function MetricCell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-1.5 text-right tabular-nums ${className}`}>{children}</td>;
}

function SoldRow({
  rowNumber,
  data,
  today,
  showChips,
  rating,
  ratingLoading,
}: {
  rowNumber: number;
  data: SoldRowData;
  today: string;
  showChips: boolean;
  rating: RatingAtSaleEntry | null | undefined;
  ratingLoading: boolean;
}) {
  const { item, rec, first } = data;
  const currency = item.market === "TW" ? "TWD" : "USD";
  const { rowRef, entry: chipsEntry } = useChipsRatioRow(item.symbol, showChips ? item.market : "US", { webFallback: true });
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const m: SaleMetrics = computeSaleMetrics(rec, item.price, item.market, today);
  const confirmed = isSaleConfirmed(rec);
  const sellAuto = !isUserField(rec, "sellPrice");
  const estTitle = `${SALE_ESTIMATE_NOTE}（按「確認」或把四個欄位都親手改過後，這筆就是已確認）`;
  const patch = (p: SalePatch) => updateSale(item.symbol, item.market, rec.id, p);
  const verdictTitle = "賣出後漲＝賣早了、賣出後跌＝賣對了（現價相對賣出價的純價差，未扣交易成本）";

  /** 改日期：賣出價若仍是自動帶入的估計值，改成該日（或之前最近一個交易日）的收盤價；使用者填的價格不動。 */
  async function onDateCommit(date: string) {
    if (!isValidSaleDate(date) || date === rec.date) return;
    patch({ date });
    setPriceNote(null);
    if (isUserField(rec, "sellPrice")) return;
    try {
      const res = await fetch(`/api/chart/${encodeURIComponent(item.symbol)}?range=${chartRangeForDate(date, today)}&market=${item.market}`);
      const body = res.ok ? ((await res.json()) as { candles?: { time: string; close: number }[] }) : null;
      const hit = body?.candles ? closeOnOrBefore(body.candles, date) : null;
      if (hit) {
        setAutoSellPrice(item.symbol, item.market, rec.id, hit.close, date);
        setPriceNote(`賣出價已改為 ${hit.day} 的收盤價（估計），請改成實際成交價`);
      } else {
        setPriceNote("抓不到該日收盤價，賣出價維持原值，請自行確認或修改");
      }
    } catch {
      setPriceNote("抓不到該日收盤價，賣出價維持原值，請自行確認或修改");
    }
  }

  const missingSell = rec.sellPrice == null;
  const partial = rec.remaining > 0;
  return (
    <tr ref={rowRef} className="border-b border-(--gridline) align-top last:border-0 hover:bg-(--page-plane)">
      <td className="py-2 pr-1 text-right tabular-nums text-(--text-muted)">{rowNumber}</td>
      <td className="sticky-name py-2 pr-1.5">
        <Link
          href={`/stock/${item.symbol}?market=${item.market}`}
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
      <td className="py-2 pr-1.5 text-(--text-secondary)">
        <IndustryCell text={fineIndustryOf(item)} desktopClassName="xl:max-w-[6rem] xl:truncate 2xl:max-w-[10rem]" />
      </td>
      {showChips && <ChipsRatioCells entry={chipsEntry} isTw={item.market === "TW"} compact />}
      <MetricCell>
        {item.price != null ? (
          <>
            {formatPrice(item.price, currency)}
            {item.changePercent != null && (
              <span className={`block text-xs ${priceDirectionClass(item.changePercent)}`}>{formatPercent(item.changePercent)}</span>
            )}
          </>
        ) : (
          <span className="text-xs text-(--text-muted)">資料暫缺</span>
        )}
      </MetricCell>
      <td className="py-2 pr-1.5 text-right">
        <span className="inline-flex items-start">
          <input
            type="date"
            value={rec.date}
            aria-label={`${item.name} 賣出日期`}
            onChange={(e) => void onDateCommit(e.target.value)}
            className={`${INPUT} w-[7.75rem] text-left ${isUserField(rec, "date") ? BORDER_USER : BORDER_AUTO}`}
          />
          {!isUserField(rec, "date") && <EstimateTag title="自動記下的賣出日期（股數改動當天），改過之後就以你填的為準" />}
        </span>
        <span className="mt-0.5 block text-[11px] text-(--text-muted)">{m.days != null ? (m.days === 0 ? "今天賣出" : `賣出 ${m.days} 天`) : ""}</span>
      </td>
      <td className="py-2 pr-1.5 text-right">
        <NumberField
          value={rec.shares}
          isUser={isUserField(rec, "shares")}
          onCommit={(v) => v != null && v > 0 && patch({ shares: v })}
          width="w-16"
          label={`${item.name} 賣出股數`}
          step="1"
        />
        {partial && (
          <span className="mt-0.5 block text-[11px] text-(--text-muted)" title={`這筆賣出後還剩 ${rec.remaining} 股，股票仍在持有中`}>
            部分賣出
          </span>
        )}
      </td>
      <td className="py-2 pr-1.5 text-right">
        <div className="flex flex-col items-end gap-1">
          <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-(--text-muted)">
            買
            <NumberField
              value={rec.buyPrice}
              isUser={isUserField(rec, "buyPrice")}
              onCommit={(v) => patch({ buyPrice: v })}
              label={`${item.name} 買進價`}
            />
          </label>
          <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-(--text-muted)">
            賣
            <NumberField
              value={rec.sellPrice}
              isUser={!sellAuto}
              onCommit={(v) => patch({ sellPrice: v })}
              label={`${item.name} 賣出價`}
              placeholder="請填"
              highlightEmpty
            />
          </label>
        </div>
        {missingSell ? (
          <span className="mt-0.5 block w-[7rem] whitespace-normal text-[11px] text-(--price-up)">賣出當下抓不到報價，請填實際賣出價</span>
        ) : (
          sellAuto && <span className="mt-0.5 block w-[7rem] whitespace-normal text-[11px] text-(--text-muted)">{SALE_ESTIMATE_NOTE}</span>
        )}
        {priceNote && <span className="mt-0.5 block w-[7rem] whitespace-normal text-[11px] text-(--text-muted)">{priceNote}</span>}
      </td>
      <MetricCell className={m.realizedPnl != null ? priceDirectionClass(m.realizedPnl) : "text-(--text-muted)"}>
        {m.realizedPnl != null ? (
          <>
            {formatAmountChange(m.realizedPnl, currency)}
            {m.realizedPct != null && <span className="block text-xs">({formatPercent(m.realizedPct)})</span>}
            {!confirmed && <span className="block text-[11px] text-(--text-muted)">估計值</span>}
          </>
        ) : (
          "—"
        )}
      </MetricCell>
      <MetricCell className={m.afterSellPct != null ? priceDirectionClass(m.afterSellPct) : "text-(--text-muted)"}>
        {m.afterSellPct != null && m.verdict ? (
          <span title={verdictTitle}>
            {formatPercent(m.afterSellPct)}
            <span className="block text-xs font-medium">{SALE_VERDICT_LABEL[m.verdict]}</span>
            {m.heldDiff != null && (
              <span className="block text-[11px] font-normal">若沒賣 {formatAmountChange(m.heldDiff, currency)}</span>
            )}
            {!confirmed && <span className="block text-[11px] font-normal text-(--text-muted)">估計值</span>}
          </span>
        ) : (
          "—"
        )}
      </MetricCell>
      <MetricCell className={m.ifHeldPnl != null ? priceDirectionClass(m.ifHeldPnl) : "text-(--text-muted)"}>
        {m.ifHeldPnl != null ? (
          <span title="假設一直沒賣、現在以現價賣出的損益（跟已實現損益同口徑，已扣交易成本）">
            {formatAmountChange(m.ifHeldPnl, currency)}
            {m.ifHeldPct != null && <span className="block text-xs">({formatPercent(m.ifHeldPct)})</span>}
          </span>
        ) : (
          "—"
        )}
      </MetricCell>
      <td className="py-2 pr-1.5 text-left text-xs">
        {ratingLoading ? (
          <span className="text-(--text-muted)">查詢中…</span>
        ) : rating ? (
          <span title={`賣出日 ${rec.date} 當天（或之前最近一筆）本站評等：未持有「${rating.label}」／已持有「${rating.holdingLabel}」（紀錄日 ${rating.day}）`}>
            {rating.holdingLabel}
            {rating.day !== rec.date && <span className="block text-[11px] text-(--text-muted)">（{rating.day.slice(5)} 的紀錄）</span>}
          </span>
        ) : (
          <span className="text-(--text-muted)">無紀錄</span>
        )}
      </td>
      <td className="py-2 pr-1.5 text-right">
        {first ? (
          <HoldingEditor item={item} />
        ) : (
          <span className="text-xs text-(--text-muted)">—</span>
        )}
      </td>
      <td className="py-2 pr-1 text-right whitespace-nowrap">
        {confirmed ? (
          <span className="mr-1 text-[11px] text-(--text-muted)" title="四個欄位都是你確認過的數字">
            已確認
          </span>
        ) : (
          <button
            type="button"
            disabled={missingSell}
            onClick={() => confirmSale(item.symbol, item.market, rec.id)}
            className={`${BTN} mr-1 disabled:opacity-40`}
            title={missingSell ? "先填賣出價才能確認" : `${estTitle}。目前自動帶入的欄位：${autoFieldsOf(rec).map(fieldName).join("、") || "無"}`}
          >
            確認
          </button>
        )}
        <button
          type="button"
          aria-label={`刪除 ${item.name} ${rec.date} 這筆賣出紀錄`}
          onClick={() => {
            if (window.confirm(`確定要刪除「${item.name} ${rec.date} 賣出 ${rec.shares} 股」這筆賣出紀錄嗎？\n（股數誤改造成的紀錄可以這樣刪掉；不會改動你目前的持有股數。）`)) {
              deleteSale(item.symbol, item.market, rec.id);
            }
          }}
          className={BTN}
          title="刪除這筆賣出紀錄"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

function fieldName(f: SaleField): string {
  return { date: "賣出日期", shares: "賣出股數", buyPrice: "買進價", sellPrice: "賣出價" }[f];
}

/** 目前持股／購買價格（已賣出的那檔才能改：股數改成 >0＝買回、回到持有中；購買價格清空＝移回未持有）。 */
function HoldingEditor({ item }: { item: HoldingItem }) {
  if (hasHolding(item)) {
    return (
      <span className="text-xs text-(--text-muted)" title="這檔目前仍持有中（部分賣出），股數與購買價格請在上方「持有中」表格修改">
        持有中 {item.shares} 股
      </span>
    );
  }
  return <HoldingEditorInputs key={`${item.shares}-${item.costBasis}`} item={item} />;
}

function HoldingEditorInputs({ item }: { item: HoldingItem }) {
  const [shares, setShares] = useState(item.shares?.toString() ?? "0");
  const [cost, setCost] = useState(item.costBasis?.toString() ?? "");
  function commit() {
    const s = shares.trim() === "" ? 0 : Number(shares);
    const c = cost.trim() === "" ? undefined : Number(cost);
    if (!Number.isFinite(s) || s < 0 || (c != null && (!Number.isFinite(c) || c < 0))) return;
    if (s === item.shares && c === item.costBasis) return;
    updateHolding(item.symbol, item.market, { shares: s, costBasis: c }, { price: item.price });
  }
  const cls = `${INPUT} w-16 ${BORDER_USER}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-(--text-muted)">
        股數
        <input
          type="number"
          min="0"
          value={shares}
          aria-label={`${item.name} 目前持有股數`}
          onChange={(e) => setShares(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          title="改成大於 0＝買回、回到持有中"
          className={cls}
        />
      </label>
      <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-(--text-muted)">
        購買價
        <input
          type="number"
          min="0"
          step="0.01"
          value={cost}
          aria-label={`${item.name} 購買價格`}
          onChange={(e) => setCost(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="—"
          title="清空（或改成 0）＝移回「僅關注（未持有）」，賣出紀錄仍保留在資料裡"
          className={cls}
        />
      </label>
    </div>
  );
}

/** 已確認紀錄的彙總（未確認的估計值另外計、不混進賣對／賣早統計）。 */
export function summarizeSold(rows: SoldRowData[], today: string) {
  let right = 0;
  let early = 0;
  let confirmedCount = 0;
  let unconfirmed = 0;
  const realized: Record<string, number> = {};
  const heldDiff: Record<string, number> = {};
  for (const { item, rec } of rows) {
    if (!isSaleConfirmed(rec)) {
      unconfirmed++;
      continue;
    }
    confirmedCount++;
    const m = computeSaleMetrics(rec, item.price, item.market, today);
    const cur = item.market === "TW" ? "TWD" : "USD";
    if (m.realizedPnl != null) realized[cur] = (realized[cur] ?? 0) + m.realizedPnl;
    if (m.heldDiff != null) heldDiff[cur] = (heldDiff[cur] ?? 0) + m.heldDiff;
    if (m.verdict === "right") right++;
    else if (m.verdict === "early") early++;
  }
  return { right, early, confirmedCount, unconfirmed, realized, heldDiff };
}

export default function SoldTable({ items }: { items: HoldingItem[] }) {
  const chipsVisible = useChipsColumnsVisible();
  const today = taipeiDayKey();
  const market = items[0]?.market ?? "TW";
  const isTwTable = market === "TW";
  const showChips = isTwTable && chipsVisible;
  const currency = market === "TW" ? "TWD" : "USD";

  const flat = items.flatMap((item) => visibleSales(item).map((rec) => ({ item, rec })));
  const sorted = sortSalesNewestFirst(flat.map((r) => ({ ...r, date: r.rec.date })));
  const seen = new Set<string>();
  const rows: SoldRowData[] = sorted.map(({ item, rec }) => {
    const k = `${item.market}:${item.symbol}`;
    const first = !seen.has(k);
    seen.add(k);
    return { item, rec, first };
  });
  const stockCount = new Set(rows.map((r) => `${r.item.market}:${r.item.symbol}`)).size;
  const ratings = useSaleRatings(rows.map((r) => ({ symbol: r.item.symbol, date: r.rec.date })));
  if (rows.length === 0) return null;
  const sum = summarizeSold(rows, today);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold text-(--text-muted)">
          已賣出（{rows.length} 筆紀錄／{stockCount} 檔）
        </h3>
      </div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {sum.confirmedCount > 0 ? (
          <>
            <span>
              <span className="text-(--text-muted)">已確認 {sum.confirmedCount} 筆：</span>
              <span className="font-medium tabular-nums">賣對了 {sum.right}・賣早了 {sum.early}</span>
            </span>
            {sum.realized[currency] != null && (
              <span title="已確認紀錄的已實現損益合計（已扣估算的手續費與證交稅）">
                <span className="text-(--text-muted)">已實現合計：</span>
                <span className={`font-medium tabular-nums ${priceDirectionClass(sum.realized[currency])}`}>
                  {formatAmountChange(sum.realized[currency], currency)}
                </span>
              </span>
            )}
            {sum.heldDiff[currency] != null && (
              <span title="已確認紀錄「賣出後到現在的價差×股數」合計：正數＝賣出後漲了（少賺）、負數＝賣出後跌了（避開的虧損）；純價差，未扣交易成本">
                <span className="text-(--text-muted)">若沒賣價差合計：</span>
                <span className={`font-medium tabular-nums ${priceDirectionClass(sum.heldDiff[currency])}`}>
                  {formatAmountChange(sum.heldDiff[currency], currency)}
                </span>
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-(--text-muted)">還沒有已確認的賣出紀錄，彙總先不計算</span>
        )}
        {sum.unconfirmed > 0 && (
          <span className="text-xs text-(--text-muted)">另有 {sum.unconfirmed} 筆是估計值、尚未確認（不納入上面的彙總）</span>
        )}
      </div>
      <p className="mb-1.5 text-[13px] text-(--text-muted)">
        股數改成 0（或減少）時自動記下賣出價（當下現價）與日期，標「估」的是自動帶入的估計值，請改成實際成交價；你改過的欄位一律以你填的為準，按「確認」後這筆才算已確認。
        損益為估算並已扣交易成本（台股買賣手續費各 0.1425%、賣出證交稅 0.3%；美股不計），「賣出後」漲跌為現價相對賣出價的純價差。
      </p>
      <p className="mb-1.5 text-[13px] text-(--text-muted) xl:hidden">← 可左右滑動查看賣出價／損益／當天本站建議，表頭與名稱欄會固定 →</p>
      <StickyTableScroll>
        <table className={`sticky-table w-full text-sm xl:min-w-0 ${showChips ? "min-w-[1500px]" : "min-w-[1100px]"}`}>
          <thead>
            <tr className="border-b border-(--gridline) text-left text-[13px] text-(--text-muted)">
              <th className="w-8 pr-1 text-right font-medium">#</th>
              <th className="sticky-name py-2 pr-1.5 font-medium whitespace-nowrap">代碼 / 名稱</th>
              <th className="py-2 pr-1.5 font-medium" title={FINE_INDUSTRY_HINT}>
                產業
              </th>
              {showChips && <ChipsRatioHeaderCells compact />}
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap">現價</th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap">賣出日期</th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap">賣出股數</th>
              <th className="py-2 pr-1.5 text-right font-medium text-balance whitespace-nowrap" title="上＝買進價（賣出當時的購買價格）、下＝賣出價">
                買進／賣出價
              </th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap" title="(賣出價−買進價)×股數，已扣估算的手續費與證交稅，跟持有中的損益同一套算法">
                已實現損益
              </th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap" title="(現價−賣出價)÷賣出價。漲＝賣早了、跌＝賣對了；純價差未扣成本。下方「若沒賣」＝(現價−賣出價)×股數">
                賣出後漲跌
              </th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap" title="假設一直沒賣、現在以現價賣出的損益（買進價→現價，同口徑已扣交易成本）">
                若沒賣損益
              </th>
              <th className="py-2 pr-1.5 font-medium" title="賣出日當天（或之前最近一筆）本站評等的持有建議；本站評等紀錄從 2026-10-05 開始">
                賣出當天<br className="xl:hidden" />本站建議
              </th>
              <th className="py-2 pr-1.5 text-right font-medium whitespace-nowrap" title="已賣出的股票：目前持股改成大於 0＝買回；購買價格清空＝移回未持有">
                持股／購買價
              </th>
              <th className="py-2 pr-1 text-right font-medium">確認／刪除</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((data, i) => {
              const key = `${data.item.symbol.toUpperCase()}|${data.rec.date}`;
              const rating = ratings.get(key);
              return (
                <SoldRow
                  key={`${data.item.market}:${data.item.symbol}:${data.rec.id}`}
                  rowNumber={i + 1}
                  data={data}
                  today={today}
                  showChips={showChips}
                  rating={rating ?? null}
                  ratingLoading={!ratings.has(key)}
                />
              );
            })}
          </tbody>
        </table>
      </StickyTableScroll>
    </div>
  );
}
