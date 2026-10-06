/**
 * AI 模擬投資組合的資料型別（Redis `sim-portfolio:v1:state` 一個 JSON，見 store.ts）。
 * 規則常數與純邏輯在 rules.ts，I/O 在 run.ts／store.ts／view.ts。
 */

export type SimSlotId = "0930" | "1300" | "1335";

export interface SimHolding {
  symbol: string;
  name: string;
  shares: number;
  /** 平均成本（每股，不含手續費） */
  avgCost: number;
  /** 實際投入金額（成交金額＋買進手續費，加碼時累加；部分賣出時依比例扣除） */
  invested: number;
  /** 第一次買進的台北日期（停利檢查用的日K起點、「當天買的不當天賣」） */
  buyDay: string;
  buyAt: string;
  /** 第一次買進當下的加權指數（平倉時算同期大盤報酬；抓不到是 null） */
  buyIndex: number | null;
  /** 上一次檢視時 computeHoldingStop 給的持有中出場價；下一次檢視現價 ≤ 它就出場 */
  stopPrice: number | null;
  /** 已依「建議減碼」賣過一半（之後再減碼不重複賣，等出場或停損） */
  reduced?: boolean;
  /** 最近一次加碼的台北日期（同一天不重複加碼） */
  lastAddDay?: string;
  /** 最近一次檢視的評等字樣（持有中） */
  lastLabel?: string;
}

export type SimSide = "buy" | "sell";

export interface SimTrade {
  at: string;
  day: string;
  slot: SimSlotId;
  symbol: string;
  name: string;
  side: SimSide;
  shares: number;
  price: number;
  /** 成交金額（價×股數，四捨五入到元） */
  amount: number;
  /** 手續費＋（賣出時）證交稅，逐項無條件捨去到元 */
  fee: number;
  /** 當時評等字樣（買進＝未持有結論；賣出＝持有中結論） */
  ratingLabel: string;
  /** 一句由程式組的理由（評等行／出場原因） */
  reason: string;
  /** 賣出才有：這次賣出部分的已實現損益（元，已扣買賣成本） */
  realized?: number;
  /** 賣出才有：這次賣出部分的報酬率（%，已扣成本） */
  realizedPct?: number;
  /** 賣出才有：同期加權指數報酬（%） */
  indexPct?: number | null;
  /** 賣出才有：獎勵＝報酬 − 同期大盤（learning/reward.ts tradeReward） */
  reward?: number | null;
}

export interface SimNavPoint {
  day: string;
  /** 淨值（現金＋持股市值，持股以當時價格計、未扣假設賣出成本） */
  nav: number;
  cash: number;
  /** 0050 收盤／當時價（對照用） */
  etf: number | null;
  /** 加權指數 */
  index: number | null;
}

export interface SimReview {
  day: string;
  at: string;
  text: string;
  /** 撰寫模型（好讀名稱）；AI 失敗時是程式版 */
  model: string | null;
  usedAi: boolean;
}

export interface SimStats {
  /** 已平倉（含部分賣出）筆數 */
  closedTrades: number;
  /** 其中已實現損益 > 0 的筆數 */
  wins: number;
  realized: number;
  fees: number;
  buys: number;
  sells: number;
  /** 已平倉筆數中有獎勵（指數抓得到）的累計獎勵與筆數 */
  rewardSum: number;
  rewardCount: number;
}

export interface SimState {
  version: 1;
  startDay: string;
  startAt: string;
  initialCapital: number;
  cash: number;
  holdings: SimHolding[];
  /** 新到舊，最多 SIM_MAX_TRADES 筆（統計另外累計在 stats，不受截斷影響） */
  trades: SimTrade[];
  /** 舊到新，每個台北日期一筆（同一天後面的執行覆寫） */
  nav: SimNavPoint[];
  /** 新到舊，最多 SIM_MAX_REVIEWS 筆 */
  reviews: SimReview[];
  stats: SimStats;
  /** 對照組起點：開始那次的 0050 價格與加權指數 */
  base: { etf: number | null; index: number | null };
  /** 已執行過的時點 `{日期}:{時點}`（只留最近幾筆，冪等用） */
  doneSlots: string[];
  /** 最近一次執行 */
  lastRun?: { at: string; slot: SimSlotId; day: string; note: string };
}
