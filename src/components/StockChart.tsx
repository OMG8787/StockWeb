"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartRange } from "@/lib/data";
import { computeSignals } from "@/lib/signals";
import { computeBollingerSeries, computeKdSeries, computeMacdSeries, computeMaSeries, computeRsiSeries } from "@/lib/indicators";
import { formatPrice, formatVolume } from "@/lib/format";
import { readChartPalette, subscribeToTheme } from "@/lib/theme";
import {
  DEFAULT_INDICATOR_SETTINGS,
  INDICATOR_SETTINGS_CHANGED_EVENT,
  getIndicatorSettings,
  setIndicatorSettings,
  type ChartIndicatorSettings,
} from "@/lib/chartIndicatorSettings";
import SignalTags from "./SignalTags";

function subscribeToIndicatorSettings(callback: () => void) {
  window.addEventListener(INDICATOR_SETTINGS_CHANGED_EVENT, callback);
  return () => window.removeEventListener(INDICATOR_SETTINGS_CHANGED_EVENT, callback);
}

// Only used before the first client-side read of the CSS custom properties.
const FALLBACK_PALETTE = {
  textSecondary: "#52514e",
  gridline: "#e1e0d9",
  priceUp: "#e34948",
  priceDown: "#008300",
  priceUpSoft: "#e3494880",
  priceDownSoft: "#00830080",
  textMuted: "#898781",
};

const RANGE_LABELS: Record<ChartRange, string> = {
  today: "當日",
  "5d": "5日",
  "10d": "10日",
  "1m": "1個月",
  "3m": "3個月",
  "6m": "6個月",
  "1y": "1年",
  "2y": "2年",
  "5y": "5年",
  "10y": "10年",
};
const RANGES: ChartRange[] = ["today", "5d", "10d", "1m", "3m", "6m", "1y", "2y", "5y", "10y"];

// Fixed, saturated colors chosen to read reasonably against both the light
// and dark chart backgrounds — deliberately NOT theme-adjusted the way the
// candlestick/gridline palette below is, since these just need to be
// distinguishable from each other and from the candles, not match either
// theme's accent scheme specifically.
const MA_COLORS: Record<"ma5" | "ma10" | "ma20" | "ma60", string> = {
  ma5: "#f59e0b",
  ma10: "#3b82f6",
  ma20: "#a855f7",
  ma60: "#14b8a6",
};
const BOLLINGER_COLOR = "#6b7280";
const MACD_COLOR = "#3b82f6";
const MACD_SIGNAL_COLOR = "#f59e0b";
const RSI_COLOR = "#a855f7";
const KD_K_COLOR = "#3b82f6";
const KD_D_COLOR = "#f59e0b";

const INDICATOR_LABELS: Array<{ key: keyof ChartIndicatorSettings; label: string }> = [
  { key: "ma5", label: "MA5" },
  { key: "ma10", label: "MA10" },
  { key: "ma20", label: "MA20" },
  { key: "ma60", label: "MA60" },
  { key: "bollinger", label: "布林通道" },
  { key: "macd", label: "MACD" },
  { key: "rsi", label: "RSI" },
  { key: "kd", label: "KD" },
];
// These three need their own sub-pane (a different value range than price);
// order here fixes which pane index each one gets (pane 1, 2, 3...) whenever
// it's enabled, so recreating the chart after a settings change always
// produces the same, stable layout instead of panes shuffling around.
const SUB_PANE_INDICATORS: Array<"macd" | "rsi" | "kd"> = ["macd", "rsi", "kd"];

// The numeric branch used to slice down to just a date ("YYYY-MM-DD"),
// which was harmless while nothing ever actually fed lightweight-charts a
// numeric Time — the daily ranges pass a "YYYY-MM-DD" *string* (accepted by
// lightweight-charts as a business-day string) straight through, so this
// branch was dead code until the "today" intraday range started feeding
// real UTCTimestamp seconds (needed for sub-day resolution — a business-day
// string can't represent a time-of-day at all). Kept as the *full* instant
// now, not truncated, so intraday candles sharing the same calendar date
// don't collide in candleMapRef below.
function timeToKey(t: Time): string {
  if (typeof t === "string") return t;
  if (typeof t === "number") return new Date(t * 1000).toISOString();
  const y = t.year;
  const m = String(t.month).padStart(2, "0");
  const d = String(t.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function StockChart({
  symbol,
  market,
  currentPrice,
}: {
  symbol: string;
  market: "TW" | "US";
  currentPrice: number;
}) {
  const [range, setRange] = useState<ChartRange>("3m");
  const isIntraday = range === "today";
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // useSyncExternalStore (not useState+useEffect+manual event listener):
  // this value lives in localStorage, shared across every chart on the page
  // and updated from outside React (the settings panel below, in principle
  // another tab). getIndicatorSettings() is safe to call as the snapshot
  // getter because it caches by the raw localStorage string and returns the
  // same object reference when nothing changed — a fresh object on every
  // call would make React think the store changed on every render and loop
  // (see lib/watchlist.ts's getWatchlist() for the same pattern/footnote).
  // getServerSnapshot always returns the same DEFAULT_INDICATOR_SETTINGS
  // reference so server-rendered markup and the first client render agree
  // before localStorage is ever read.
  const indicators = useSyncExternalStore(
    subscribeToIndicatorSettings,
    getIndicatorSettings,
    () => DEFAULT_INDICATOR_SETTINGS
  );
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Two separate refs (rather than one unioned "either kind" ref) because
  // only one is ever actually created per chart instance — see isIntraday
  // below: "today" gets a plain price line (what a user actually asked
  // for — a single day's open/high/low/close per *minute* reads as noise,
  // not signal, compared to a continuous line of where the price has been),
  // every other range keeps the existing candlestick.
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const maSeriesRef = useRef<Partial<Record<"ma5" | "ma10" | "ma20" | "ma60", ISeriesApi<"Line">>>>({});
  const bollingerSeriesRef = useRef<{ upper?: ISeriesApi<"Line">; middle?: ISeriesApi<"Line">; lower?: ISeriesApi<"Line"> }>({});
  const macdSeriesRef = useRef<{ macd?: ISeriesApi<"Line">; signal?: ISeriesApi<"Line">; histogram?: ISeriesApi<"Histogram"> }>({});
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const kdSeriesRef = useRef<{ k?: ISeriesApi<"Line">; d?: ISeriesApi<"Line"> }>({});
  const candleMapRef = useRef<Map<string, Candle>>(new Map());
  const currency = market === "TW" ? "TWD" : "USD";
  // Live values for the crosshair callback, which is registered once but
  // has to keep reflecting the current theme and the current symbol.
  const paletteRef = useRef(FALLBACK_PALETTE);
  const formatRef = useRef({ currency, market });
  useEffect(() => {
    formatRef.current = { currency, market };
  }, [currency, market]);

  // 2026-09-23 Opus地毯式巡檢抓到：「技術線」設定選單原本只能靠再點一次
  // ⚙按鈕才會收合，點選單以外的地方或按Esc都沒反應，選單會一直蓋住K線圖
  // 右側的價格軸。比照SiteHeader.tsx搜尋建議清單「點外面收起」的既有做法，
  // 補上點外部/按Esc關閉。
  useEffect(() => {
    if (!showSettings) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setShowSettings(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setShowSettings(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showSettings]);

  function toggleIndicator(key: keyof ChartIndicatorSettings) {
    // No local setState call needed: setIndicatorSettings() writes to
    // localStorage and dispatches INDICATOR_SETTINGS_CHANGED_EVENT, which
    // the useSyncExternalStore subscription above already reacts to — this
    // chart (and any other chart on the page) re-renders with the new
    // settings from that, the same as if the change came from another tab.
    setIndicatorSettings({ ...indicators, [key]: !indicators[key] });
  }

  useEffect(() => {
    let cancelled = false;
    // Switching range (especially a heavier one like "10年") could take
    // several seconds, and candles/error both deliberately keep their
    // previous values during that wait (jarring to blank the whole chart
    // for what might resolve in 200ms) — but that meant nothing on screen
    // changed at all while a slower fetch was in flight, which read as "the
    // button didn't do anything" rather than "still loading." isLoading
    // drives a visible overlay for exactly that gap, on top of whichever
    // chart is still showing.
    //
    // This is a genuine "synchronize with an external system" effect (fetch
    // a new chart on symbol/market/range change), not the "derive state
    // from props" case the react-hooks/set-state-in-effect rule is meant to
    // catch — there's no prop this isLoading flag could instead be computed
    // from, it's tracking an in-flight network request that only this
    // effect knows about. The other set-state-in-effect this file used to
    // have (mirroring chartIndicatorSettings' localStorage) was a real
    // instance of the rule's target case and got removed by switching that
    // one to useSyncExternalStore instead; this one doesn't have an
    // equivalent external-store refactor available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    fetch(`/api/chart/${encodeURIComponent(symbol)}?range=${range}&market=${market}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "圖表資料暫時無法取得");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setCandles(data.candles);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setCandles(null);
          setError(err.message ?? "圖表資料暫時無法取得");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, market, range]);

  // Which sub-panes (MACD/RSI/KD, each needs its own value-range pane
  // distinct from price) are needed for the CURRENT settings, and at which
  // index — recomputed whenever settings change, feeding the chart-creation
  // effect below so panes are added in the same fixed order every time.
  // Forced empty for "today": MA/Bollinger/MACD/RSI/KD are all computed over
  // many DAILY bars (a 20-day MA, an RSI over 14 daily closes) — run against
  // a single day's minute bars instead, "MA20" would just be a near-flat
  // line of the last 20 minutes' average, a meaningless number dressed up as
  // a familiar indicator. Simpler and more honest to not offer them at all
  // for the one intraday range than to compute something technically
  // "there" but conceptually wrong.
  const activeSubPanes = useMemo(
    () => (isIntraday ? [] : SUB_PANE_INDICATORS.filter((k) => indicators[k])),
    [indicators, isIntraday]
  );

  // Recreated (not just updated) whenever which indicators are enabled
  // changes: lightweight-charts' pane indices shift when a pane is removed,
  // which makes incremental add/remove error-prone to get right for an
  // arbitrary combination of toggled indicators — tearing down and
  // rebuilding with exactly the panes the CURRENT settings need is far
  // simpler and, since toggling a checkbox is an infrequent, deliberate
  // action (not something that happens on every render), an acceptable
  // cost. Data itself is applied in the separate effect below, keyed on
  // `chartVersion` so it re-runs after every rebuild here too.
  const [chartVersion, setChartVersion] = useState(0);
  useEffect(() => {
    if (!containerRef.current) return;
    const palette = readChartPalette();
    paletteRef.current = palette;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: palette.textSecondary,
      },
      grid: {
        vertLines: { color: palette.gridline },
        horzLines: { color: palette.gridline },
      },
      rightPriceScale: { borderColor: palette.gridline },
      // timeVisible: without it, lightweight-charts' default axis formatter
      // is date-oriented and — fed a whole day's worth of same-day
      // timestamps — just prints the same "15日" (today's date) under every
      // tick, telling a viewer nothing about *when* within the day each
      // point is. Scoped to isIntraday only: the daily ranges' ticks are
      // already dates, and showing a time-of-day on those would be
      // meaningless (every daily candle's "time" is midnight).
      timeScale: { borderColor: palette.gridline, timeVisible: isIntraday, secondsVisible: false },
      autoSize: true,
    });

    // "today" gets a plain price line instead of a candlestick — see the
    // ref declarations' comment for why. Uses the neutral site accent
    // rather than a red/green up/down color: a single line can't honestly
    // represent "up or down" for a whole day when the price moves both
    // ways within it, unlike a daily candle which really is one clean
    // up-or-down move.
    const series = isIntraday
      ? undefined
      : chart.addSeries(CandlestickSeries, {
          upColor: palette.priceUp,
          downColor: palette.priceDown,
          borderUpColor: palette.priceUp,
          borderDownColor: palette.priceDown,
          wickUpColor: palette.priceUp,
          wickDownColor: palette.priceDown,
        });
    const lineSeries = isIntraday
      ? chart.addSeries(LineSeries, {
          color: palette.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
        })
      : undefined;

    const volume = chart.addSeries(HistogramSeries, {
      // lightweight-charts' built-in "volume" formatter always abbreviates
      // with K/M/B (US convention) — on a TW chart that showed the axis
      // label as e.g. "21.13M" while every other volume figure on the same
      // page (header, tooltip) correctly reads in 張 via formatVolume(),
      // a mismatch an Opus QA pass flagged. A custom formatter routes this
      // one through the same shared formatVolume() so all three agree.
      priceFormat: { type: "custom", formatter: (price: number) => formatVolume(price, market), minMove: 1 },
      priceScaleId: "volume",
      color: palette.textMuted,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    (series ?? lineSeries)!.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

    chartRef.current = chart;
    seriesRef.current = series ?? null;
    lineSeriesRef.current = lineSeries ?? null;
    volumeRef.current = volume;
    maSeriesRef.current = {};
    bollingerSeriesRef.current = {};
    macdSeriesRef.current = {};
    rsiSeriesRef.current = null;
    kdSeriesRef.current = {};

    // Price-pane overlays: moving averages and Bollinger bands share the
    // same value range as the candles, so they go on pane 0 alongside them.
    // Skipped entirely for "today" — see activeSubPanes' comment above for
    // why these don't mean anything computed over a single day's minute
    // bars instead of many daily ones.
    if (!isIntraday) {
      (["ma5", "ma10", "ma20", "ma60"] as const).forEach((key) => {
        if (!indicators[key]) return;
        maSeriesRef.current[key] = chart.addSeries(LineSeries, {
          color: MA_COLORS[key],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
      });
      if (indicators.bollinger) {
        const opts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        bollingerSeriesRef.current.upper = chart.addSeries(LineSeries, { ...opts, color: BOLLINGER_COLOR });
        bollingerSeriesRef.current.middle = chart.addSeries(LineSeries, { ...opts, color: BOLLINGER_COLOR, lineStyle: 2 });
        bollingerSeriesRef.current.lower = chart.addSeries(LineSeries, { ...opts, color: BOLLINGER_COLOR });
      }
    }

    // Sub-panes: each gets a fixed index based on SUB_PANE_INDICATORS order
    // among whichever of macd/rsi/kd are actually enabled this time.
    activeSubPanes.forEach((key, i) => {
      const paneIndex = i + 1;
      if (key === "macd") {
        macdSeriesRef.current.histogram = chart.addSeries(
          HistogramSeries,
          { color: palette.textMuted, priceLineVisible: false, lastValueVisible: false },
          paneIndex
        );
        macdSeriesRef.current.macd = chart.addSeries(
          LineSeries,
          { color: MACD_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex
        );
        macdSeriesRef.current.signal = chart.addSeries(
          LineSeries,
          { color: MACD_SIGNAL_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex
        );
      } else if (key === "rsi") {
        rsiSeriesRef.current = chart.addSeries(
          LineSeries,
          { color: RSI_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex
        );
      } else if (key === "kd") {
        kdSeriesRef.current.k = chart.addSeries(
          LineSeries,
          { color: KD_K_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex
        );
        kdSeriesRef.current.d = chart.addSeries(
          LineSeries,
          { color: KD_D_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex
        );
      }
    });

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      const container = containerRef.current;
      if (!tooltip || !container) return;

      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.opacity = "0";
        return;
      }
      const candle = candleMapRef.current.get(timeToKey(param.time));
      if (!candle) {
        tooltip.style.opacity = "0";
        return;
      }

      // Read through refs, never the values captured when the chart was
      // created: this callback outlives both a theme switch and a change of
      // symbol/market, and a stale capture would draw a light-theme tooltip
      // over a dark chart, or format a US price with TW 張/TWD rules.
      const { priceUp, priceDown, textMuted } = paletteRef.current;
      const { currency, market } = formatRef.current;

      if (isIntraday) {
        // A 1-minute bar's own open/high/low barely differ from its close
        // (a minute of trading, not a whole day) — showing all four the way
        // the daily view does mostly just repeats the same number four
        // times. Just the traded price and that minute's volume, the two
        // things actually worth reading off an intraday chart at a glance.
        // candle.time was deliberately shifted to exchange-local wall-clock
        // time before it ever reached the chart (see
        // fetchYahooIntradayCandles) — read it back with UTC accessors, not
        // the browser's own local-timezone ones, or this would shift it a
        // second time.
        const d = new Date(candle.time);
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mm = String(d.getUTCMinutes()).padStart(2, "0");
        tooltip.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px">${hh}:${mm}</div>
          <div style="display:grid;grid-template-columns:auto auto;column-gap:10px;row-gap:2px;font-variant-numeric:tabular-nums">
            <span style="color:${textMuted}">價</span><span style="font-weight:600">${formatPrice(candle.close, currency)}</span>
            <span style="color:${textMuted}">量</span><span>${formatVolume(candle.volume, market)}</span>
          </div>
        `;
      } else {
        const up = candle.close >= candle.open;
        const dirColor = up ? priceUp : priceDown;
        tooltip.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px">${candle.time}</div>
          <div style="display:grid;grid-template-columns:auto auto;column-gap:10px;row-gap:2px;font-variant-numeric:tabular-nums">
            <span style="color:${textMuted}">開</span><span>${formatPrice(candle.open, currency)}</span>
            <span style="color:${textMuted}">高</span><span style="color:${priceUp}">${formatPrice(candle.high, currency)}</span>
            <span style="color:${textMuted}">低</span><span style="color:${priceDown}">${formatPrice(candle.low, currency)}</span>
            <span style="color:${textMuted}">收</span><span style="color:${dirColor};font-weight:600">${formatPrice(candle.close, currency)}</span>
            <span style="color:${textMuted}">量</span><span>${formatVolume(candle.volume, market)}</span>
          </div>
        `;
      }
      tooltip.style.opacity = "1";

      const pad = 14;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      let left = param.point.x + pad;
      if (left + tw > container.clientWidth) left = param.point.x - tw - pad;
      let top = param.point.y + pad;
      if (top + th > container.clientHeight) top = container.clientHeight - th - pad;
      tooltip.style.left = `${Math.max(0, left)}px`;
      tooltip.style.top = `${Math.max(0, top)}px`;
    });

    setChartVersion((v) => v + 1);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineSeriesRef.current = null;
      volumeRef.current = null;
    };
    // Recreated on indicator-settings change (activeSubPanes derives from
    // it) — theme changes are handled separately below via applyOptions
    // rather than a full recreate. Also recreated when crossing into/out of
    // "today" specifically (isIntraday, not raw `range`) — that's what
    // decides whether the MA/Bollinger/sub-pane series above get created at
    // all (see the `range !== "today"` guards); depending on raw `range`
    // instead would tear down and rebuild the whole chart (losing zoom/pan)
    // on every single range switch, even between two ranges that don't
    // actually change which panes exist (e.g. "3m" -> "6m").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, isIntraday]);

  // The chart paints itself imperatively, so unlike the rest of the page it
  // does not follow a theme switch on its own — without this it keeps the
  // palette that was in effect when it was created, leaving light-grey
  // gridlines and axis labels sitting on the dark surface (and vice versa).
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => subscribeToTheme(() => setThemeTick((t) => t + 1)), []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const lineSeries = lineSeriesRef.current;
    const volume = volumeRef.current;
    if (!chart || (!series && !lineSeries) || !volume) return;
    const palette = readChartPalette();
    paletteRef.current = palette;
    chart.applyOptions({
      layout: { textColor: palette.textSecondary },
      grid: { vertLines: { color: palette.gridline }, horzLines: { color: palette.gridline } },
      rightPriceScale: { borderColor: palette.gridline },
      timeScale: { borderColor: palette.gridline },
    });
    series?.applyOptions({
      upColor: palette.priceUp,
      downColor: palette.priceDown,
      borderUpColor: palette.priceUp,
      borderDownColor: palette.priceDown,
      wickUpColor: palette.priceUp,
      wickDownColor: palette.priceDown,
    });
    lineSeries?.applyOptions({ color: palette.accent });
    volume.applyOptions({ color: palette.textMuted });
  }, [themeTick, chartVersion]);

  // Shape only — the volume bars' colours are theme-dependent and so are
  // applied in the effect below, which runs after the palette has been
  // refreshed. Deriving them here instead would read the previous palette,
  // since render happens before effects, leaving the bars one toggle behind.
  // Daily ranges: c.time is a plain "YYYY-MM-DD" string, which
  // lightweight-charts accepts directly as a business-day string (the `as
  // unknown as UTCTimestamp` is a type-level lie, not a runtime one — it's
  // never actually treated as a numeric timestamp). The "today" intraday
  // range instead needs a REAL numeric UTCTimestamp (seconds) so
  // lightweight-charts can place points within a single day — a business-day
  // string has no time-of-day component at all.
  const toChartTime = (time: string): UTCTimestamp =>
    isIntraday ? (Math.floor(new Date(time).getTime() / 1000) as UTCTimestamp) : (time as unknown as UTCTimestamp);

  const chartData = useMemo(() => {
    if (!candles) return null;
    return {
      candles: candles.map((c) => ({
        time: toChartTime(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
      volume: candles.map((c) => ({
        time: toChartTime(c.time),
        value: c.volume,
        rising: c.close >= c.open,
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, range]);

  useEffect(() => {
    candleMapRef.current = new Map((candles ?? []).map((c) => [c.time, c]));
  }, [candles]);

  useEffect(() => {
    if (!chartData || (!seriesRef.current && !lineSeriesRef.current) || !volumeRef.current || !chartRef.current) return;
    const { priceUpSoft, priceDownSoft } = paletteRef.current;
    seriesRef.current?.setData(chartData.candles);
    lineSeriesRef.current?.setData(chartData.candles.map((c) => ({ time: c.time, value: c.close })));
    volumeRef.current.setData(
      chartData.volume.map((v) => ({
        time: v.time,
        value: v.value,
        color: v.rising ? priceUpSoft : priceDownSoft,
      }))
    );

    // Indicator series are only present (in the refs) when their pane/line
    // was actually created for the current settings — each is computed
    // fresh from the full candle set (not incrementally), which is cheap
    // enough at chart-load scale (at most a few thousand candles even for
    // "10年") and avoids having to track partial-update state per series.
    if (candles) {
      (["ma5", "ma10", "ma20", "ma60"] as const).forEach((key) => {
        const s = maSeriesRef.current[key];
        if (!s) return;
        const period = { ma5: 5, ma10: 10, ma20: 20, ma60: 60 }[key];
        s.setData(computeMaSeries(candles, period).map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
      });
      if (bollingerSeriesRef.current.upper) {
        const b = computeBollingerSeries(candles);
        bollingerSeriesRef.current.upper.setData(b.upper.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
        bollingerSeriesRef.current.middle?.setData(b.middle.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
        bollingerSeriesRef.current.lower?.setData(b.lower.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
      }
      if (macdSeriesRef.current.macd) {
        const m = computeMacdSeries(candles);
        macdSeriesRef.current.macd.setData(m.macd.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
        macdSeriesRef.current.signal?.setData(m.signal.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
        macdSeriesRef.current.histogram?.setData(
          m.histogram.map((p) => ({
            time: p.time as unknown as UTCTimestamp,
            value: p.value,
            color: p.value >= 0 ? paletteRef.current.priceUpSoft : paletteRef.current.priceDownSoft,
          }))
        );
      }
      if (rsiSeriesRef.current) {
        rsiSeriesRef.current.setData(
          computeRsiSeries(candles).map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value }))
        );
      }
      if (kdSeriesRef.current.k) {
        const kd = computeKdSeries(candles);
        kdSeriesRef.current.k.setData(kd.k.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
        kdSeriesRef.current.d?.setData(kd.d.map((p) => ({ time: p.time as unknown as UTCTimestamp, value: p.value })));
      }
    }

    chartRef.current.timeScale().fitContent();
  }, [chartData, themeTick, chartVersion, candles]);

  // Same reasoning as activeSubPanes above: every one of these signals (MA
  // alignment, RSI, MACD, volume-vs-trailing-average) is defined in terms of
  // daily bars, so computing them against a single day's minute bars would
  // just produce a number shaped like a familiar signal without the
  // familiar signal's actual meaning.
  const signals = useMemo(
    () => (candles && !isIntraday ? computeSignals(candles, currentPrice, range) : []),
    [candles, currentPrice, range, isIntraday]
  );

  // Sub-panes each need real vertical room of their own, or MACD/RSI/KD
  // render squashed into a sliver under the price pane.
  const chartHeight = 360 + activeSubPanes.length * 130;

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                r === range
                  ? "bg-(--accent) text-white"
                  : "text-(--text-secondary) hover:bg-(--page-plane)"
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        {/* Hidden for "today" rather than shown-but-inert: every one of
            these indicators is computed over daily bars (see activeSubPanes'
            comment), so none of them would actually appear on an intraday
            chart even with a box checked — a visible-but-nonfunctional
            control is more confusing than no control at all. */}
        {!isIntraday && (
        <div className="relative" ref={settingsRef}>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-md border border-(--gridline) px-3 py-1.5 text-sm font-medium text-(--text-secondary) hover:bg-(--page-plane)"
          >
            ⚙ 技術線
          </button>
          {showSettings && (
            <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-(--gridline) bg-(--surface-1) p-2 shadow-lg">
              <p className="mb-1 px-1 text-[13px] text-(--text-muted)">套用到所有股票的圖表</p>
              {INDICATOR_LABELS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-(--page-plane)">
                  <input type="checkbox" checked={indicators[key]} onChange={() => toggleIndicator(key)} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
      {signals.length > 0 && (
        <div className="mb-3">
          <SignalTags signals={signals} />
        </div>
      )}
      <div className="relative w-full" style={{ height: chartHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-10 rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 text-xs shadow-lg opacity-0 transition-opacity"
        />
        {error && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-(--text-muted)">{error}</p>
        )}
        {!error && !candles && (
          <div className="absolute inset-0 animate-pulse rounded-md bg-(--page-plane)" />
        )}
        {/* z-20 on the pill below: without an explicit z-index it paints at
            `auto`, and lightweight-charts' price-axis canvas (inside the
            sibling `absolute inset-0` container) wins the painting order and
            draws its scale labels straight over the "載入中…" text — reproduced
            on /stock/1717, where the 85.00 label sits exactly at the pill's
            row. z-20 also clears the z-10 crosshair tooltip in the same box. */}
        {isLoading && candles && (
          <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full border border-(--gridline) bg-(--surface-1) px-2.5 py-1 text-[13px] text-(--text-muted) shadow">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-(--text-muted) border-t-transparent" />
            載入中…
          </div>
        )}
      </div>
      <p className="mt-2 text-[13px] text-(--text-muted)">將滑鼠移到圖表上可查看該日詳細開高低收與成交量</p>
    </div>
  );
}
