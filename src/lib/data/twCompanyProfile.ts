import { cachedMap, fetchWithTimeout } from "./cache";
import { DAILY_DATA_SWR_MS } from "./swrPolicy";
import { fetchTpexJson } from "./tpex";
import type { TwReportCategory } from "./twReportDeadline";

/**
 * 台股公司基本資料（上市／上櫃／興櫃全市場整包）：目前只取兩件事——
 * 1. 已發行普通股數（算市值＝現價×股數，見 marketCap.ts）
 * 2. 財報申報期限類別（一般／金融保險業／第一上市外國企業／金控，見 twReportDeadline.ts）
 *
 * 來源（皆官方免費 OpenAPI，每天更新一次）：
 * - 上市：openapi.twse.com.tw/v1/opendata/t187ap03_L「已發行普通股數或TDR原股發行股數」
 * - 上櫃：www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O「IssueShares」
 * - 興櫃：www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R「IssueShares」
 * 2026-10-05 查證：股數欄位不含特別股（台泥 實收資本額 772.3億÷面額10＝普通股75.23億股＋特別股2億股），
 * 所以直接用股數欄位，不用「實收資本額÷面額」（面額另有 1、2.5、5 元、無面額、外幣等例外）。
 *
 * TDR（代號 91 開頭）不給股數：欄位是「原股」股數，TDR 一單位不一定等於一股原股，
 * 拿 TDR 價格乘原股數會算錯。
 */

export interface TwCompanyProfile {
  sharesOutstanding?: number;
  reportCategory: TwReportCategory;
}

/** 一天：股數只在增資／減資／轉換時變動，官方表也是每天更新一次。 */
export const TW_COMPANY_PROFILE_TTL_MS = 24 * 60 * 60_000;
const CACHE_KEY = "twCompanyProfile:all:v1";

/** TWSE／TPEx 產業別代碼 17＝金融保險業（見 twse.ts TW_INDUSTRY_NAMES）。 */
const FINANCE_INDUSTRY_CODE = "17";

interface TwseProfileRow {
  公司代號?: string;
  公司名稱?: string;
  產業別?: string;
  外國企業註冊地國?: string;
  已發行普通股數或TDR原股發行股數?: string;
}

interface TpexProfileRow {
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  SecuritiesIndustryCode?: string;
  Registration?: string;
  IssueShares?: string;
}

function parseShares(raw: string | undefined): number | undefined {
  const n = Number((raw ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 本國公司的「外國企業註冊地國」欄位是全形「－」（或空白）。 */
function isForeignRegistration(raw: string | undefined): boolean {
  const v = (raw ?? "").trim();
  return v !== "" && v !== "－" && v !== "-";
}

export function classifyTwReportCategory(fullName: string, industryCode: string, registration: string | undefined): TwReportCategory {
  if (fullName.includes("金融控股")) return "financialHolding";
  if (industryCode.trim() === FINANCE_INDUSTRY_CODE) return "financial";
  if (isForeignRegistration(registration)) return "foreign";
  return "general";
}

function toProfile(code: string, fullName: string, industry: string, registration: string | undefined, shares: string | undefined): TwCompanyProfile {
  const isTdr = code.startsWith("91");
  return {
    sharesOutstanding: isTdr ? undefined : parseShares(shares),
    reportCategory: classifyTwReportCategory(fullName, industry, registration),
  };
}

async function fetchTwseProfiles(): Promise<Map<string, TwCompanyProfile>> {
  const res = await fetchWithTimeout("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", 10_000);
  const rows = (await res.json()) as TwseProfileRow[];
  const map = new Map<string, TwCompanyProfile>();
  for (const r of rows) {
    const code = r.公司代號?.trim();
    if (!code) continue;
    map.set(code, toProfile(code, r.公司名稱 ?? "", r.產業別 ?? "", r.外國企業註冊地國, r.已發行普通股數或TDR原股發行股數));
  }
  return map;
}

async function fetchTpexProfiles(url: string): Promise<Map<string, TwCompanyProfile>> {
  const rows = await fetchTpexJson<TpexProfileRow[]>(url, 10_000);
  const map = new Map<string, TwCompanyProfile>();
  for (const r of rows) {
    const code = r.SecuritiesCompanyCode?.trim();
    if (!code) continue;
    map.set(code, toProfile(code, r.CompanyName ?? "", r.SecuritiesIndustryCode ?? "", r.Registration, r.IssueShares));
  }
  return map;
}

/**
 * 全市場整包（唯一入口，同一個 key 只用這一種快取模式：一天 TTL＋DAILY_DATA_SWR_MS）。
 * 興櫃來源失敗只少興櫃；上市／上櫃失敗則整包丟錯（見下）。
 * 興櫃放最前（被覆蓋）：同一代號若轉板期間同時出現，以上市／上櫃為準。
 */
export function getTwCompanyProfileMap(): Promise<Map<string, TwCompanyProfile>> {
  return cachedMap(
    CACHE_KEY,
    TW_COMPANY_PROFILE_TTL_MS,
    async () => {
      const [emerging, tpex, twse] = await Promise.all([
        fetchTpexProfiles("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R").catch(() => new Map<string, TwCompanyProfile>()),
        fetchTpexProfiles("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O").catch(() => new Map<string, TwCompanyProfile>()),
        fetchTwseProfiles().catch(() => new Map<string, TwCompanyProfile>()),
      ]);
      // 上市或上櫃任一整包抓失敗就丟錯（有舊值時 SWR 繼續回舊值），不把缺一半的表寫進快取擋一整天。
      if (twse.size === 0 || tpex.size === 0) throw new Error("twCompanyProfile: TWSE/TPEx source failed");
      return new Map([...emerging, ...tpex, ...twse]);
    },
    { staleWhileRevalidateMs: DAILY_DATA_SWR_MS }
  );
}

/** 單檔查詢；取不到（ETF、來源故障）回 undefined，不會丟錯。 */
export async function getTwCompanyProfile(symbol: string): Promise<TwCompanyProfile | undefined> {
  try {
    return (await getTwCompanyProfileMap()).get(symbol);
  } catch {
    return undefined;
  }
}
