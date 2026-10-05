export type Market = "TW" | "US";

export interface Quote {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  /**
   * 開盤價。**可以是 null**：台灣的興櫃市場（見 lib/data/emerging.ts）是議價
   * 交易，整個市場根本沒有「開盤價」這個東西，櫃買中心也從來沒有公布過。這種
   * 情況一律填 null 讓畫面顯示「—」，**絕對不可以拿最新成交價/均價之類的別的
   * 數字頂替**（那等於憑空生出一個不存在的開盤價）。上市/上櫃/美股都有真實的
   * 開盤價，維持填數字。
   */
  open: number | null;
  /** 當日最高價；興櫃當天完全沒有成交時為 null（沒有成交就沒有最高價）。 */
  high: number | null;
  /** 當日最低價；同上。 */
  low: number | null;
  /**
   * 漲跌幅的計算基準價。上市/上櫃/美股＝昨天的收盤價；**興櫃＝前日均價**
   * （興櫃沒有收盤價，櫃買中心自己公布的漲跌也是用前日均價算的）。欄位名稱
   * 維持 prevClose 是為了跟另外兩個市場共用型別，顯示文字請改看
   * `prevCloseLabel`。
   */
  prevClose: number;
  volume: number;
  currency: string;
  updatedAt: string;
  /**
   * 這檔股票屬於哪個板；只有興櫃會帶值，其餘（上市/上櫃/美股）不帶。UI 用它
   * 決定要不要顯示「興櫃」標示與相關的說明文字。刻意不放進 Market 型別裡：
   * 對外的市場分類仍然只有 "TW"/"US"，興櫃是 TW 底下的一個板別。
   */
  board?: "emerging";
  /** `prevClose` 這個數字在畫面上應該叫什麼（興櫃是「前日均價」）；沒帶就用預設的「昨收」。 */
  prevCloseLabel?: string;
  /**
   * 這筆報價本身需要一併告訴使用者的限制說明，例如興櫃某檔股票今天整天都沒有
   * 成交、畫面上顯示的其實是前日均價。有值就一定要顯示出來——這是「不騙人」的
   * 一部分，不是可有可無的註解。
   */
  priceNote?: string;
  /**
   * 這筆報價所屬的交易日（YYYY-MM-DD，台北日期），只有台股帶值（MIS 的 `d`／興櫃的
   * TradeDay／日K的日期）。非交易時段用它判斷上游資料是不是「重置/測試」狀態，
   * 見 pollingSchedule.ts 的 classifyTwQuoteTradeDate()。
   */
  tradeDate?: string;
}

/**
 * 全市場「最近一個交易日」盤後日行情的一筆（TWSE STOCK_DAY_ALL／TPEx
 * tpex_mainboard_quotes）。非交易時段 MIS 資料不可信時用它組報價，
 * 見 twOffHoursQuote.ts。volume 單位是股。
 */
export interface TwDailyBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  /** close − 官方漲跌價差（除權息日即為參考價，跟官方漲跌一致） */
  prevClose: number;
  volume: number;
}

/** twse.ts/tpex.ts 共用：今天累積成交量為0時，rowToQuote()算出來的價格/漲跌其實是
 *  委買賣中價估算，不是真的成交價變動——見兩邊呼叫處的完整說明。原本兩個檔案各自
 *  宣告一份一模一樣的字串常數，`tpex.ts`裡甚至留了「必須跟twse.ts保持一致」的提醒
 *  註解，代表這是已知會忘記同步更新的重複維護風險，2026-09-22 地毯式審計時改成
 *  共用同一份，改一次兩邊都生效。 */
export const NO_TRADE_MID_ESTIMATE_NOTE = "今日尚無成交，顯示的漲跌幅是用目前委買委賣中間價估算，並非實際成交價格";

export interface Candle {
  /** Daily ranges: a plain "YYYY-MM-DD" calendar date. The "today" intraday
   *  range instead puts a full ISO timestamp here (date+time+offset) — the
   *  two shapes need different handling on the chart-rendering side (see
   *  StockChart.tsx), since lightweight-charts needs a UNIX-seconds
   *  timestamp for intraday points but a plain date string for daily ones. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartResponse {
  symbol: string;
  market: Market;
  range: ChartRange;
  candles: Candle[];
}

/**
 * "today" is intraday (minute-level, current trading session only, line
 * chart) — a fundamentally different shape from the other, daily-candle
 * ranges (see Candle.time's comment and StockChart.tsx's rendering split).
 */
export type ChartRange = "today" | "5d" | "10d" | "1m" | "3m" | "6m" | "1y" | "2y" | "5y" | "10y";

/**
 * 價量關係推論的三種結果——**不是真實委買委賣單成交量分類**（本站沒有那種逐筆
 * 成交/內外盤資料來源，見 SearchItem.volumeTrend 的完整說明）：
 * - "buy-leaning"：今日股價上漲，且成交量明顯高於這檔股票自己近期均量（傳統技術
 *   分析講的「價漲量增」，籌碼面偏多的常見判讀）
 * - "sell-leaning"：今日股價下跌，且成交量明顯高於自身近期均量（「價跌量增」，
 *   偏空的常見判讀）
 * - "neutral"：量能沒有明顯高於均量，或均量資料不足，沒有可下判斷的訊號
 */
export type VolumeTrend = "buy-leaning" | "sell-leaning" | "neutral";

export interface SearchItem {
  symbol: string;
  market: Market;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  volume: number;
  /** 成交金額＝股價 × 成交量（該股票報價幣別，TW是新台幣、US是美元）——直接從
   *  既有報價資料算出來，不需要額外資料源，是市場上通稱的「成交值」，
   *  跟單純的「成交量（股數/張數）」是不同的排行依據。 */
  turnover: number;
  /**
   * 今日成交量 ÷ 這檔股票自己近期（最多20個交易日，不含今日）平均成交量。
   * 均量資料不足（新股剛掛牌、或站上還沒累積到至少5個交易日的歷史）時為
   * undefined——沒有基準可比較，不代入任何假設值。
   */
  volumeRatio?: number;
  /**
   * 價量關係推論（見上方 VolumeTrend 型別說明）：根據「今日量 vs 這檔股票自己近期
   * 均量」＋「今日漲跌方向」推論出的傳統技術分析價量關係，是一種歷史悠久的看盤
   * 經驗法則，**不是真實的委買委賣單成交量統計**——台股/美股都沒有公開、免費、
   * 提供逐筆成交方向（內外盤）分類的資料源，所以本站不會、也不能算出「今天成交量
   * 裡有多少真的是用市價買、多少是用市價賣」這種真正的買賣單量能數字。UI 顯示這個
   * 欄位時務必連同這個限制一起呈現，不能讓使用者誤以為是真實的買賣單統計。
   */
  volumeTrend: VolumeTrend;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  market: Market;
  price: number;
  change: number;
  changePercent: number;
}

/**
 * 台指期（TX，大台指）夜盤近月合約報價 —— 見 lib/data/taifex.ts 的詳細說明。
 * 跟 IndexQuote 分開一個型別，是因為夜盤這個資料源需要額外的「交易中/已收盤」
 * 狀態跟資料時間戳才能誠實呈現（夜盤時段長達 15:00~次日05:00，使用者在這段
 * 期間以外看到這張卡片時，必須清楚知道看到的是「最近一次夜盤」而不是即時資料）。
 */
export interface TaifexFuturesQuote {
  /** 顯示用契約名稱，含近月月份，例如「台指期（近月，09月合約）」。近月合約由
   *  交易所自己的看盤系統決定並在結算日隔天自動換月，這裡不用自己處理換月邏輯。 */
  contractLabel: string;
  price: number;
  change: number;
  changePercent: number;
  /** 合約口數（張），來自交易所當下的合計成交量。 */
  volume: number;
  /** "trading"＝夜盤目前交易中；"closed"＝夜盤已收盤（顯示的是最近一次收盤資料）；
   *  "halted"＝交易所回報其他特殊狀態（試撮/暫停/延長開收盤等罕見情況），這幾種
   *  不強行歸類成 trading 或 closed，UI 顯示「特殊狀態」以免講錯。 */
  status: "trading" | "closed" | "halted";
  /** 資料時間戳（台北時間 "YYYY/MM/DD HH:mm:ss"），直接來自交易所回傳的成交時間，
   *  不是本站抓取當下的系統時間——確保使用者能自行判斷資料新鮮度，不會被誤導成
   *  「這一定是即時的」。 */
  asOf: string;
}

export interface Fundamentals {
  peRatio?: number;
  dividendYield?: number;
  marketCap?: number;
  /** 股價淨值比 (P/B) */
  pbRatio?: number;
}

/**
 * TW only — 三大法人買賣超與融資融券餘額，統稱「籌碼面」，TWSE 官方每個交易日
 * 收盤後公布，美股沒有對應的公開資料源，getChips() 對美股一律回傳 null。
 */
export interface Chips {
  /** 這份籌碼資料對應的交易日（YYYY-MM-DD） */
  date?: string;
  /** 三大法人合計買賣超股數，正值為買超、負值為賣超 */
  institutionalNetShares?: number;
  foreignNetShares?: number;
  trustNetShares?: number;
  dealerNetShares?: number;
  /** 融資今日餘額，單位「張」（1 張 = 1000 股），TWSE 原始資料就是這個單位 */
  marginBalance?: number;
  /** 融資今日餘額 - 前日餘額，單位「張」 */
  marginBalanceChange?: number;
  /** 融券今日餘額，單位「張」 */
  shortBalance?: number;
  /** 融券今日餘額 - 前日餘額，單位「張」 */
  shortBalanceChange?: number;
  /** 融資限額（可融資上限），單位「張」——TWSE「次一營業日限額」／TPEx
   *  MarginPurchaseQuota。算「融資使用率」用，見 chipsRatios.ts。 */
  marginQuota?: number;
  /** 融券限額（可融券上限），單位「張」——TWSE 融券區塊的「次一營業日限額」／TPEx
   *  ShortSaleQuota。算「融券使用率」用，見 chipsRatios.ts。 */
  shortQuota?: number;
  /** 融資融券這份資料對應的交易日（YYYY-MM-DD）；跟上面三大法人的 `date` 分開，
   *  因為兩份報表是不同端點、不保證同一時間更新到同一天。 */
  marginDate?: string;
}

/**
 * TW only — 個股頁最上方「籌碼比例」摘要（融資使用率／融券使用率／外資持股比例／大戶持股比例）
 * 與前一期的比較，見 lib/data/chipsRatios.ts。每一項抓不到就是 undefined，UI 顯示
 * 「資料暫缺」；前一期抓不到（或大戶週資料還在累積）時 prev* 欄位是 undefined，
 * 不編數字、不當成 0 變化。所有百分比都是「0~100 的百分比數字」（13.44 代表 13.44%）。
 */
export interface ChipsRatios {
  margin?: {
    /** 資料交易日（YYYY-MM-DD） */
    date?: string;
    /** 融資餘額（張） */
    balance: number;
    /** 融資餘額較前一交易日增減（張） */
    balanceChange?: number;
    /** 融資使用率 = 融資餘額 ÷ 融資限額 × 100 */
    utilizationPercent: number;
    /** 前一交易日融資使用率（前日餘額 ÷ 同一個融資限額；限額只在股本變動時才會變） */
    prevUtilizationPercent?: number;
  };
  /**
   * 融券使用率＝融券餘額 ÷ 融券限額 × 100（跟融資使用率同一套邏輯：放空額度用掉幾成）。
   * 跟融資使用率同一份 MI_MARGN／TPEx 融資融券報表，不另外打上游。
   * 融券限額查不到或為 0 時無法計算 → 整項 undefined。
   */
  short?: {
    /** 資料交易日（YYYY-MM-DD），同 margin.date */
    date?: string;
    /** 融券餘額（張） */
    balance: number;
    /** 融券餘額較前一交易日增減（張） */
    balanceChange?: number;
    /** 融券使用率 = 融券餘額 ÷ 融券限額 × 100 */
    utilizationPercent: number;
    /** 前一交易日融券使用率（前日融券餘額 ÷ 同一個融券限額；限額只在股本變動時才會變）；前日餘額查不到時 undefined */
    prevUtilizationPercent?: number;
  };
  foreign?: {
    date: string;
    /** 全體外資及陸資持有股數（股） */
    heldShares: number;
    /** 全體外資及陸資持股比率（官方公布值） */
    holdingPercent: number;
    prevDate?: string;
    prevHeldShares?: number;
    prevHoldingPercent?: number;
  };
  majorHolders?: {
    /** 集保股權分散表資料日期（每週一次，通常是該週最後一個營業日） */
    date: string;
    /** 持股 1,000 張以上（集保第 15 級：1,000,001 股以上）的人數 */
    holders: number;
    /** 這些大戶合計持有股數（股） */
    shares: number;
    /** 大戶持股比例 = 第15級股數 ÷ 第17級合計股數 × 100 */
    holdingPercent: number;
    /** 上一週（本站自行留存的上一期快照，見 majorHolders.ts）；還在累積時為 undefined */
    prevDate?: string;
    prevHolders?: number;
    prevHoldingPercent?: number;
  };
}

/** TW only — 上市公司每日重大訊息公告（併購、增資、法說會等），來源 TWSE 公開資訊觀測站。 */
export interface MaterialAnnouncement {
  /** 發言日期（YYYY-MM-DD） */
  date: string;
  subject: string;
}

export interface Earnings {
  /** TW：最新月營收年增率(%)，台股投資人最常看的財報先行指標 */
  monthlyRevenueYoyPercent?: number;
  /** e.g. "2026年7月" */
  monthlyRevenuePeriod?: string;
  /** 最新一季每股盈餘（TW：元；US：美元） */
  quarterlyEps?: number;
  /** e.g. "115年Q2"（TW）或 "2026 Q2"（US） */
  quarterlyEpsPeriod?: string;
  /** US only：實際 EPS 相對市場預期的驚喜幅度(%)，正值代表優於預期 */
  epsSurprisePercent?: number;
  /** US only：下次公布財報的日期（ISO 格式） */
  nextEarningsDate?: string;
}
