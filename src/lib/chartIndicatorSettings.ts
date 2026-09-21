// Global (not per-stock) technical-indicator display settings for
// StockChart — the user asked for exactly this: pick which lines to show
// once, and have that same choice apply automatically on every stock's
// chart from then on, not need re-picking per symbol. Same
// localStorage-plus-custom-event pattern as lib/watchlist.ts, kept as its
// own tiny module since this has nothing to do with the watchlist itself.

export interface ChartIndicatorSettings {
  ma5: boolean;
  ma10: boolean;
  ma20: boolean;
  ma60: boolean;
  bollinger: boolean;
  macd: boolean;
  rsi: boolean;
  kd: boolean;
}

// Off by default: a first-time chart should look like the plain
// candlestick+volume view it always has, not suddenly cluttered with lines
// nobody asked for yet — these are opt-in extras.
export const DEFAULT_INDICATOR_SETTINGS: ChartIndicatorSettings = {
  ma5: false,
  ma10: false,
  ma20: false,
  ma60: false,
  bollinger: false,
  macd: false,
  rsi: false,
  kd: false,
};

const STORAGE_KEY = "stockradar:chart-indicators";
export const INDICATOR_SETTINGS_CHANGED_EVENT = "stockradar:chart-indicators-changed";

// Cache the parsed settings keyed by the raw string, so repeated calls
// return the same object reference when storage hasn't actually changed —
// required for useSyncExternalStore (StockChart.tsx), which otherwise
// treats a fresh object reference as a change on every render and can loop.
// Same pattern as lib/watchlist.ts's getWatchlist().
let cachedRaw: string | null = null;
let cachedSettings: ChartIndicatorSettings = DEFAULT_INDICATOR_SETTINGS;

export function getIndicatorSettings(): ChartIndicatorSettings {
  if (typeof window === "undefined") return DEFAULT_INDICATOR_SETTINGS;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_INDICATOR_SETTINGS;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    if (!raw) {
      cachedSettings = DEFAULT_INDICATOR_SETTINGS;
    } else {
      try {
        cachedSettings = { ...DEFAULT_INDICATOR_SETTINGS, ...JSON.parse(raw) };
      } catch {
        cachedSettings = DEFAULT_INDICATOR_SETTINGS;
      }
    }
  }
  return cachedSettings;
}

export function setIndicatorSettings(settings: ChartIndicatorSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new Event(INDICATOR_SETTINGS_CHANGED_EVENT));
  } catch {
    // localStorage unavailable (private mode, blocked) — the checkbox still
    // updates this tab's own chart via local state, it just won't persist.
  }
}
