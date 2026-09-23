import { marketStatusLabel, type MarketStatus } from "@/lib/marketStatus";

export default function MarketStatusBadge({ status }: { status: MarketStatus }) {
  const open = status === "open";
  // "試撮中" gets its own pulsing dot (something IS actively updating —
  // TWSE is publishing trial-match data) but not the full accent color
  // "open" gets, since no real trade has actually happened yet — visually
  // between "open" and "closed" rather than identical to either.
  const preMarket = status === "pre-market";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-medium ${
        open ? "bg-(--accent-soft) text-(--accent)" : "bg-(--page-plane) text-(--text-muted)"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          open || preMarket ? "bg-(--accent) animate-pulse" : "bg-(--text-muted)"
        }`}
        aria-hidden
      />
      {marketStatusLabel(status)}
    </span>
  );
}
