"use client";

import Link from "next/link";
import type { SearchItem } from "@/lib/data";
import { formatPercent, formatPrice, formatTurnover, formatVolume, priceDirectionClass } from "@/lib/format";
import { FINE_INDUSTRY_HINT, fineIndustryOf } from "@/lib/fineIndustry";
import { useChipsRatioRow } from "@/lib/useChipsRatios";
import { ChipsRatioCells, ChipsRatioHeaderCells } from "./ChipsRatioCells";
import WatchlistButton from "./WatchlistButton";

/** 列數不超過這個數字的表（首頁焦點排行 8 檔、榜單 10 檔）才對「大戶上一週」補查
 *  集保官網；搜尋篩選這種長列表只用本站週快照，沒有就顯示「累積中」。 */
const MAJOR_WEB_FALLBACK_MAX_ROWS = 10;

// client component（2026-09-30 起）：每列要掛 IntersectionObserver 漸進載入籌碼比例
// 三欄（lib/useChipsRatios.ts）。highlights 頁（server）照樣可以直接傳 items 進來。
export default function StockTable({ items, emptyLabel }: { items: SearchItem[]; emptyLabel?: string }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-(--text-muted)">{emptyLabel ?? "沒有符合條件的股票"}</p>;
  }
  // 整張表都是美股（美股頁籤）時不顯示籌碼比例三欄——美股沒有這些公開資料，三整欄
  // 的「—」只會把表格撐寬。表裡有台股時，其中的美股列一樣顯示「—」。
  const showChips = items.some((i) => i.market === "TW");
  const webFallback = items.length <= MAJOR_WEB_FALLBACK_MAX_ROWS;

  return (
    <>
      {/* 2026-09-23 Opus地毯式巡檢抓到：這個表格原本沒有min-width，手機375px
          寬度下瀏覽器會把全部欄位硬擠進容器，「產業」欄的中文字被壓成一字寬
          直排、單列高度被撐到快200px。比照WatchlistTable.tsx已經用的做法：
          給表格一個最小寬度＋overflow-x-auto讓它橫向捲動，並加同一句提示文字，
          不要讓瀏覽器用「擠壓每一欄」的方式硬塞進窄螢幕。 */}
      <p className="text-[13px] text-(--text-muted) sm:hidden">← 可左右滑動查看完整欄位 →</p>
      <div className="overflow-x-auto">
        <table className={`w-full text-sm ${showChips ? "min-w-[1080px]" : "min-w-[720px]"}`}>
        <thead>
          <tr className="border-b border-(--gridline) text-left text-(--text-muted)">
            <th className="w-8 pr-1 text-right font-medium">#</th>
            <th className="w-8" />
            <th className="py-2 pr-4 font-medium">代碼 / 名稱</th>
            <th className="py-2 pr-4 font-medium" title={FINE_INDUSTRY_HINT}>
              產業
            </th>
            <th className="py-2 pr-4 font-medium text-right whitespace-nowrap">成交金額</th>
            {showChips && <ChipsRatioHeaderCells />}
            {/* 2026-10-05 使用者要求：成交量→股價→漲跌幅 依序放在最右邊（漲跌幅在最右）。 */}
            <th className="py-2 pr-4 font-medium text-right">成交量</th>
            <th className="py-2 pr-4 font-medium text-right">股價</th>
            <th className="py-2 pr-4 font-medium text-right">漲跌幅</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <StockRow
              key={`${item.market}:${item.symbol}`}
              item={item}
              rowNumber={index + 1}
              showChips={showChips}
              webFallback={webFallback}
            />
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

function StockRow({
  item,
  rowNumber,
  showChips,
  webFallback,
}: {
  item: SearchItem;
  rowNumber: number;
  showChips: boolean;
  webFallback: boolean;
}) {
  const { rowRef, entry } = useChipsRatioRow(item.symbol, showChips ? item.market : "US", { webFallback });
  return (
    <tr ref={rowRef} className="border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
      {/* 目前看到第幾個——單純反映這次排序/篩選結果裡的順位，不是股票的
          固定編號，改排序或篩選條件後會跟著這次的新順序從1重新算過。 */}
      <td className="py-2.5 pr-1 text-right tabular-nums text-(--text-muted)">{rowNumber}</td>
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
      <td className="py-2.5 pr-4 text-right tabular-nums whitespace-nowrap text-(--text-secondary)">{formatTurnover(item.turnover, item.market)}</td>
      {showChips && <ChipsRatioCells entry={entry} isTw={item.market === "TW"} />}
      <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-secondary)">
        {formatVolume(item.volume, item.market)}
        {item.volumeTrend !== "neutral" && (
          <span
            className={`ml-1.5 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap ${
              item.volumeTrend === "buy-leaning" ? "bg-(--price-up)/10 text-(--price-up)" : "bg-(--price-down)/10 text-(--price-down)"
            }`}
            title={`成交量約為近20個交易日均量的 ${item.volumeRatio?.toFixed(1)} 倍，且股價${
              item.volumeTrend === "buy-leaning" ? "上漲" : "下跌"
            }。這是「今日量 vs 這檔股票自己近期均量」＋漲跌方向推論出的傳統價量關係判讀（價${
              item.volumeTrend === "buy-leaning" ? "漲" : "跌"
            }量增），不是真實的委買委賣單成交量統計——台股/美股都沒有公開的逐筆成交方向資料源。`}
          >
            {item.volumeTrend === "buy-leaning" ? "價漲量增" : "價跌量增"}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums">{formatPrice(item.price, item.market === "TW" ? "TWD" : "USD")}</td>
      <td className={`py-2.5 pr-4 text-right font-medium tabular-nums ${priceDirectionClass(item.changePercent)}`}>
        {formatPercent(item.changePercent)}
      </td>
    </tr>
  );
}
