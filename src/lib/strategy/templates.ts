/**
 * 策略範本（純資料；一鍵建立的邏輯在 templateCreate.ts）。
 *
 * 2026-10-15 使用者：「要寫一個指標策略，我之後就可以直接取用，因為也不知道現在 AI 推薦適用什麼策略推薦」；
 * 同日貼的 GPT 建議「先建立 6 套基礎策略分開測試」。每個範本＝幾個參考指標（類型＋參數）＋一個條件式策略＋風控。
 * 數值是常見的起始設定，不是驗證過的最佳值——畫面要寫清楚，鼓勵用「策略回測」與模擬倉比較後再調整。
 * backtestable：只用日K類指標（策略回測能完整重現）；用到籌碼／基本面／本站評等的範本回測時那些條件會當作不成立。
 */

export interface TemplateIndicator {
  /** 範本內部代號（策略條件用它對應） */
  key: string;
  typeId: string;
  params: Record<string, number | string>;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  style: string;
  /** 適合什麼情況、怎麼運作（一兩句白話） */
  desc: string;
  /** 主要風險 */
  risk: string;
  backtestable: boolean;
  indicators: TemplateIndicator[];
  mode: "rules";
  buy: { keys: string[]; match: number };
  sell: { keys: string[]; match: number };
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldDays: number;
  positionPct: number;
  maxPositions: number;
}

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: "ai-style-tech",
    name: "AI 推薦風格・技術版",
    style: "AI 推薦近似（可回測）",
    desc: "模仿本站綜合評等「建議買進」的技術面條件：股價站上 20 日與 60 日線（趨勢向上、在支撐之上）、RSI 未過熱、5 日漲幅不過大（不追高），再加 MACD 或 KD 剛黃金交叉當進場點；6 個條件至少 5 個成立就買。跌破 20 日線或 MACD 死亡交叉賣出。",
    risk: "只是技術面的近似版，本站評等另外還看籌碼、基本面、財報、消息；適合用來回測 AI 推薦「技術面那一半」的效果。",
    backtestable: true,
    indicators: [
      { key: "ma20", typeId: "price_vs_ma", params: { period: 20, op: "gt" } },
      { key: "ma60", typeId: "price_vs_ma", params: { period: 60, op: "gt" } },
      { key: "rsi", typeId: "rsi", params: { period: 14, op: "lt", value: 70 } },
      { key: "chg", typeId: "price_change", params: { days: 5, op: "lt", pct: 15 } },
      { key: "macd", typeId: "macd_cross", params: { dir: "golden", within: 3 } },
      { key: "kd", typeId: "kd_cross", params: { dir: "golden", within: 3, kLimit: 0 } },
      { key: "below20", typeId: "price_vs_ma", params: { period: 20, op: "lt" } },
      { key: "macdDead", typeId: "macd_cross", params: { dir: "dead", within: 1 } },
    ],
    mode: "rules",
    buy: { keys: ["ma20", "ma60", "rsi", "chg", "macd", "kd"], match: 5 },
    sell: { keys: ["below20", "macdDead"], match: 1 },
    stopLossPct: 8,
    takeProfitPct: 20,
    maxHoldDays: 0,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "ai-style-rating",
    name: "AI 推薦風格・本站評等",
    style: "AI 推薦（直接用評等）",
    desc: "直接用本站綜合評等：評等是「建議買進」而且股價在 20 日線之上就買，評等轉成「先不要買」就賣。跟今日建議、AI 模擬組合用的是同一份評等。",
    risk: "本站評等沒有逐日歷史，這個範本不能回測，只能用模擬倉從今天開始往後跑。",
    backtestable: false,
    indicators: [
      { key: "rating", typeId: "site_rating", params: { code: "buy" } },
      { key: "ma20", typeId: "price_vs_ma", params: { period: 20, op: "gt" } },
      { key: "avoid", typeId: "site_rating", params: { code: "avoid" } },
    ],
    mode: "rules",
    buy: { keys: ["rating", "ma20"], match: 0 },
    sell: { keys: ["avoid"], match: 1 },
    stopLossPct: 8,
    takeProfitPct: 20,
    maxHoldDays: 0,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "ma-alignment",
    name: "均線多頭排列",
    style: "趨勢追蹤",
    desc: "5 日線 > 20 日線 > 60 日線而且 20 日線向上（多頭排列）就買；跌破 20 日線或 5 日線死亡交叉 20 日線就賣。",
    risk: "均線有落後性，排列成形時股價常已漲一段；盤整時容易來回停損。",
    backtestable: true,
    indicators: [
      { key: "align", typeId: "ma_alignment", params: { short: 5, mid: 20, long: 60, slopeDays: 3 } },
      { key: "below20", typeId: "price_vs_ma", params: { period: 20, op: "lt" } },
      { key: "dead", typeId: "ma_cross", params: { short: 5, long: 20, dir: "dead", within: 1 } },
    ],
    mode: "rules",
    buy: { keys: ["align"], match: 0 },
    sell: { keys: ["below20", "dead"], match: 1 },
    stopLossPct: 8,
    takeProfitPct: 25,
    maxHoldDays: 0,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "macd-trend",
    name: "MACD 趨勢轉強",
    style: "趨勢追蹤",
    desc: "MACD 黃金交叉（3 天內）而且股價在 60 日線之上（大方向偏多）就買；MACD 死亡交叉或跌破 60 日線就賣。",
    risk: "MACD 反應較慢，盤整行情會反覆交叉。",
    backtestable: true,
    indicators: [
      { key: "golden", typeId: "macd_cross", params: { dir: "golden", within: 3 } },
      { key: "ma60", typeId: "price_vs_ma", params: { period: 60, op: "gt" } },
      { key: "dead", typeId: "macd_cross", params: { dir: "dead", within: 1 } },
      { key: "below60", typeId: "price_vs_ma", params: { period: 60, op: "lt" } },
    ],
    mode: "rules",
    buy: { keys: ["golden", "ma60"], match: 0 },
    sell: { keys: ["dead", "below60"], match: 1 },
    stopLossPct: 8,
    takeProfitPct: 20,
    maxHoldDays: 0,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "volume-breakout",
    name: "放量突破新高",
    style: "動能突破",
    desc: "收盤創 20 日新高、而且成交量是 20 日均量的 1.5 倍以上就買；跌破 10 日線賣出，最多持有 20 天。",
    risk: "假突破常見（突破後馬上拉回）；追強勢股要嚴守停損。",
    backtestable: true,
    indicators: [
      { key: "high", typeId: "breakout", params: { days: 20, dir: "high" } },
      { key: "vol", typeId: "volume_surge", params: { period: 20, multiple: 1.5 } },
      { key: "below10", typeId: "price_vs_ma", params: { period: 10, op: "lt" } },
    ],
    mode: "rules",
    buy: { keys: ["high", "vol"], match: 0 },
    sell: { keys: ["below10"], match: 1 },
    stopLossPct: 7,
    takeProfitPct: 20,
    maxHoldDays: 20,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "kd-low-golden",
    name: "KD 低檔黃金交叉",
    style: "短線反轉",
    desc: "K 值在 20 以下時 K 向上穿越 D（低檔黃金交叉）就買；K 在 80 以上死亡交叉就賣，最多持有 15 天。",
    risk: "下跌趨勢中 KD 會一直在低檔反覆交叉，容易接刀；適合震盪行情。",
    backtestable: true,
    indicators: [
      { key: "golden", typeId: "kd_cross", params: { dir: "golden", within: 3, kLimit: 20 } },
      { key: "dead", typeId: "kd_cross", params: { dir: "dead", within: 1, kLimit: 80 } },
    ],
    mode: "rules",
    buy: { keys: ["golden"], match: 0 },
    sell: { keys: ["dead"], match: 1 },
    stopLossPct: 6,
    takeProfitPct: 12,
    maxHoldDays: 15,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "rsi-rebound",
    name: "RSI 超賣反彈",
    style: "逆勢反轉",
    desc: "RSI 曾低於 30、最近 5 天內重新站上 30，而且 KD 黃金交叉（止跌確認）就買；RSI 從 70 以上跌破 70 就賣，最多持有 20 天。",
    risk: "逆勢買進風險較高，跌勢沒停時會連續停損；一定要設停損。",
    backtestable: true,
    indicators: [
      { key: "rsiUp", typeId: "rsi_cross", params: { period: 14, dir: "up", level: 30, within: 5 } },
      { key: "kd", typeId: "kd_cross", params: { dir: "golden", within: 3, kLimit: 0 } },
      { key: "rsiDown", typeId: "rsi_cross", params: { period: 14, dir: "down", level: 70, within: 1 } },
    ],
    mode: "rules",
    buy: { keys: ["rsiUp", "kd"], match: 0 },
    sell: { keys: ["rsiDown"], match: 1 },
    stopLossPct: 7,
    takeProfitPct: 15,
    maxHoldDays: 20,
    positionPct: 20,
    maxPositions: 5,
  },
  {
    id: "inst-growth",
    name: "法人籌碼成長",
    style: "籌碼趨勢",
    desc: "近 5 日三大法人累計買超、而且股價站上 20 日線就買；近 5 日累計轉為賣超或跌破 20 日線就賣。",
    risk: "法人也會停利、避險，連續買超不保證上漲；籌碼沒有逐日歷史，這個範本的籌碼條件回測時會當作不成立。",
    backtestable: false,
    indicators: [
      { key: "buy", typeId: "inst_sum", params: { who: "total", days: 5, op: "gt", lots: 0 } },
      { key: "ma20", typeId: "price_vs_ma", params: { period: 20, op: "gt" } },
      { key: "sell", typeId: "inst_sum", params: { who: "total", days: 5, op: "lt", lots: 0 } },
      { key: "below20", typeId: "price_vs_ma", params: { period: 20, op: "lt" } },
    ],
    mode: "rules",
    buy: { keys: ["buy", "ma20"], match: 0 },
    sell: { keys: ["sell", "below20"], match: 1 },
    stopLossPct: 8,
    takeProfitPct: 20,
    maxHoldDays: 0,
    positionPct: 20,
    maxPositions: 5,
  },
];

export const TEMPLATE_MAP = new Map(STRATEGY_TEMPLATES.map((t) => [t.id, t]));
