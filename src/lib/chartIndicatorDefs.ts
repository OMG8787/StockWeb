import { HistogramSeries, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/lib/data/types";
import { computeBollingerSeries, computeKdSeries, computeMacdSeries, computeMaSeries, computeRsiSeries } from "@/lib/indicators";
import type { readChartPalette } from "@/lib/theme";
import type { ChartIndicatorSettings } from "@/lib/chartIndicatorSettings";

// 2026-09-23 從 StockChart.tsx 拆出來的「技術指標怎麼畫」table。原本每加一種指標要
// 同時改5個地方（refs宣告、建立series、套用資料、色票常數、設定選單清單），這裡把
// 「一種指標長怎樣」收斂成一個物件（要哪個設定值開關、要不要獨立子圖、怎麼建立
// series、怎麼從K線算出資料），StockChart.tsx只要照這份清單跑迴圈，之後要加新指標
// 只需要在下面 INDICATOR_DEFS 加一個物件，不用再回頭改元件裡的5個地方。

export type ChartPalette = ReturnType<typeof readChartPalette>;
export type IndicatorSeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

export interface IndicatorPointData {
  time: string;
  value: number;
  /** 只有MACD柱狀圖需要逐點上色（多方/空方顏色），其他指標的線圖不吃這個欄位。 */
  color?: string;
}

export interface IndicatorDef {
  key: keyof ChartIndicatorSettings;
  label: string;
  /** "price"：跟K線共用同一個價格主圖（pane 0）；"sub"：需要獨立的數值範圍子圖。 */
  pane: "price" | "sub";
  /** paneIndex 只有 pane==="sub" 的指標會用到；price-pane的指標不必理會這個參數，
   *  不傳給 chart.addSeries() 時 lightweight-charts 預設就是 pane 0。 */
  createSeries(chart: IChartApi, palette: ChartPalette, paneIndex: number): Record<string, IndicatorSeries>;
  /** 副圖標題與圖例（只有 pane==="sub" 用）：series 名稱對應 createSeries()／computeData() 的 key。 */
  legend?: { title: string; items: { name: string; label: string; color: string; digits?: number }[] };
  computeData(candles: Candle[], palette: ChartPalette): Record<string, IndicatorPointData[]>;
}

// Fixed, saturated colors chosen to read reasonably against both the light
// and dark chart backgrounds — deliberately NOT theme-adjusted the way the
// candlestick/gridline palette is, since these just need to be
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
const KD_J_COLOR = "#a855f7";

const REF_LINE_COLOR = "#9ca3af";
function addRefLines(series: IndicatorSeries, levels: number[]) {
  levels.forEach((price) =>
    series.createPriceLine({ price, color: REF_LINE_COLOR, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" })
  );
}

const LINE_OPTS = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };

function maDef(key: "ma5" | "ma10" | "ma20" | "ma60", label: string, period: number): IndicatorDef {
  return {
    key,
    label,
    pane: "price",
    createSeries: (chart) => ({ line: chart.addSeries(LineSeries, { ...LINE_OPTS, color: MA_COLORS[key] }) }),
    computeData: (candles) => ({ line: computeMaSeries(candles, period) }),
  };
}

export const INDICATOR_DEFS: IndicatorDef[] = [
  maDef("ma5", "MA5", 5),
  maDef("ma10", "MA10", 10),
  maDef("ma20", "MA20", 20),
  maDef("ma60", "MA60", 60),
  {
    key: "bollinger",
    label: "布林通道",
    pane: "price",
    createSeries: (chart) => ({
      upper: chart.addSeries(LineSeries, { ...LINE_OPTS, color: BOLLINGER_COLOR }),
      middle: chart.addSeries(LineSeries, { ...LINE_OPTS, color: BOLLINGER_COLOR, lineStyle: 2 }),
      lower: chart.addSeries(LineSeries, { ...LINE_OPTS, color: BOLLINGER_COLOR }),
    }),
    computeData: (candles) => {
      const b = computeBollingerSeries(candles);
      return { upper: b.upper, middle: b.middle, lower: b.lower };
    },
  },
  {
    key: "macd",
    label: "MACD",
    pane: "sub",
    legend: {
      title: "MACD(12,26,9)",
      items: [
        { name: "macd", label: "DIF", color: MACD_COLOR, digits: 2 },
        { name: "signal", label: "DEA", color: MACD_SIGNAL_COLOR, digits: 2 },
        { name: "histogram", label: "柱", color: "#6b7280", digits: 2 },
      ],
    },
    createSeries: (chart, palette, paneIndex) => ({
      histogram: chart.addSeries(HistogramSeries, { color: palette.textMuted, priceLineVisible: false, lastValueVisible: false }, paneIndex),
      macd: chart.addSeries(LineSeries, { ...LINE_OPTS, color: MACD_COLOR }, paneIndex),
      signal: chart.addSeries(LineSeries, { ...LINE_OPTS, color: MACD_SIGNAL_COLOR }, paneIndex),
    }),
    computeData: (candles, palette) => {
      const m = computeMacdSeries(candles);
      return {
        macd: m.macd,
        signal: m.signal,
        histogram: m.histogram.map((p) => ({ ...p, color: p.value >= 0 ? palette.priceUpSoft : palette.priceDownSoft })),
      };
    },
  },
  {
    key: "kd",
    label: "KDJ",
    pane: "sub",
    legend: {
      title: "KDJ(9,3,3) 券商常用算法",
      items: [
        { name: "k", label: "K", color: KD_K_COLOR, digits: 1 },
        { name: "d", label: "D", color: KD_D_COLOR, digits: 1 },
        { name: "j", label: "J", color: KD_J_COLOR, digits: 1 },
      ],
    },
    createSeries: (chart, _palette, paneIndex) => {
      const k = chart.addSeries(LineSeries, { ...LINE_OPTS, color: KD_K_COLOR }, paneIndex);
      const d = chart.addSeries(LineSeries, { ...LINE_OPTS, color: KD_D_COLOR }, paneIndex);
      const j = chart.addSeries(LineSeries, { ...LINE_OPTS, color: KD_J_COLOR }, paneIndex);
      addRefLines(k, [20, 80]);
      return { k, d, j };
    },
    computeData: (candles) => {
      const kd = computeKdSeries(candles);
      return { k: kd.k, d: kd.d, j: kd.j };
    },
  },
  {
    key: "rsi",
    label: "RSI",
    pane: "sub",
    legend: { title: "RSI(14) 券商常用算法", items: [{ name: "line", label: "RSI", color: RSI_COLOR, digits: 1 }] },
    createSeries: (chart, _palette, paneIndex) => {
      const line = chart.addSeries(LineSeries, { ...LINE_OPTS, color: RSI_COLOR }, paneIndex);
      addRefLines(line, [30, 70]);
      return { line };
    },
    computeData: (candles) => ({ line: computeRsiSeries(candles) }),
  },
];

/**
 * 暖機用：指標是用「暖機K線＋顯示K線」一起算的，算完要把早於顯示區間第一根的點丟掉，
 * 否則指標線會把時間軸往左撐出一段沒有K線的空白。日線時間是 "YYYY-MM-DD"，字串比較即可。
 */
export function trimIndicatorData(
  data: Record<string, IndicatorPointData[]>,
  fromTime: string
): Record<string, IndicatorPointData[]> {
  return Object.fromEntries(Object.entries(data).map(([name, points]) => [name, points.filter((p) => p.time >= fromTime)]));
}

/**
 * 把 computeData() 算出來的資料塞進 createSeries() 建立的對應 series。
 *
 * Line／Histogram 兩種 series 的 setData() 型別不完全相容（Histogram 多吃一個逐點
 * `color`），但實際資料形狀（time/value，選擇性帶 color）已經統一，值得用一次型別
 * 轉換換來不用整份迴圈複製兩份——這裡的 `as never` 只是繞過 lightweight-charts自己
 * 的 LineData/HistogramData 型別區分，不影響實際塞進去的資料內容。
 */
export function applyIndicatorData(
  seriesMap: Record<string, IndicatorSeries>,
  data: Record<string, IndicatorPointData[]>
): void {
  for (const [name, points] of Object.entries(data)) {
    const series = seriesMap[name];
    if (!series) continue;
    series.setData(
      points.map((p) => ({
        time: p.time as unknown as UTCTimestamp,
        value: p.value,
        ...(p.color !== undefined ? { color: p.color } : {}),
      })) as never
    );
  }
}
