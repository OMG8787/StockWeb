"use client";

import dynamic from "next/dynamic";

// StockChart pulls in lightweight-charts (a real charting library, not a
// trivial dependency) via a static top-level import — bundling that into
// this page's main JS chunk meant the whole page (price, fundamentals,
// chips, the watchlist/price-alert buttons — everything that has nothing to
// do with the chart) had to wait on that extra code downloading and parsing
// before any of it became interactive. Splitting it into its own chunk via
// next/dynamic (ssr: false, since lightweight-charts only runs in a real
// DOM) lets the rest of the page hydrate immediately; the chart itself pops
// in a little after, in the same spot it always rendered, once its own
// chunk has loaded — no functionality lost, nothing displayed differently
// once loaded, just decoupled from blocking everything above it.
const StockChart = dynamic(() => import("./StockChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] animate-pulse rounded-lg border border-(--gridline) bg-(--surface-1)" />
  ),
});

export default function StockChartLazy(props: { symbol: string; market: "TW" | "US"; currentPrice: number }) {
  return <StockChart {...props} />;
}
