/**
 * 台股「下一份財報的法定最晚公告期限」（純邏輯、無 I/O）。
 *
 * 台股沒有免費、統一的「公司預定公布財報日」資料，所以這裡只給法律規定的最晚期限，
 * 顯示時一律寫「依法最晚 X 前公布」，不能冒充公司公告的確切日期。
 *
 * 依據：證券交易法第36條第1項（年度財報：會計年度終了後3個月內；第1~3季：每季終了後
 * 45日內），以及證交所每季的申報期限公告（2025~2026 經濟日報／中時引述證交所新聞稿）：
 * - 一般上市櫃公司：Q1 5/15、Q2 8/14、Q3 11/14、年報 次年 3/31
 * - 金融保險業（產業別 17）及第一上市（外國企業，KY）公司：Q2 延到 8/31，其餘同一般
 * - 金融控股公司（13 家）：Q1 5/30、Q2 8/31、Q3 11/29、年報 3/31
 * 期限遇假日順延到下一個上班日：這裡只處理週末（落在週六、日就順延到下一個週一，見 rollWeekendToMonday）；
 * 國定假日沒有免費、穩定的資料源可查，所以不推算（畫面仍註明「遇假日順延」涵蓋這部分）。
 */

export type TwReportCategory = "general" | "financial" | "foreign" | "financialHolding";

type MonthDay = readonly [month: number, day: number];

interface DeadlineSet {
  q1: MonthDay;
  q2: MonthDay;
  q3: MonthDay;
  /** 年度財報：次年的這一天 */
  annual: MonthDay;
}

/** 一般上市櫃公司（證券交易法第36條：季報 45 日、年報 3 個月）。 */
export const TW_REPORT_DEADLINES_GENERAL: DeadlineSet = { q1: [5, 15], q2: [8, 14], q3: [11, 14], annual: [3, 31] };
/** 金融保險業、第一上市（外國企業）公司：半年報延到 8/31（證交所第2季財報申報期限公告）。 */
export const TW_REPORT_DEADLINES_FINANCIAL_OR_FOREIGN: DeadlineSet = { q1: [5, 15], q2: [8, 31], q3: [11, 14], annual: [3, 31] };
/** 金融控股公司：Q1 5/30、Q2 8/31、Q3 11/29（證交所第1、3季財報申報期限公告）。 */
export const TW_REPORT_DEADLINES_FINANCIAL_HOLDING: DeadlineSet = { q1: [5, 30], q2: [8, 31], q3: [11, 29], annual: [3, 31] };

const DEADLINES_BY_CATEGORY: Record<TwReportCategory, DeadlineSet> = {
  general: TW_REPORT_DEADLINES_GENERAL,
  financial: TW_REPORT_DEADLINES_FINANCIAL_OR_FOREIGN,
  foreign: TW_REPORT_DEADLINES_FINANCIAL_OR_FOREIGN,
  financialHolding: TW_REPORT_DEADLINES_FINANCIAL_HOLDING,
};

export interface TwReportDeadline {
  /** YYYY-MM-DD */
  date: string;
  /** 例如「115年Q3」「115年度年報」 */
  period: string;
}

interface Candidate extends TwReportDeadline {
  key: number; // 用來比大小：YYYYMMDD
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 法定期限落在週六／週日 → 順延到下一個週一（國定假日不處理，見檔頭說明）。 */
export function rollWeekendToMonday(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const add = dow === 6 ? 2 : dow === 0 ? 1 : 0;
  if (add) dt.setUTCDate(dt.getUTCDate() + add);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 西元會計年度 fiscalYear 第 quarter 季（4＝年報）的期限（已做週末順延）。 */
function deadlineFor(set: DeadlineSet, fiscalYear: number, quarter: 1 | 2 | 3 | 4): Candidate {
  const [m0, d0] = quarter === 1 ? set.q1 : quarter === 2 ? set.q2 : quarter === 3 ? set.q3 : set.annual;
  const { y, m, d } = rollWeekendToMonday(quarter === 4 ? fiscalYear + 1 : fiscalYear, m0, d0);
  const roc = fiscalYear - 1911;
  return {
    date: `${y}-${pad(m)}-${pad(d)}`,
    period: quarter === 4 ? `${roc}年度年報` : `${roc}年Q${quarter}`,
    key: y * 10000 + m * 100 + d,
  };
}

/** 台北日期（YYYYMMDD 數字）。 */
function taipeiDateKey(now: Date): { key: number; year: number } {
  const t = new Date(now.getTime() + 8 * 60 * 60_000);
  const year = t.getUTCFullYear();
  return { key: year * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(), year };
}

/** 解析台股 EPS 標籤（「115年Q1」「115年Q1～Q3累計」，見 earningsLabel.ts）→ 西元年＋最新已公布季。 */
export function parseTwEpsPeriod(label: string | undefined): { fiscalYear: number; quarter: 1 | 2 | 3 | 4 } | null {
  const m = label?.match(/^(\d{2,3})年Q(?:1～Q)?([1-4])/);
  if (!m) return null;
  return { fiscalYear: Number(m[1]) + 1911, quarter: Number(m[2]) as 1 | 2 | 3 | 4 };
}

/**
 * 下一份財報的法定最晚期限。
 * - 有最新已公布 EPS 季別時，取「下一季」的期限（公司提早公布完本季，就不會還顯示本季期限）；
 * - 推出來的期限已經過了（資料還沒更新、或公司逾期）或沒有 EPS 季別時，改取「今天以後最近的期限」。
 */
export function nextTwReportDeadline(
  category: TwReportCategory,
  latestEpsPeriodLabel: string | undefined,
  now: Date = new Date()
): TwReportDeadline {
  const set = DEADLINES_BY_CATEGORY[category];
  const today = taipeiDateKey(now);

  const latest = parseTwEpsPeriod(latestEpsPeriodLabel);
  if (latest) {
    const next =
      latest.quarter === 4
        ? deadlineFor(set, latest.fiscalYear + 1, 1)
        : deadlineFor(set, latest.fiscalYear, (latest.quarter + 1) as 2 | 3 | 4);
    if (next.key >= today.key) return { date: next.date, period: next.period };
  }

  const candidates = [
    deadlineFor(set, today.year - 1, 4),
    deadlineFor(set, today.year, 1),
    deadlineFor(set, today.year, 2),
    deadlineFor(set, today.year, 3),
    deadlineFor(set, today.year, 4),
  ];
  const hit = candidates.find((c) => c.key >= today.key) ?? candidates[candidates.length - 1];
  return { date: hit.date, period: hit.period };
}

/** 畫面／AI 共用的誠實寫法：「依法最晚 2026/11/16 前公布（115年Q3）」。 */
export function formatTwReportDeadline(d: TwReportDeadline): string {
  return `依法最晚 ${d.date.replaceAll("-", "/")} 前公布（${d.period}）`;
}
