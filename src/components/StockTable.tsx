import Link from "next/link";
import type { SearchItem } from "@/lib/data";
import { formatPercent, formatPrice, formatTurnover, formatVolume, priceDirectionClass } from "@/lib/format";
import { FINE_INDUSTRY_HINT, fineIndustryOf } from "@/lib/fineIndustry";
import WatchlistButton from "./WatchlistButton";

export default function StockTable({ items, emptyLabel }: { items: SearchItem[]; emptyLabel?: string }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-(--text-muted)">{emptyLabel ?? "沒有符合條件的股票"}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--gridline) text-left text-(--text-muted)">
            <th className="w-8" />
            <th className="py-2 pr-4 font-medium">代碼 / 名稱</th>
            <th className="py-2 pr-4 font-medium" title={FINE_INDUSTRY_HINT}>
              產業
            </th>
            <th className="py-2 pr-4 font-medium text-right">股價</th>
            <th className="py-2 pr-4 font-medium text-right">漲跌幅</th>
            <th className="py-2 pr-4 font-medium text-right">成交量</th>
            <th className="py-2 pr-4 font-medium text-right">成交金額</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.market}:${item.symbol}`} className="border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
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
                {formatPrice(item.price, item.market === "TW" ? "TWD" : "USD")}
              </td>
              <td className={`py-2.5 pr-4 text-right font-medium tabular-nums ${priceDirectionClass(item.changePercent)}`}>
                {formatPercent(item.changePercent)}
              </td>
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
              <td className="py-2.5 pr-4 text-right tabular-nums text-(--text-secondary)">
                {formatTurnover(item.turnover, item.market)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
