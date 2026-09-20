import { notFound } from "next/navigation";
import type { Metadata } from "next";
import StockChart from "@/components/StockChartLazy";
import AskAboutButton from "@/components/AskAboutButton";
import WatchlistButton from "@/components/WatchlistButton";
import FundamentalsCard from "@/components/FundamentalsCard";
import EarningsCard from "@/components/EarningsCard";
import ChipsCard from "@/components/ChipsCard";
import MarketDepthCard from "@/components/MarketDepthCard";
import LiveQuoteHeader from "@/components/LiveQuoteHeader";
import PriceAlertForm from "@/components/PriceAlertForm";
import { getQuote, getFundamentals, getEarnings, getChips, getMarketDepth, getMaterialAnnouncements, detectMarket, normalizeSymbol } from "@/lib/data";
import type { Market } from "@/lib/data";
import { formatPercent, formatPrice } from "@/lib/format";

export const revalidate = 0;

interface PageProps {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ market?: string }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { symbol } = await params;
  const { market } = await searchParams;
  const marketHint = market === "TW" || market === "US" ? (market as Market) : undefined;
  const resolvedSymbol = normalizeSymbol(symbol);
  const resolvedMarket = marketHint ?? detectMarket(resolvedSymbol);
  const marketLabel = resolvedMarket === "TW" ? "台股" : "美股";

  const quote = await getQuote(symbol, marketHint);
  if (!quote) {
    return {
      title: `${resolvedSymbol}（${marketLabel}）`,
      description: `查詢 ${resolvedSymbol}（${marketLabel}）即時報價、K 線圖與技術訊號。`,
      alternates: { canonical: `/stock/${resolvedSymbol}?market=${resolvedMarket}` },
    };
  }

  const title = `${quote.name}（${quote.symbol}）${marketLabel}即時報價`;
  const description = `${quote.name}（${quote.symbol}）${marketLabel}目前 ${formatPrice(quote.price, quote.currency)} ${quote.currency}，${
    quote.change >= 0 ? "上漲" : "下跌"
  } ${formatPercent(quote.changePercent)}。查看即時報價、K 線圖、成交量與客觀技術訊號。`;

  return {
    title,
    description,
    alternates: { canonical: `/stock/${quote.symbol}?market=${quote.market}` },
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function StockDetailPage({ params, searchParams }: PageProps) {
  const { symbol } = await params;
  const { market } = await searchParams;
  if (!symbol) notFound();

  const marketHint = market === "TW" || market === "US" ? (market as Market) : undefined;
  const [quote, fundamentals, earnings, chips, marketDepth, announcements] = await Promise.all([
    getQuote(symbol, marketHint),
    getFundamentals(symbol, marketHint),
    getEarnings(symbol, marketHint),
    getChips(symbol, marketHint),
    getMarketDepth(symbol, marketHint),
    getMaterialAnnouncements(symbol, marketHint),
  ]);

  if (!quote) {
    const resolvedSymbol = normalizeSymbol(symbol);
    const resolvedMarket = marketHint ?? detectMarket(resolvedSymbol);
    return (
      <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-6 text-center">
        <h1 className="text-lg font-semibold">
          {resolvedSymbol}（{resolvedMarket === "TW" ? "台股" : "美股"}）目前無法取得即時資料
        </h1>
        <p className="mt-2 text-sm text-(--text-secondary)">
          可能是資料來源暫時無法連線或代碼不存在，請稍後再試一次。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <WatchlistButton symbol={quote.symbol} market={quote.market} name={quote.name} size="md" />
              <h1 className="text-2xl font-bold">{quote.name}</h1>
              <span className="rounded bg-(--page-plane) px-2 py-0.5 text-xs text-(--text-muted)">
                {quote.symbol} · {quote.market === "TW" ? "台股" : "美股"}
              </span>
            </div>
          </div>
          <AskAboutButton symbol={quote.symbol} market={quote.market} name={quote.name} />
        </div>

        <LiveQuoteHeader initialQuote={quote} />
      </section>

      <FundamentalsCard fundamentals={fundamentals} currency={quote.currency} />

      <EarningsCard earnings={earnings} currency={quote.currency} />

      {quote.market === "TW" && <MarketDepthCard depth={marketDepth} />}

      {quote.market === "TW" && <ChipsCard chips={chips} announcements={announcements} />}

      <PriceAlertForm symbol={quote.symbol} market={quote.market} name={quote.name} currency={quote.currency} />

      <StockChart symbol={quote.symbol} market={quote.market} currentPrice={quote.price} />
      <p className="text-xs text-(--text-muted)">
        圖表上方標籤為根據歷史價量計算出的客觀技術訊號（例如成交量、均線、區間高低），僅描述數據現況，不是買賣建議。
      </p>
    </div>
  );
}
