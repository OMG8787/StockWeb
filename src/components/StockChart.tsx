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
import { sanitizeCandles } from "@/lib/data/candleSanity";
import { computeSignals } from "@/lib/signals";
import { applyIndicatorData, INDICATOR_DEFS, trimIndicatorData, type IndicatorSeries } from "@/lib/chartIndicatorDefs";
import { formatPrice, formatVolume } from "@/lib/format";
import { readChartPalette, subscribeToTheme } from "@/lib/theme";
import {
  DEFAULT_INDICATOR_SETTINGS,
  INDICATOR_SETTINGS_CHANGED_EVENT,
  getIndicatorSettings,
  setIndicatorSettings,
  type ChartIndicatorSettings,
} from "@/lib/chartIndicatorSettings";
import { getPollDecision } from "@/lib/pollingSchedule";
import { useLivePolling } from "@/lib/useLivePolling";
import { livePollInit } from "@/lib/livePoll";
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
  accent: "#2a78d6",
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
  // 記錄`candles`這批資料實際是哪個range抓回來的——不能直接拿當下的`range`/
  // `isIntraday`來解讀它。快速切換range時（尤其today跟其他range之間切換），
  // 抓取效果刻意讓`candles`保留上一個range的資料直到新的fetch完成（見下方
  // fetch effect的註解，避免畫面在等待時整個變空白），但`range`state本身
  // 已經立刻切換了——如果`chartData`拿當下最新的`range`去解讀舊資料的
  // `c.time`格式（daily是純日期字串、today是完整ISO時間戳，兩種格式不能
  // 混用），會餵給lightweight-charts格式不符的時間值直接噴錯
  // （`Invalid date string=..., expected format=yyyy-mm-dd`）。用這個
  // 額外state記住「candles實際的資料形狀」，資料形狀判斷永遠跟資料本身
  // 綁在一起更新，不會有中間態。
  const [candlesRange, setCandlesRange] = useState<ChartRange>("3m");
  // 指標暖機用的更早日K（API `warmup=1`，見 lib/data/chart.ts CHART_WARMUP_RANGE）：只拿來算
  // MA／MACD／KD／RSI，不畫K線；跟 candles 在同一個 handler 一起更新，不會錯位。
  const [warmupCandles, setWarmupCandles] = useState<Candle[]>([]);
  const isCandlesIntraday = candlesRange === "today";
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
  // 每個技術指標建立出來的series，用INDICATOR_DEFS的key查表——MA/RSI是單一條線
  // （key固定叫"line"），Bollinger是upper/middle/lower，MACD是histogram/macd/signal，
  // KD是k/d，各指標實際用哪些名字由 chartIndicatorDefs.ts 的 createSeries() 決定，
  // 這裡不需要知道細節。
  const indicatorSeriesRef = useRef<Partial<Record<keyof ChartIndicatorSettings, Record<string, IndicatorSeries>>>>({});
  const candleMapRef = useRef<Map<string, Candle>>(new Map());
  // 副圖標題＋數值圖例（DOM 疊在各副圖左上角）：資料依 時間→數值 存起來，十字線移動時查表。
  const legendLayerRef = useRef<HTMLDivElement | null>(null);
  const legendApiRef = useRef<{ render: (timeKey: string | null) => void; layout: () => void } | null>(null);
  const indicatorValuesRef = useRef<Record<string, Record<string, Map<string, number>>>>({});
  const indicatorLastRef = useRef<Record<string, Record<string, number>>>({});
  const currency = market === "TW" ? "TWD" : "USD";
  // Live values for the crosshair callback, which is registered once but
  // has to keep reflecting the current theme and the current symbol.
  const paletteRef = useRef(FALLBACK_PALETTE);
  const formatRef = useRef({ currency, market });
  useEffect(() => {
    formatRef.current = { currency, market };
  }, [currency, market]);

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
    fetch(`/api/chart/${encodeURIComponent(symbol)}?range=${range}&market=${market}&warmup=1`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "圖表資料暫時無法取得");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        // 第二道防線：資料層已濾掉不合法K棒（見 candleSanity.ts），這裡再濾一次，
        // 防止舊快取或未來新資料源漏網的 null/NaN 讓 lightweight-charts 丟出
        // "Value is null" 整張圖畫不出來；指標/訊號也都吃這份已清理的 candles。
        setCandles(sanitizeCandles(data.candles));
        setWarmupCandles(sanitizeCandles(data.warmupCandles ?? []));
        setCandlesRange(range);
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

  // 盤中自動延伸最新一根（2026-10-06 使用者要求：待在同一頁不動也要即時更新）。節奏跟全站報價輪詢同一套
  // （getPollDecision：盤中 30 秒、背景分頁暫停、切回前景補抓、14:40 補最後一次）。背景重抓只換資料、
  // 不顯示載入遮罩、不呼叫 fitContent（不重置使用者的縮放／平移，見 skipFitRef）；失敗或資料沒變就什麼都不做。
  const rangeRef = useRef(range);
  const loadingRef = useRef(isLoading);
  const skipFitRef = useRef(false);
  const candlesRef = useRef(candles);
  useEffect(() => {
    rangeRef.current = range;
    loadingRef.current = isLoading;
    candlesRef.current = candles;
  });
  useLivePolling({
    restartKey: `${market}:${symbol}`,
    decide: (now, settledDayKey) => getPollDecision(market, now, settledDayKey),
    onFetch: async () => {
      const polledRange = rangeRef.current;
      if (loadingRef.current) return; // 使用者剛切換區間，等主抓取完成
      try {
        const res = await fetch(
          `/api/chart/${encodeURIComponent(symbol)}?range=${polledRange}&market=${market}`,
          livePollInit({ mount: false }) // 背景輪詢：過期值多等一下拿新值（見 lib/livePoll.ts）
        );
        if (!res.ok) return;
        const data = await res.json();
        if (rangeRef.current !== polledRange || loadingRef.current) return; // 抓的期間使用者切了區間
        const next = sanitizeCandles(data.candles);
        const prev = candlesRef.current;
        const last = next[next.length - 1];
        const prevLast = prev?.[prev.length - 1];
        if (
          prev &&
          next.length === prev.length &&
          last &&
          prevLast &&
          last.time === prevLast.time &&
          last.close === prevLast.close &&
          last.high === prevLast.high &&
          last.low === prevLast.low &&
          last.volume === prevLast.volume
        ) {
          return; // 沒有新資料
        }
        if (next.length === 0) return;
        skipFitRef.current = true;
        setCandles(next);
      } catch {
        // 保持畫面上最後一次成功的圖
      }
    },
  });

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
  const activeSubPaneDefs = useMemo(
    () => (isIntraday ? [] : INDICATOR_DEFS.filter((d) => d.pane === "sub" && indicators[d.key])),
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
    indicatorSeriesRef.current = {};

    // Price-pane overlays: moving averages and Bollinger bands share the
    // same value range as the candles, so they go on pane 0 alongside them.
    // Skipped entirely for "today" — see activeSubPaneDefs' comment above for
    // why these don't mean anything computed over a single day's minute
    // bars instead of many daily ones.
    if (!isIntraday) {
      INDICATOR_DEFS.filter((def) => def.pane === "price" && indicators[def.key]).forEach((def) => {
        indicatorSeriesRef.current[def.key] = def.createSeries(chart, palette, 0);
      });
    }

    // Sub-panes: each gets a fixed index based on INDICATOR_DEFS order among
    // whichever of macd/rsi/kd are actually enabled this time (activeSubPaneDefs
    // preserves that relative order — see its useMemo above).
    activeSubPaneDefs.forEach((def, i) => {
      const paneIndex = i + 1;
      indicatorSeriesRef.current[def.key] = def.createSeries(chart, palette, paneIndex);
    });
    // 副圖高度：價格主圖（含量能）佔大頭，每個副圖約 150px 等分；沒設的話 lightweight-charts
    // 預設每個 pane 平分高度，主圖會被壓扁（2026-10-06 使用者回報看不清楚）。
    if (activeSubPaneDefs.length > 0) {
      const panes = chart.panes();
      panes[0]?.setStretchFactor(3.2);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    }

    // 副圖標題＋數值圖例：DOM 疊層，位置跟著各 pane 的實際位置算（pane 高度會隨視窗縮放）。
    const legendLayer = legendLayerRef.current;
    const legendEls: Record<string, HTMLDivElement> = {};
    if (legendLayer) {
      legendLayer.replaceChildren();
      activeSubPaneDefs.forEach((def) => {
        const el = document.createElement("div");
        el.className = "absolute left-2 text-xs tabular-nums whitespace-nowrap";
        el.style.pointerEvents = "none";
        legendLayer.appendChild(el);
        legendEls[def.key] = el;
      });
    }
    const fmtLegend = (v: number | undefined, digits: number) => (v === undefined ? "—" : v.toFixed(digits));
    legendApiRef.current = {
      render(timeKey) {
        activeSubPaneDefs.forEach((def) => {
          const el = legendEls[def.key];
          if (!el || !def.legend) return;
          const byTime = indicatorValuesRef.current[def.key];
          const last = indicatorLastRef.current[def.key];
          const items = def.legend.items
            .map((it) => {
              const v = timeKey ? byTime?.[it.name]?.get(timeKey) : last?.[it.name];
              return `<span style="color:${it.color};margin-left:8px">${it.label} ${fmtLegend(v, it.digits ?? 2)}</span>`;
            })
            .join("");
          el.innerHTML = `<span style="color:var(--text-secondary);font-weight:600">${def.legend.title}</span>${items}`;
        });
      },
      layout() {
        const container = containerRef.current;
        if (!container) return;
        const panes = chart.panes();
        const base = container.getBoundingClientRect().top;
        activeSubPaneDefs.forEach((def, i) => {
          const el = legendEls[def.key];
          const paneEl = panes[i + 1]?.getHTMLElement();
          if (!el || !paneEl) return;
          el.style.top = `${paneEl.getBoundingClientRect().top - base + 4}px`;
        });
      },
    };
    legendApiRef.current.render(null);
    const resizeObserver = new ResizeObserver(() => legendApiRef.current?.layout());
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    const layoutRaf = requestAnimationFrame(() => legendApiRef.current?.layout());

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      const container = containerRef.current;
      if (!tooltip || !container) return;

      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.opacity = "0";
        legendApiRef.current?.render(null);
        return;
      }
      legendApiRef.current?.render(timeToKey(param.time));
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
      cancelAnimationFrame(layoutRaf);
      resizeObserver.disconnect();
      legendApiRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineSeriesRef.current = null;
      volumeRef.current = null;
    };
    // Recreated on indicator-settings change (activeSubPaneDefs derives from
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
  // 用`isCandlesIntraday`（跟`candles`本身綁在一起更新）判斷資料形狀，
  // 不能用`isIntraday`（跟著`range`立刻切換）——見上面`candlesRange`
  // state的宣告註解，這是修好快速切換range時噴錯的關鍵。
  const toChartTime = (time: string): UTCTimestamp =>
    isCandlesIntraday ? (Math.floor(new Date(time).getTime() / 1000) as UTCTimestamp) : (time as unknown as UTCTimestamp);

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
  }, [candles, candlesRange]);

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

    // Indicator series are only present (in the ref) when their pane/line was
    // actually created for the current settings — each is computed fresh
    // from the full candle set (not incrementally), which is cheap enough at
    // chart-load scale (at most a few thousand candles even for "10年") and
    // avoids having to track partial-update state per series.
    if (candles) {
      // 暖機K線＋顯示K線一起算，算完只留顯示區間內的點（見 trimIndicatorData）。當日走勢沒有暖機也沒有指標。
      const allCandles = isCandlesIntraday || warmupCandles.length === 0 ? candles : [...warmupCandles, ...candles];
      const fromTime = candles[0]?.time ?? "";
      const values: Record<string, Record<string, Map<string, number>>> = {};
      const lasts: Record<string, Record<string, number>> = {};
      INDICATOR_DEFS.forEach((def) => {
        const seriesMap = indicatorSeriesRef.current[def.key];
        if (!seriesMap) return;
        const data = trimIndicatorData(def.computeData(allCandles, paletteRef.current), fromTime);
        applyIndicatorData(seriesMap, data);
        if (def.legend) {
          values[def.key] = {};
          lasts[def.key] = {};
          for (const [name, points] of Object.entries(data)) {
            values[def.key][name] = new Map(points.map((p) => [p.time, p.value]));
            const lastPoint = points[points.length - 1];
            if (lastPoint) lasts[def.key][name] = lastPoint.value;
          }
        }
      });
      indicatorValuesRef.current = values;
      indicatorLastRef.current = lasts;
      legendApiRef.current?.render(null);
      legendApiRef.current?.layout();
    }

    // 背景自動更新（skipFitRef）不重置使用者目前的縮放／平移位置。
    if (skipFitRef.current) skipFitRef.current = false;
    else chartRef.current.timeScale().fitContent();
  }, [chartData, themeTick, chartVersion, candles, warmupCandles, isCandlesIntraday]);

  // Same reasoning as activeSubPaneDefs above: every one of these signals (MA
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
  const chartHeight = 380 + activeSubPaneDefs.length * 150;

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
      </div>
      {/* 技術指標開關（2026-10-06 使用者回報找不到 MACD／KD：原本藏在「⚙ 技術線」下拉裡）。
          直接攤成小按鈕放在週期列正下方；設定照舊存 localStorage（chartIndicatorSettings），所有股票共用。
          「當日」是分時圖，日線指標沒有意義，改顯示說明文字而不是放一排按了沒反應的按鈕。 */}
      {isIntraday ? (
        <p className="mb-3 text-[13px] text-(--text-muted)">當日走勢為分時圖，不顯示日線技術指標（MA／布林／MACD／KDJ／RSI）；切換到「5日」以上即可開啟。</p>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[13px] text-(--text-muted)">技術指標</span>
          {INDICATOR_DEFS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={indicators[key]}
              onClick={() => toggleIndicator(key)}
              className={`rounded-full border px-2.5 py-1 text-[13px] font-medium transition-colors ${
                indicators[key]
                  ? "border-(--accent) bg-(--accent) text-white"
                  : "border-(--gridline) text-(--text-secondary) hover:bg-(--page-plane)"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {signals.length > 0 && (
        <div className="mb-3">
          <SignalTags signals={signals} />
        </div>
      )}
      <div className="relative w-full" style={{ height: chartHeight }}>
        <div ref={containerRef} className="absolute inset-0" />
        <div ref={legendLayerRef} className="pointer-events-none absolute inset-0 z-[5]" />
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
