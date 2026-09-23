import { getMarketStatus, type MarketScope } from "@/lib/marketStatus";

/**
 * 全站「即時報價類」資料該多久刷新一次的單一權威來源。
 *
 * 使用者的規則（2026-09-16 訂定，2026-09-20 把間隔從 10 秒調整成 1 分鐘——
 * Vercel 免費方案用量吃緊，且後端報價快取本來就卡在 20 秒才會真的更新，10 秒
 * 輪詢有一半請求只是拿到同一份舊資料，改 1 分鐘幾乎不損失新鮮度卻省下 6 倍請求）：
 *  1. 台股 08:30~14:30（含 08:30-09:00 試撮、13:30-14:30 盤後定價交易）屬於
 *     「股市運作期間」，報價/行情類資料每 1 分鐘刷新一次。
 *  2. 這段時間以外不需要持續輪詢（收盤後數字不會再變，一直打 API 只是浪費
 *     Vercel 函式呼叫與上游額度），但 **14:40 要額外補抓一次**——13:30 收盤到
 *     上游（TWSE/TPEx）真正把收盤價結算好會有幾分鐘延遲，14:40 抓一次才拿得到
 *     真正的最終收盤數字。補抓完當天就不再輪詢。
 *  3. 快報（daily-brief）/ 今日建議（action-brief）/ 新聞（news-feed）不受這套
 *     規則影響，維持全站 5 分鐘標準——那幾個元件本來就只在掛載時抓一次、
 *     新鮮度由伺服器端的 5 分鐘 TTL 決定，所以這個檔案完全不碰它們。
 *  4. 這套規則**只適用台股**。美股交易時段完全不同（美東 09:30-16:00，換算台北
 *     時間是晚上到凌晨），維持原本「只有美股盤中才輪詢、間隔 20 秒」的邏輯，
 *     絕不可以把台股的 10 秒/停止輪詢/14:40 補抓套到美股報價上。
 *  5. **興櫃（Emerging）是第三套時段**（2026-09-20 補上）：興櫃交易時間是
 *     09:00~15:00，跟上市櫃的 09:00~13:30 不一樣，所以第 1 點那組時間對它
 *     不適用，否則 13:30~15:00 這段興櫃其實還在交易的時間會被當成收盤、
 *     停止輪詢。判斷方式是呼叫端傳 scope="TW-EMERGING"（見 marketStatus.ts 的
 *     MarketScope），細節寫在下面 EMERGING_* 常數的註解。
 *
 * 這裡刻意寫成純函式（不含任何 React/瀏覽器 API），所以：
 *  - 前端由 lib/useLivePolling.ts 這個 hook 呼叫，決定 setTimeout 的節奏；
 *  - 伺服器端由 lib/data/index.ts 呼叫 isTwQuoteWindow()，讓快取 TTL 跟著縮短
 *    （前端改 10 秒輪詢但後端快取還是 20 秒的話，等於一半的輪詢都只是拿到
 *    同一份還沒過期的快取，白做工）；
 *  - 也可以直接用 node 跑單元測試等級的驗證（傳入假時間檢查回傳值）。
 */

/** 08:30 台北時間——試撮開始，TWSE/TPEx 已經在公布模擬撮合價。 */
export const TW_LIVE_START_MINUTES = 8 * 60 + 30;
/**
 * 興櫃（Emerging）專用時段。興櫃交易時間是 **09:00~15:00**（櫃買中心「興櫃股票
 * 交易制度」頁面白紙黑字寫「上午9時~下午3時」），跟上市櫃的 09:00~13:30 不同，
 * 所以不能沿用上面那組 TW_* 常數，否則 13:30~15:00 這段興櫃其實還在交易的時間
 * 會被當成收盤、停止輪詢（這正是 2026-09-20 記在 PROGRESS.md 的已知問題）。
 *
 * 兩個刻意的差異：
 *  1. **沒有 08:30 試撮**：試撮是集中市場集合競價的產物，興櫃是跟推薦證券商
 *     一對一議價點選成交，沒有集合競價、櫃買也不公布興櫃盤前模擬價，所以
 *     輪詢窗直接從 09:00 開始，不是 08:30。
 *  2. **沒有另外的「收盤補抓」時間點**：上市櫃那套是 13:30 收盤、14:30 盤後
 *     定價結束、14:40 再補抓一次最終收盤價。興櫃沒有盤後定價交易，只需要
 *     讓輪詢窗多延續 10 分鐘（到 15:10）跨過上游結算延遲，最後一輪自然就會
 *     抓到當日最終數字——這樣也避免跟台股那個「今天已補抓過」的單一標記
 *     （useLivePolling 只有一個 settledDayKey）互相把對方的補抓吃掉。
 */
export const EMERGING_LIVE_START_MINUTES = 9 * 60;
/** 15:00 台北時間——興櫃收盤（狀態徽章用這個時間判斷盤中/已收盤）。 */
export const EMERGING_CLOSE_MINUTES = 15 * 60;
/** 15:10 台北時間——輪詢多留 10 分鐘，讓最後一輪抓到結算後的最終數字。 */
export const EMERGING_LIVE_END_MINUTES = 15 * 60 + 10;
/** 14:30 台北時間——盤後定價交易結束，之後當日數字不會再變動。 */
export const TW_LIVE_END_MINUTES = 14 * 60 + 30;
/** 14:40 台北時間——收盤後補抓一次最終數字的時間點。 */
export const TW_SETTLE_MINUTES = 14 * 60 + 40;

/** 台股盤中輪詢間隔（原訂10秒，2026-09-20改為1分鐘，見上方檔案說明）。 */
export const TW_LIVE_POLL_MS = 60_000;
/** 美股輪詢間隔——維持改動前的 20 秒，不套用台股規則。 */
export const US_POLL_MS = 20_000;
/**
 * 非輪詢時段的「心跳」間隔：不會發出任何網路請求，只是每分鐘重新評估一次
 * 現在是不是已經跨進交易時段（例如使用者 08:25 就開著頁面，08:30 要能自己
 * 開始輪詢），順便修正裝置休眠/時鐘跳動造成的偏差。
 */
export const IDLE_CHECK_MS = 60_000;
const MIN_CHECK_MS = 1_000;

/**
 * 台指期夜盤（TX 近月）時段：週一~週五 15:00 開盤到次日 05:00。這是盤後夜間
 * 商品，不受上面台股日盤規則約束，所以單獨一組時間判斷。前後各留一點緩衝
 * （14:55 / 05:05），避免時鐘些微誤差剛好錯過開盤那一刻。
 */
const TAIFEX_NIGHT_START_MINUTES = 14 * 60 + 55;
const TAIFEX_NIGHT_END_MINUTES = 5 * 60 + 5;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface TaipeiClock {
  /** 0=週日 … 6=週六（台北時間） */
  weekday: number;
  /** 台北時間的「當日第幾分鐘」 */
  minutes: number;
  /** 該分鐘內已經過的秒數，用來精準算到下一個整分邊界 */
  seconds: number;
  /** 台北時間日期 yyyy-mm-dd，用來標記「今天的 14:40 補抓做過了沒」 */
  dayKey: string;
}

function taipeiClock(now: Date): TaipeiClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(pick("hour") || "0");
  const minute = Number(pick("minute") || "0");
  return {
    weekday: WEEKDAYS.indexOf(pick("weekday") || "Sun"),
    minutes: hour * 60 + minute,
    seconds: Number(pick("second") || "0"),
    dayKey: `${pick("year")}-${pick("month")}-${pick("day")}`,
  };
}

/** 台北時間的日期字串（yyyy-mm-dd）——hook 用它記錄「今天已經補抓過了」。 */
export function taipeiDayKey(now: Date = new Date()): string {
  return taipeiClock(now).dayKey;
}

function isTwWeekday(clock: TaipeiClock): boolean {
  return clock.weekday !== 0 && clock.weekday !== 6;
}

/**
 * 現在是不是台股 08:30~14:30 的「股市運作期間」。
 * 伺服器端的報價快取 TTL 也是靠這個判斷要用 10 秒還是 20 秒。
 *
 * 跟 marketStatus.ts 的 getMarketStatus() 一樣不處理國定假日（沒有免費的
 * TWSE 假日行事曆 API）：假日會被當成交易時段而多輪詢幾次，代價只是打到
 * 不會變動的資料，絕不會因此編造或隱瞞任何數字。
 */
export function isTwQuoteWindow(now: Date = new Date()): boolean {
  const clock = taipeiClock(now);
  if (!isTwWeekday(clock)) return false;
  return clock.minutes >= TW_LIVE_START_MINUTES && clock.minutes < TW_LIVE_END_MINUTES;
}

/**
 * 現在是不是興櫃的「該輪詢期間」（09:00~15:10，含收盤後 10 分鐘的結算緩衝）。
 * 注意這跟「興櫃盤中嗎」不是同一件事——盤中/已收盤的徽章一律以
 * marketStatus.ts 的 getMarketStatus("TW-EMERGING") 為準（15:00 就收盤）。
 */
export function isEmergingQuoteWindow(now: Date = new Date()): boolean {
  const clock = taipeiClock(now);
  if (!isTwWeekday(clock)) return false;
  return clock.minutes >= EMERGING_LIVE_START_MINUTES && clock.minutes < EMERGING_LIVE_END_MINUTES;
}

export interface PollDecision {
  /** 這一輪要不要真的去打 API 抓新資料 */
  fetch: boolean;
  /** 這次抓取是不是 14:40 的收盤補抓（抓完就記錄今天已補，不再重複） */
  settle: boolean;
  /** 幾毫秒之後再評估一次 */
  nextCheckMs: number;
}

function clampCheck(ms: number): number {
  if (!Number.isFinite(ms)) return IDLE_CHECK_MS;
  return Math.min(IDLE_CHECK_MS, Math.max(MIN_CHECK_MS, ms));
}

/** 距離台北時間某個「當日第幾分鐘」還有幾毫秒（同一天之內才有意義）。 */
function msUntilMinuteMark(clock: TaipeiClock, targetMinutes: number, now: Date): number {
  return (targetMinutes - clock.minutes) * 60_000 - clock.seconds * 1_000 - now.getMilliseconds();
}

function twPollDecision(now: Date, settledDayKey: string | null): PollDecision {
  const clock = taipeiClock(now);
  const weekday = isTwWeekday(clock);

  if (weekday && clock.minutes >= TW_LIVE_START_MINUTES && clock.minutes < TW_LIVE_END_MINUTES) {
    return { fetch: true, settle: false, nextCheckMs: TW_LIVE_POLL_MS };
  }

  // 14:40 之後、當天還沒補抓過 → 立刻補抓一次。刻意寫成「>= 14:40 且今天還沒做」
  // 而不是「剛好等於 14:40」：使用者 14:35 打開頁面（輪詢已停）時，下面的
  // nextCheckMs 會精準算到 14:40 觸發；而使用者 14:41、甚至晚上才打開頁面時，
  // 第一次評估就會立刻補抓一次當下最新資料，不會傻等到明天的 14:40。
  if (weekday && clock.minutes >= TW_SETTLE_MINUTES && settledDayKey !== clock.dayKey) {
    return { fetch: true, settle: true, nextCheckMs: IDLE_CHECK_MS };
  }

  // 非交易時段：不打 API，只安排下一次「檢查時間到了沒」。
  const target =
    clock.minutes < TW_LIVE_START_MINUTES
      ? TW_LIVE_START_MINUTES
      : clock.minutes < TW_SETTLE_MINUTES
        ? TW_SETTLE_MINUTES
        : null;
  const nextCheckMs = target === null ? IDLE_CHECK_MS : clampCheck(msUntilMinuteMark(clock, target, now));
  return { fetch: false, settle: false, nextCheckMs };
}

/**
 * 興櫃：09:00~15:10 每分鐘抓一次，其餘時間不打 API，只把下一次評估排到 09:00。
 * 沒有試撮、也沒有 14:40 那種補抓（理由見上方 EMERGING_* 常數的說明），所以
 * 這個函式永遠回 settle:false，不會去動 useLivePolling 的 settledDayKey。
 */
function emergingPollDecision(now: Date): PollDecision {
  const clock = taipeiClock(now);
  if (isTwWeekday(clock) && clock.minutes >= EMERGING_LIVE_START_MINUTES && clock.minutes < EMERGING_LIVE_END_MINUTES) {
    return { fetch: true, settle: false, nextCheckMs: TW_LIVE_POLL_MS };
  }
  const nextCheckMs =
    isTwWeekday(clock) && clock.minutes < EMERGING_LIVE_START_MINUTES
      ? clampCheck(msUntilMinuteMark(clock, EMERGING_LIVE_START_MINUTES, now))
      : IDLE_CHECK_MS;
  return { fetch: false, settle: false, nextCheckMs };
}

/** 美股：完全維持改動前的行為——盤中每 20 秒抓一次，收盤時只是空轉檢查、不打 API。 */
function usPollDecision(now: Date): PollDecision {
  return { fetch: getMarketStatus("US", now) === "open", settle: false, nextCheckMs: US_POLL_MS };
}

/**
 * 某個市場（或板別）現在該不該抓資料、下一次什麼時候再評估。
 * `settledDayKey` 是呼叫端記住的「今天的 14:40 補抓已經做過了」標記（台北日期），
 * 沒做過就傳 null。美股與興櫃永遠用不到這個參數。
 *
 * scope 傳 "TW" 代表上市櫃（09:00-13:30 那套，含 08:30 試撮與 14:40 補抓，
 * 行為跟興櫃支援之前完全一樣），要判斷單一興櫃股票時才傳 "TW-EMERGING"。
 */
export function getPollDecision(
  scope: MarketScope,
  now: Date = new Date(),
  settledDayKey: string | null = null
): PollDecision {
  if (scope === "TW") return twPollDecision(now, settledDayKey);
  if (scope === "TW-EMERGING") return emergingPollDecision(now);
  return usPollDecision(now);
}

/**
 * 台指期夜盤小卡專用：夜盤 15:00~次日 05:00 才輪詢（20 秒一次），其餘時間不打 API。
 * 刻意不套用台股日盤的 10 秒/14:40 規則——這張卡顯示的是夜盤商品，台股日盤
 * 交易時段內它的數字（前一晚夜盤收盤）根本不會變。「交易中／已收盤」的徽章
 * 仍然完全依賴後端回傳的真實狀態，這裡的時段判斷只用來決定要不要發請求。
 */
export function getTaifexPollDecision(now: Date = new Date()): PollDecision {
  const clock = taipeiClock(now);
  const eveningSession = clock.minutes >= TAIFEX_NIGHT_START_MINUTES && clock.weekday >= 1 && clock.weekday <= 5;
  const earlyMorningSession = clock.minutes < TAIFEX_NIGHT_END_MINUTES && clock.weekday >= 2 && clock.weekday <= 6;
  if (eveningSession || earlyMorningSession) {
    return { fetch: true, settle: false, nextCheckMs: US_POLL_MS };
  }
  const nextCheckMs =
    clock.minutes < TAIFEX_NIGHT_START_MINUTES
      ? clampCheck(msUntilMinuteMark(clock, TAIFEX_NIGHT_START_MINUTES, now))
      : IDLE_CHECK_MS;
  return { fetch: false, settle: false, nextCheckMs };
}

/**
 * 一個畫面同時混合多個市場（例如關注清單裡台股美股都有）時，把各市場的判斷
 * 合併成一個節奏：任何一個市場要抓就抓，間隔取最短的那個。
 * `minCheckMs` 給不需要秒級精度的用途（例如到價提醒）設一個下限。
 */
export function mergePollDecisions(decisions: PollDecision[], minCheckMs = 0): PollDecision {
  if (decisions.length === 0) return { fetch: false, settle: false, nextCheckMs: IDLE_CHECK_MS };
  return {
    fetch: decisions.some((d) => d.fetch),
    settle: decisions.some((d) => d.settle),
    nextCheckMs: Math.max(minCheckMs, Math.min(...decisions.map((d) => d.nextCheckMs))),
  };
}

/**
 * 混合市場的清單（關注清單、到價提醒）用來逐檔決定「這一檔這次要不要重抓」。
 * mount（畫面剛掛載、手上還沒有任何資料）時一律全部抓一次，否則畫面會在
 * 收盤時段永遠停在骨架載入狀態。
 */
export function shouldRefreshSymbol(
  scope: MarketScope,
  now: Date,
  opts: { mount: boolean; settle: boolean }
): boolean {
  if (opts.mount) return true;
  if (scope === "TW") return opts.settle || isTwQuoteWindow(now);
  // 興櫃：自己的 09:00~15:10 窗。台股 14:40 的補抓（settle）落在這個窗之內，
  // 順手一起重抓也不會有副作用，所以照收。
  if (scope === "TW-EMERGING") return opts.settle || isEmergingQuoteWindow(now);
  return getMarketStatus("US", now) === "open";
}
