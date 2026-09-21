import type { Market } from "./types";
import { US_UNIVERSE, findInUniverse, findSymbolByName, getTwUniverse, UniverseEntry } from "./universe";

export async function universeFor(market: Market): Promise<UniverseEntry[]> {
  return market === "TW" ? getTwUniverse() : US_UNIVERSE;
}

export function detectMarket(symbolInput: string): Market {
  const known = findInUniverse(symbolInput);
  if (known) return known.market;
  return /^\d{3,6}$/.test(symbolInput.trim()) ? "TW" : "US";
}

/**
 * Route params (e.g. the [symbol] segment in /stock/[symbol]) can arrive
 * still percent-encoded in some Next.js render paths — decode defensively
 * so a Chinese company name typed into the header search box (which just
 * navigates straight to /stock/<input>) doesn't show up as raw "%E5%8F..."
 * on the page. Safe to call on an already-decoded plain symbol like
 * "2330"/"AAPL" too: decodeURIComponent is a no-op without a "%" in it.
 */
export function normalizeSymbol(symbolInput: string): string {
  let decoded = symbolInput;
  try {
    decoded = decodeURIComponent(symbolInput);
  } catch {
    // malformed percent-encoding; fall back to the raw input
  }
  const trimmed = decoded.trim();
  // The header search box and "/stock/<input>" both accept a company name
  // typed in directly (e.g. "台積電"), not just a ticker — resolve that to
  // its actual code before the market-agnostic uppercase/suffix cleanup
  // below, which would otherwise pass the name straight through to a data
  // source that only understands codes/tickers and get "資料暫缺" back for
  // a perfectly findable stock.
  const byName = findSymbolByName(trimmed);
  if (byName) return byName.symbol;
  return trimmed.toUpperCase().replace(/\.(TW|TWO|US)$/i, "");
}

/**
 * TW has two exchanges behind one public "TW" market — a given symbol must
 * be routed to the right one before a per-symbol (single-source) fetch can
 * happen at all. `findInUniverse` carries the answer whenever the symbol is
 * already known; for the rare case of a symbol not indexed yet (a very new
 * IPO, or simply a wrong/nonexistent code), TWSE is tried first (unchanged
 * default/common-case latency) and TPEx only as a second attempt — this
 * ambiguous-symbol path is rare enough that the extra latency it can incur
 * is an acceptable tradeoff, and it must never slow down the common case
 * where the exchange is already known.
 */
export function resolveTwExchange(symbol: string): "TWSE" | "TPEx" | "Emerging" | undefined {
  return findInUniverse(symbol, "TW")?.exchange;
}
