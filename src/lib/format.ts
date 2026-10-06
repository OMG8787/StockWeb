export function formatPrice(value: number, currency: string): string {
  const decimals = currency === "TWD" && value >= 100 ? 1 : 2;
  return value.toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatChange(value: number, currency: string): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPrice(value, currency)}`;
}

/**
 * For a total money AMOUNT (投資金額, 損益ਸ਼) rather than a per-share PRICE —
 * formatPrice()'s TWD branch keeps 1 decimal place once the value passes
 * 100 (right for a per-share quote like "251.5"), but a whole-dollar total
 * like invested-amount or P&L has no meaningful fractional NT dollar once
 * lib/portfolio.ts started truncating fee components to whole dollars, so
 * forcing that same decimal on a total just prints a misleading trailing
 * ".0". TWD totals round to the nearest whole dollar; USD keeps 2 decimals
 * (cents are real money there).
 */
export function formatAmount(value: number, currency: string): string {
  const decimals = currency === "TWD" ? 0 : 2;
  return value.toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatAmountChange(value: number, currency: string): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatAmount(value, currency)}`;
}

/**
 * `value` is always raw shares internally (see lib/data/twse.ts — MIS's 張
 * count is converted to shares so it matches the historical-chart volume
 * unit). Taiwan investors read 成交量 as a plain 張 count though (every
 * local site — TWSE itself, Yahoo奇摩股市, MoneyDJ — shows e.g. "15,553張",
 * never a US-style abbreviated share count), so convert back to 張 for
 * display on TW rows. US stays as abbreviated shares (M/K), which is how
 * US sites display volume.
 */
export function formatVolume(value: number, market: "TW" | "US" = "US"): string {
  if (market === "TW") {
    return `${Math.round(value / 1000).toLocaleString("zh-TW")}張`;
  }
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export function formatMarketCap(value: number, currency: string): string {
  // 台股市值用在地慣用的兆／億（2026-10-05 台股才開始有市值；美股維持 T/B/M 不變）。
  if (currency === "TWD") {
    if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)}兆元`;
    if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}億元`;
    return `${(value / 10_000).toFixed(0)}萬元`;
  }
  const symbol = "$";
  if (value >= 1_000_000_000_000) return `${symbol}${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  return `${symbol}${value.toLocaleString()}`;
}

/**
 * Same "each market keeps its own real-world reading convention" split as
 * formatVolume() above — a user asked for 成交金額 to use Chinese units
 * (萬/億) rather than the English T/B/M abbreviation formatMarketCap uses.
 * 億/萬 is the actual local convention for TWD-denominated figures (every TW
 * site — TWSE itself, Yahoo奇摩股市, MoneyDJ — reports 成交金額 this way),
 * but isn't how USD amounts get reported even on Chinese-language coverage
 * of the US market (still "億" would be an unfamiliar unit tied to
 * NT$/RMB-scale reporting) — so US stays on formatMarketCap's T/B/M.
 */
export function formatTurnover(value: number, market: "TW" | "US"): string {
  if (market !== "TW") return formatMarketCap(value, "USD");
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}億`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}萬`;
  return value.toLocaleString("zh-TW");
}

/**
 * Formats an ISO timestamp as Taipei wall-clock time (`YYYY/MM/DD HH:mm:ss`),
 * computed via fixed UTC+8 offset arithmetic rather than
 * `toLocaleString(..., { timeZone: "Asia/Taipei" })`. That Intl call reads
 * differently between Vercel's Node runtime and a browser when the locale
 * data available for "zh-TW" isn't identical on both sides, which produces
 * two different strings for the same instant — a text mismatch that fails
 * React hydration on every stock page. Plain arithmetic is deterministic
 * across any JS engine, with or without full ICU data.
 */
export function formatTaipeiDateTime(isoString: string): string {
  const date = new Date(isoString);
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${taipei.getUTCFullYear()}/${pad(taipei.getUTCMonth() + 1)}/${pad(taipei.getUTCDate())} ${pad(
    taipei.getUTCHours(),
  )}:${pad(taipei.getUTCMinutes())}:${pad(taipei.getUTCSeconds())}`;
}

/** ISO → 台北時間 "HH:MM:SS"（資料時間顯示用）；格式不對回 null。 */
export function formatTaipeiTime(isoString: string | undefined): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return formatTaipeiDateTime(isoString).slice(-8);
}

/** Taiwan/greater-China convention: red = up, green = down. */
export function priceDirectionClass(change: number): string {
  if (change > 0) return "text-(--price-up)";
  if (change < 0) return "text-(--price-down)";
  return "text-(--text-secondary)";
}

/**
 * TWSE's 三大法人買賣超 data comes in raw shares, but Taiwanese investors
 * discuss it in 張 (1張=1000股). Every caller that feeds this to an LLM
 * needs BOTH numbers spelled out — a past bug had the model try to do this
 * conversion itself in generated text and get it wrong by 10x/1000x. Shared
 * here so that fix lives in exactly one place instead of being copy-pasted
 * (and potentially re-broken) across every feature that mentions chip data.
 */
export function formatSharesWithLots(shares: number): string {
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;
  return `${signed(shares)}股（約${signed(Math.round(shares / 1000))}張）`;
}
