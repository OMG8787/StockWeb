import { cached, cachedMap } from "./cache";
import { DAILY_DATA_SWR_MS, HEAVY_SWR_MS } from "./swrPolicy";
import type { Chips, Earnings, Fundamentals, Market, MaterialAnnouncement } from "./types";
import {
  fetchTwseFundamentalsAll,
  fetchTwseInstitutionalTradingAll,
  fetchTwseMarginTradingAll,
  fetchTwseMaterialAnnouncementsAll,
  fetchTwseMonthlyRevenueAll,
  fetchTwseQuarterlyEpsAll,
} from "./twse";
import {
  fetchTpexFundamentalsAll,
  fetchTpexInstitutionalTradingAll,
  fetchTpexMarginTradingAll,
  fetchTpexMaterialAnnouncementsAll,
  fetchTpexMonthlyRevenueAll,
  fetchTpexQuarterlyEpsAll,
} from "./tpex";
import { fetchEmergingMonthlyRevenueAll, fetchEmergingQuarterlyEpsAll } from "./emerging";
import { fetchUsEarnings, fetchUsFundamentals } from "./us";
import { fetchFinnhubEarnings, fetchFinnhubFundamentals, isFinnhubConfigured } from "./finnhub";
import { mergeTwMaps } from "./twMergedMaps";
import { detectMarket, normalizeSymbol } from "./symbols";

// 2026-09-20：從 5 分鐘拉回 30 分鐘。這裡曾經從「1小時」改成「5分鐘」是為了
// 跟全站快報/建議/新聞那批 5 分鐘標準看齊，但本益比/股價淨值比/殖利率/市值這類
// 基本面數字本質上一天只會變一次（收盤價才會變動），5分鐘重算一次沒有換到任何
// 真正的新鮮度，只是讓 warm-cache 這支背景排程（每5分鐘觸發一次）白白多算很多次
// ——這是 Vercel 免費方案用量吃緊後盤點出來的真實浪費源頭之一，30分鐘仍然遠比
// 「一天只變一次」的實際更新頻率頻繁，使用者不會感覺到任何變舊。
export const FUNDAMENTALS_TTL_MS = 30 * 60_000;

/**
 * 美股財報／基本面：Yahoo（非官方、可能被鎖）為主，Yahoo 丟錯或查無資料時才改打
 * Finnhub（見 finnhub.ts 的取捨說明）。沒設定 FINNHUB_API_KEY 時行為跟以前完全一樣：
 * Yahoo 丟錯就照樣往外丟（→ 不寫進快取、下次請求會重試），回 null 就回 null。
 * 兩邊都丟錯時丟出 Yahoo 的錯誤，一樣不會被快取成「沒有資料」。
 */
async function withFinnhubFallback<T>(primary: () => Promise<T | null>, fallback: () => Promise<T | null>): Promise<T | null> {
  let primaryError: unknown;
  try {
    const value = await primary();
    if (value) return value;
  } catch (e) {
    primaryError = e;
  }
  if (!isFinnhubConfigured()) {
    if (primaryError) throw primaryError;
    return null;
  }
  try {
    return await fallback();
  } catch (e) {
    throw primaryError ?? e;
  }
}

/**
 * 全市場本益比／殖利率／淨值比表（上市＋上櫃）。個股頁（getFundamentals）與價值篩選
 * （valueScreen.ts）共用：集中在唯一入口，同一個 key 的快取模式（含 SWR）才不會不一致。
 * 每日才更新一次，過期先回舊表、背景重抓（swrPolicy.ts）。
 */
export function getTwFundamentalsMap(): Promise<Map<string, Fundamentals>> {
  return cachedMap("fundamentals:TW:all", FUNDAMENTALS_TTL_MS, () => mergeTwMaps(fetchTwseFundamentalsAll, fetchTpexFundamentalsAll), {
    staleWhileRevalidateMs: DAILY_DATA_SWR_MS,
  });
}

/**
 * Returns null when unavailable — fabricating a P/E ratio or dividend
 * yield next to a real price would be more misleading than just omitting it.
 */
export async function getFundamentals(symbolInput: string, marketHint?: Market): Promise<Fundamentals | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  try {
    if (market === "TW") {
      const map = await getTwFundamentalsMap();
      return map.get(symbol) ?? null;
    }
    return await cached(
      `fundamentals:US:${symbol}`,
      FUNDAMENTALS_TTL_MS,
      () =>
        withFinnhubFallback(
          () => fetchUsFundamentals(symbol),
          () => fetchFinnhubFundamentals(symbol)
        ),
      { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
    );
  } catch {
    return null;
  }
}

// 2026-09-20：拉長到 1 小時——月營收一個月只公布一次、季報EPS一季只公布一次，
// 5分鐘重算完全是白工，理由同 FUNDAMENTALS_TTL_MS 的說明。
const EARNINGS_TTL_MS = 60 * 60_000;

/**
 * Returns null when unavailable — a bank/insurer isn't in TWSE's general
 * quarterly-EPS dataset (see fetchTwseQuarterlyEpsAll), and that's shown as
 * "no data" rather than silently misreporting a peer company's number.
 */
export async function getEarnings(symbolInput: string, marketHint?: Market): Promise<Earnings | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  try {
    if (market === "TW") {
      const [revenueMap, epsMap] = await Promise.all([
        cachedMap(
          "earnings:TW:revenue:v2",
          EARNINGS_TTL_MS,
          () => mergeTwMaps(fetchTwseMonthlyRevenueAll, fetchTpexMonthlyRevenueAll, fetchEmergingMonthlyRevenueAll),
          { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
        ),
        cachedMap(
          "earnings:TW:eps:v2",
          EARNINGS_TTL_MS,
          () => mergeTwMaps(fetchTwseQuarterlyEpsAll, fetchTpexQuarterlyEpsAll, fetchEmergingQuarterlyEpsAll),
          { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
        ),
      ]);
      const revenue = revenueMap.get(symbol);
      const eps = epsMap.get(symbol);
      if (!revenue && !eps) return null;
      return { ...revenue, ...eps };
    }
    return await cached(
      `earnings:US:${symbol}`,
      EARNINGS_TTL_MS,
      () =>
        withFinnhubFallback(
          () => fetchUsEarnings(symbol),
          () => fetchFinnhubEarnings(symbol)
        ),
      { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
    );
  } catch {
    return null;
  }
}

// 2026-09-20：拉長到 1 小時——三大法人買賣超/融資融券餘額是官方收盤後才公布
// 一次的報表，盤中/半夜每5分鐘重算是純浪費，理由同 FUNDAMENTALS_TTL_MS 的說明。
export const CHIPS_TTL_MS = 60 * 60_000;

/**
 * 全市場融資融券表（上市＋上櫃，整包快取 1 小時）。getChips() 與籌碼比例批次版
 * （chipsRatios.ts 的 getChipsRatiosBatch）共用同一份快取，不另打上游。
 * v2（2026-09-30）：每檔多了 marginQuota/marginDate，換 key 避免讀到舊形狀的快取。
 */
export function getTwMarginMap(): Promise<Map<string, Chips>> {
  return cachedMap("chips:TW:margin:v2", CHIPS_TTL_MS, () => mergeTwMaps(fetchTwseMarginTradingAll, fetchTpexMarginTradingAll), {
    staleWhileRevalidateMs: DAILY_DATA_SWR_MS,
  });
}

/**
 * 全市場三大法人買賣超表（上市＋上櫃，整包快取 1 小時）。getChips() 與籌碼排行
 * （chipsRanking.ts）共用：集中在這個唯一入口，同一個 key 的快取模式（含 SWR
 * 寬限期）才不會因為兩個呼叫端各寫各的而不一致。
 */
export function getTwInstitutionalMap(): Promise<Map<string, Chips>> {
  return cachedMap(
    "chips:TW:institutional",
    CHIPS_TTL_MS,
    () => mergeTwMaps(fetchTwseInstitutionalTradingAll, fetchTpexInstitutionalTradingAll),
    { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
  );
}

/**
 * TW only（籌碼面：三大法人買賣超＋融資融券餘額）— 美股沒有對應的公開資料
 * 源，一律回傳 null，不是抓取失敗。兩份資料都是「整個市場一次回傳」的報表，
 * 各自整包快取一次再依代號查表，不對每檔股票各打一次。
 */
export async function getChips(symbolInput: string, marketHint?: Market): Promise<Chips | null> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return null;
  try {
    const [institutionalMap, marginMap] = await Promise.all([
      getTwInstitutionalMap(),
      getTwMarginMap(),
    ]);
    const institutional = institutionalMap.get(symbol);
    const margin = marginMap.get(symbol);
    if (!institutional && !margin) return null;
    return { ...institutional, ...margin };
  } catch {
    return null;
  }
}

// 2026-09-20：拉長到 15 分鐘——重大訊息公告比籌碼/財報更可能在盤中臨時出現，
// 保留比其他基本面資料更短的間隔，但一樣不需要5分鐘等級的新鮮度。
const ANNOUNCEMENTS_TTL_MS = 15 * 60_000;

/** TW only — 最近一個交易日的重大訊息公告；大多數股票當天沒有公告是常態，回傳空陣列而非 null。 */
export async function getMaterialAnnouncements(symbolInput: string, marketHint?: Market): Promise<MaterialAnnouncement[]> {
  const symbol = normalizeSymbol(symbolInput);
  const market = marketHint ?? detectMarket(symbol);
  if (market !== "TW") return [];
  try {
    // 公告盤中可能新增：寬限 60 分鐘（過期先回舊表、背景重抓）。
    const map = await cachedMap(
      "announcements:TW:all",
      ANNOUNCEMENTS_TTL_MS,
      () => mergeTwMaps(fetchTwseMaterialAnnouncementsAll, fetchTpexMaterialAnnouncementsAll),
      { staleWhileRevalidateMs: HEAVY_SWR_MS }
    );
    return map.get(symbol) ?? [];
  } catch {
    return [];
  }
}
