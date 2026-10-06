/**
 * 台股交易成本費率的唯一來源（純資料）。
 *
 * 用的是公告的標準零售費率（未計任何券商折扣、未計最低手續費）：手續費買賣各 0.1425%、
 * 證券交易稅只在賣出時收 0.3%（一般股票；ETF 0.1% 本站不另外區分）。
 * 誰用：關注清單損益（lib/portfolio.ts）、學習循環獎勵的來回成本（ai/learning/reward.ts TRADE_COST_PCT，
 * 回測 scripts/backtest/weights.ts 也透過它）、AI 模擬投資組合（lib/simPortfolio/rules.ts）。
 * 改費率只改這裡。
 */
export const TW_BUY_COMMISSION_RATE = 0.001425;
export const TW_SELL_COMMISSION_RATE = 0.001425;
export const TW_SELL_TAX_RATE = 0.003;

/** 來回交易成本（%）：(買手續費＋賣手續費＋證交稅)×100，四捨五入到 6 位避免浮點尾數（＝0.585）。 */
export const TW_ROUND_TRIP_COST_PCT =
  Math.round((TW_BUY_COMMISSION_RATE + TW_SELL_COMMISSION_RATE + TW_SELL_TAX_RATE) * 100 * 1e6) / 1e6;
