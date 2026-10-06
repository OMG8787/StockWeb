import Link from "next/link";
import WatchlistButton from "./WatchlistButton";
import SignalTags from "./SignalTags";
import { formatPercent, formatPrice, priceDirectionClass } from "@/lib/format";
import type { MomentumItem } from "@/lib/data";

export default function MomentumTable({ items }: { items: MomentumItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-(--text-muted)">目前沒有同時符合多個技術訊號的股票</p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={`${item.market}:${item.symbol}`}
          className="flex items-center justify-between gap-3 rounded-md border border-(--gridline) p-3"
        >
          <div className="flex min-w-0 items-center gap-2">
            <WatchlistButton symbol={item.symbol} market={item.market} name={item.name} />
            <div className="min-w-0">
              <Link href={`/stock/${item.symbol}?market=${item.market}`} prefetch={false} className="font-medium hover:text-(--accent)">
                {item.name}
                <span className="ml-1.5 text-(--text-muted) tabular-nums">{item.symbol}</span>
              </Link>
              <div className="mt-1">
                <SignalTags signals={item.signals} />
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="tabular-nums font-medium">{formatPrice(item.price, item.market === "TW" ? "TWD" : "USD")}</div>
            <div className={`text-sm tabular-nums ${priceDirectionClass(item.changePercent)}`}>
              {formatPercent(item.changePercent)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
