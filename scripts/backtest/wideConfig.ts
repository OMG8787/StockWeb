import os from "node:os";
import path from "node:path";

/**
 * 擴大樣本回測（--wide，2026-10-05 建立）設定。所有門檻／抽樣參數都在這裡事先定好，不依結果調參。
 *
 * - 股票池：2024-09-23～09-30（訊號期開始「之前」）5 個交易日的平均成交金額，上市＋上櫃普通股
 *   （代號 4 碼、不以 0 開頭＝排除 ETF／ETN；91xx 存託憑證排除；興櫃本來就不在兩份行情表裡）。
 *   分層：大型＝排名 1～60 全取；中型＝排名 61～300 隨機抽 70；小型＝排名 301～900 隨機抽 70
 *   （排名 900 之後視為成交太少的殭屍股，不抽）。隨機用固定種子，可重現。
 * - 訊號日：2024-10-01～2026-08-31 每週最後一個交易日（收盤出訊號、下一交易日開盤進場）。
 * - 日K：Yahoo chart API（還原權息：用 adjclose/close 比例調整 OHLC）。
 */
export const SELECTION_DATES = ["2024-09-23", "2024-09-24", "2024-09-25", "2024-09-26", "2024-09-27", "2024-09-30"];
export const LARGE_N = 60;
export const MID_RANK: [number, number] = [61, 300];
export const MID_N = 70;
export const SMALL_RANK: [number, number] = [301, 900];
export const SMALL_N = 70;
export const SEED = 20261005;

export const SIGNAL_START = "2024-10-01";
export const SIGNAL_END = "2026-08-31";
/** 日K下載區間（訊號期前留 80 根以上算 MA60／RSI） */
export const CHART_FROM = "2024-05-01";
export const CHART_TO = "2026-10-05";

/** 來回交易成本（%）：手續費打折後約 0.1%＋證交稅 0.3%。 */
export const ROUND_TRIP_COST_PCT = 0.4;
export const HORIZONS = [5, 10, 20] as const;

/** 市況分段：訊號日加權指數近 60 個交易日報酬 > +5% 上漲、< -5% 下跌、其餘盤整。 */
export const REGIME_RET60_PCT = 5;

/** 快取目錄（不提交）。 */
export const WIDE_CACHE_DIR =
  process.env.BACKTEST_WIDE_CACHE ??
  path.join(
    os.tmpdir(),
    "claude",
    "c--Users-88691-Documents-Claude-Stock-web",
    "1ecde060-3666-4192-b5eb-a7185a5f59c3",
    "scratchpad",
    "backtest-data"
  );

/** 市場基準（Yahoo）：加權指數（市況分段用）與 0050（買進持有大盤，含息）。 */
export const INDEX_SYMBOL = "^TWII";
export const MARKET_ETF = "0050.TW";
