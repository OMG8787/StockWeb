import type { Market } from "@/lib/data";
import { TW_BUY_COMMISSION_RATE, TW_SELL_COMMISSION_RATE, TW_SELL_TAX_RATE } from "./tradingCosts";

/**
 * Shared fee-aware holding math — used by both WatchlistTable.tsx (the
 * table itself) and ai/ask.ts's buildHoldingsGrounding() (so the chat
 * reports the exact same 損益/損益平衡價 numbers a user sees on the
 * watchlist, not a second, differently-computed figure for the same
 * holding). Kept in one place specifically because this site has a
 * documented history of two copies of the same formula drifting apart when
 * only one gets updated (see globals.css's dark-mode-block comment).
 *
 * Standard published TW retail rates (0.1425% commission each way, 0.3%
 * 證券交易稅 on the sell side only) — deliberately the un-discounted
 * textbook figures, not any individual broker's actual (often discounted)
 * rate, since there's no way to know a user's real rate. US holdings skip
 * this entirely: unlike Taiwan, there's no one standard commission/tax
 * structure across US brokers (many are already zero-commission), so
 * guessing a number would be more misleading than showing none.
 */
// 費率本身的唯一來源在 lib/tradingCosts.ts（模擬投資組合、學習獎勵共用同一組）。

/**
 * Real TW brokerages don't charge the raw fractional-NTD fee a straight
 * rate×amount multiplication produces — each fee component is truncated
 * (無條件捨去) to a whole NT dollar before being added to/subtracted from the
 * trade amount. Confirmed against a user's actual 玉山證券 app figures for
 * three live holdings (光罩/順德/陽明): plugging their real purchase price,
 * share count and a later confirmed-matching current price into this
 * truncated-integer model reproduced 玉山's displayed 投資成本 and 損益 to the
 * exact dollar for all three, whereas the previous continuous-decimal
 * formula was consistently off by NT$1-3 per holding. Only affects the
 * dollar-amount functions below (investedAmount/computeHoldingPnl) —
 * breakEvenPrice stays a continuous per-share theoretical figure (see its
 * own comment).
 */
function twBuyCommission(costBasis: number, shares: number): number {
  return Math.floor(costBasis * shares * TW_BUY_COMMISSION_RATE);
}
function twSellCommission(price: number, shares: number): number {
  return Math.floor(price * shares * TW_SELL_COMMISSION_RATE);
}
function twSellTax(price: number, shares: number): number {
  return Math.floor(price * shares * TW_SELL_TAX_RATE);
}

/**
 * Money actually spent to acquire the position — 購買價格 × 股數 for the buy
 * side commission actually already paid (TW only; US has no assumed fee).
 * This is deliberately NOT 損益平衡價 × 股數: break-even price also bakes in
 * the SELL-side commission/tax, which hasn't been paid yet and is only
 * relevant if/when the position is actually sold — including it here would
 * overstate money that was never spent. A user asked specifically whether
 * 投資金額 should be based on 損益平衡價 "because that's the real cost"; it
 * isn't quite — 損益平衡價 is a per-share reference price, not an amount of
 * money paid — but the underlying instinct (fees are real and should count)
 * is right, which is why the buy-side commission IS folded in here.
 */
export function investedAmount(costBasis: number, shares: number, market: Market): number {
  const principal = costBasis * shares;
  if (market !== "TW") return principal;
  return Math.round(principal) + twBuyCommission(costBasis, shares);
}

/** The lowest sale price (to the cent) at which total proceeds are
 *  guaranteed to cover the original purchase cost plus both sides'
 *  transaction costs — i.e. genuinely breaking even after fees, not just
 *  "back to the purchase price" (which ignores that both buying and selling
 *  cost money). A $0 cost basis is a real (if unusual — gifted/free shares)
 *  case and correctly breaks even at $0 too; only a negative cost basis
 *  (never actually reachable through the UI, which floors input at 0, but
 *  not guaranteed for every caller) or non-positive `shares` (division by
 *  zero) has no meaningful answer.
 *
 *  Deliberately built FROM investedAmount() (the already-verified, floored-
 *  to-the-dollar actual money spent) divided by the continuous sell-side
 *  factor, then rounded UP to the cent — not from the raw per-share cost
 *  basis directly. Confirmed against a user's real 玉山證券 app across all 7
 *  of their overlapping holdings (光罩/順德/陽明/宏碁資訊/恩德/信驊/全友,
 *  share counts from 2 to 200): this exact formula reproduced 玉山's
 *  displayed 損益平衡價 to the cent for every one of them, whereas a plain
 *  continuous per-share formula (costBasis×(1+buyRate)/(1-sellRate-taxRate))
 *  was consistently off by a cent or more. Rounding UP (not to nearest, not
 *  down) is the principled choice, not just curve-fitting to match: a
 *  break-even price quantized to the cent has to be the price at which you
 *  do NOT lose money, and only rounding up guarantees that — rounding to
 *  nearest or down can land a cent on the losing side of the true
 *  (continuous) break-even point. */
export function breakEvenPrice(costBasis: number, shares: number, market: Market): number | null {
  if (costBasis < 0 || shares <= 0) return null;
  if (market !== "TW") return costBasis;
  const invested = investedAmount(costBasis, shares, market);
  const sellFactor = 1 - TW_SELL_COMMISSION_RATE - TW_SELL_TAX_RATE;
  return Math.ceil((invested / (shares * sellFactor)) * 100) / 100;
}

/**
 * Net unrealized P&L if the position were sold right now at `price` —
 * proceeds after the sell-side commission/tax (TW only, each truncated to a
 * whole NT dollar — see the comment above twBuyCommission()) minus the
 * actual money spent to buy it (investedAmount(), which already includes
 * the buy-side commission). Because breakEvenPrice() always rounds UP to
 * the cent, plugging price = breakEvenPrice(costBasis, shares, market) back
 * in here lands at a small non-negative pnl (typically $0-3, essentially
 * the rounding margin) rather than exactly 0 — that's expected, not a bug
 * (see breakEvenPrice()'s comment).
 * `pnlPercent` is null whenever there's nothing to divide by (a $0 cost
 * basis, or an invalid negative one) — the dollar `pnl` itself stays a real
 * number in the $0 case (netProceeds is still well-defined), it's only the
 * *percentage* that's undefined. Both are null for a negative cost basis,
 * which has no meaningful answer for either.
 */
export function computeHoldingPnl(
  price: number,
  costBasis: number,
  shares: number,
  market: Market
): { pnl: number | null; pnlPercent: number | null } {
  if (costBasis < 0) return { pnl: null, pnlPercent: null };
  const invested = investedAmount(costBasis, shares, market);
  let netProceeds: number;
  if (market === "TW") {
    const proceedsPrincipal = Math.round(price * shares);
    netProceeds = proceedsPrincipal - twSellCommission(price, shares) - twSellTax(price, shares);
  } else {
    netProceeds = price * shares;
  }
  const pnl = netProceeds - invested;
  const pnlPercent = invested > 0 ? (pnl / invested) * 100 : null;
  return { pnl, pnlPercent };
}
