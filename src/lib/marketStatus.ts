import type { Market } from "@/lib/data/types";

// "pre-market" — TW only: TWSE/TPEx collect orders and publish a simulated
// 試撮（試算撮合）trial-match price from 08:30 until the real 09:00 open,
// but no actual trade executes yet. A user asked for this window to be
// explicitly labeled rather than folded into a plain "已收盤" — seeing
// "已收盤" at 08:45 read as though nothing was happening yet, when TWSE's
// own systems are already actively publishing (non-final) matching data.
// US has no equivalent modeled here (its real pre-market session is
// actual trading on limited venues, a different mechanism this site
// doesn't otherwise track — see US_SESSIONS below, unchanged).
export type MarketStatus = "open" | "pre-market" | "closed";

/**
 * 開收盤判斷的「板別」。對外的 Market 只有 "TW"/"US" 兩種，但同樣掛在
 * Market="TW" 底下的台股其實有兩套完全不同的交易時段：
 *  - 上市（TWSE）/上櫃（TPEx）：09:00~13:30，另有 08:30~09:00 試撮。
 *  - 興櫃（Emerging）：**09:00~15:00**，議價點選交易，收盤晚 1.5 小時。
 *
 * 所以這兩個模組（marketStatus / pollingSchedule）改成收 MarketScope 而不是
 * Market。刻意做成「Market 是 MarketScope 的子集」：既有那幾十處傳 "TW"/"US"
 * 的呼叫端一行都不用改、行為也完全不變（"TW" 仍舊是上市櫃的 09:00-13:30），
 * 只有真的知道自己在處理單一興櫃股票的地方才需要傳 "TW-EMERGING"。
 */
export type MarketScope = Market | "TW-EMERGING";

/** 對應 Quote.board / UniverseEntry.exchange 的興櫃標記。 */
export type StockBoard = "emerging";

/**
 * 把「市場 + 板別」轉成 MarketScope。呼叫端通常手上有一份 Quote
 * （`quote.board === "emerging"`）或 UniverseEntry（`exchange === "Emerging"`），
 * 用這個 helper 轉換，不要各自散落 `board === "emerging" ? ... : ...`。
 */
export function marketScope(market: Market, board?: StockBoard | null): MarketScope {
  return market === "TW" && board === "emerging" ? "TW-EMERGING" : market;
}

interface Session {
  timeZone: string;
  openMinutes: number; // minutes since local midnight
  closeMinutes: number;
}

// Regular trading session hours (local exchange time).
const SESSIONS: Record<MarketScope, Session> = {
  TW: { timeZone: "Asia/Taipei", openMinutes: 9 * 60, closeMinutes: 13 * 60 + 30 },
  // 興櫃 09:00~15:00，來源是櫃買中心自己的「興櫃股票交易制度」頁面
  // （tpex.org.tw 興櫃交易制度：交易時間「上午9時~下午3時」、無漲跌幅限制）。
  // 沒有 08:30 試撮：試撮是集中市場集合競價才有的機制（先收單、公布模擬撮合
  // 價），興櫃是跟推薦證券商一對一議價點選成交，根本沒有集合競價，櫃買也
  // 不公布興櫃的盤前模擬價，所以下面 getMarketStatus 對興櫃不套用 pre-market。
  "TW-EMERGING": { timeZone: "Asia/Taipei", openMinutes: 9 * 60, closeMinutes: 15 * 60 },
  US: { timeZone: "America/New_York", openMinutes: 9 * 60 + 30, closeMinutes: 16 * 60 },
};

// 08:30 local Taipei time — see the MarketStatus comment above for what
// this window means. Only defined for TW; getMarketStatus() below never
// reads this for "US".
const TW_PRE_MARKET_START_MINUTES = 8 * 60 + 30;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { weekday: WEEKDAYS.indexOf(weekdayStr), minutes: hour * 60 + minute };
}

/**
 * Approximate regular-session open/closed check — weekday + local wall-clock
 * time only. Doesn't know about exchange holidays (TWSE/NYSE holiday
 * calendars aren't available from a free public API), so a holiday reads as
 * "open" and the page just polls for updates that never change — harmless,
 * since it never fabricates a price either way, unlike getting this wrong
 * would if it suppressed real updates.
 */
export function getMarketStatus(scope: MarketScope, now: Date = new Date()): MarketStatus {
  const session = SESSIONS[scope];
  const { weekday, minutes } = localParts(now, session.timeZone);
  if (weekday === 0 || weekday === 6) return "closed";
  if (scope === "TW" && minutes >= TW_PRE_MARKET_START_MINUTES && minutes < session.openMinutes) return "pre-market";
  if (minutes < session.openMinutes || minutes >= session.closeMinutes) return "closed";
  return "open";
}

export function marketStatusLabel(status: MarketStatus): string {
  if (status === "open") return "盤中";
  if (status === "pre-market") return "試撮中（08:30-09:00，尚未正式開盤）";
  return "已收盤";
}
