import type { Candle } from "./types";

/**
 * K棒合法性檢查——資料層（twse/tpex/us 產出 candles 時）與 StockChart.tsx
 * （餵給 lightweight-charts 前）共用的同一套判斷，純函式、無任何 server 端依賴，
 * client component 可以直接 import。
 *
 * 為什麼需要：TWSE STOCK_DAY 對「當天只有零星/鉅額成交、沒有一般交易開高低收」
 * 的日子會回 `"--"`（例：1470 在 2026-09-03 成交 20 股、1 筆，開高低收全是 `--`），
 * `parseFloat("--")` 得 NaN，經 JSON 序列化變成 null，lightweight-charts 的
 * Candlestick 繪製直接丟出 `Error: Value is null`，整張圖畫不出來。冷門股長區間
 * （1年以上）幾乎一定會碰到。
 *
 * 處理原則（誠實、不編造）：沒有官方開高低收的日子整根略過，不拿前一天收盤價
 * 或均價去補一根假的K棒。價格 <= 0 也視為不合法（真實成交價不會是 0）。
 */
export function isValidCandle(c: unknown): c is Candle {
  if (typeof c !== "object" || c === null) return false;
  const { time, open, high, low, close } = c as Record<string, unknown>;
  if (typeof time !== "string" || time.length === 0) return false;
  return [open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/** 濾掉不合法的K棒；成交量不是有限數字時歸零（量不影響K棒能不能畫，不值得整根丟掉）。
 *  輸入不是陣列時回空陣列，讓呼叫端不用再各自防呆。 */
export function sanitizeCandles(candles: unknown): Candle[] {
  if (!Array.isArray(candles)) return [];
  return candles.filter(isValidCandle).map((c) =>
    Number.isFinite(c.volume) ? c : { ...c, volume: 0 }
  );
}
