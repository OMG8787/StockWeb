import { cached, fetchWithTimeout, peekCached, writeCached } from "./cache";

/**
 * 大戶持股比例——集保結算所「集保戶股權分散表」，**每週公布一次**（以每週最後一個
 * 營業日收盤後的集保餘額編製），不是每日資料，UI/AI 都要照實標示「週資料」。
 *
 * 「大戶」定義：持股 1,000 張以上＝持股分級第 15 級（1,000,001 股以上），跟市面
 * 看盤軟體「大戶持股 1000」門檻一致。分級 1~15 為持股區間、16 為差異數調整、17 為
 * 合計（2026-09-30 用真實資料確認：第17級比例恆為 100.00）。
 *
 * 比例自己算：第15級股數 ÷ 第17級合計股數，四捨五入到小數兩位。集保 CSV 的「占集保
 * 庫存數比例%」是無條件捨去（6488：339,878,636 ÷ 478,113,725 = 71.0876% → 官方
 * 71.08、看盤軟體 71.09），自己算才會跟使用者習慣看的數字對得上。
 *
 * 資料源：
 * 1. 全市場最新一週：opendata.tdcc.com.tw/getOD.ashx?id=1-5（CSV 約 2.3MB，只有
 *    最新一週）。解析一次整包快取 6 小時，每檔只存 [人數, 股數, 比例] 三個數字。
 * 2. 上一週：
 *    a. 主要來源＝本站自己留存的週快照（每次重新解析 CSV 發現資料日期換週時，把
 *       舊的那週留下來當「上一週」，長效 Redis key，零額外上游請求——比照
 *       volumeHistory.ts 的 piggyback 作法）。
 *    b. 快照還沒累積到（剛上線、或新上市股票）時，退回集保官網「個股查詢」頁
 *       （www.tdcc.com.tw/portal/zh/smWeb/qryStock，保存一年歷史）只查這一檔的
 *       上一週，依「代號+週別」長效快取——過去週的資料不會再變。
 *       這個頁面是表單：要先 GET 拿 JSESSIONID cookie 與 SYNCHRONIZER_TOKEN
 *       （token 綁 session，每次查詢都要重拿），再帶同一個 cookie POST。
 */

/** [人數, 股數, 大戶持股比例(%)] */
type MajorRow = [number, number, number];

interface WeekSnapshot {
  /** YYYYMMDD */
  date: string;
  rows: Record<string, MajorRow>;
}

interface WeeksBlob {
  /** 新到舊，最多 2 週（本週、上一週） */
  weeks: WeekSnapshot[];
}

const TDCC_CSV_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";
const TDCC_QUERY_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";

const LATEST_TTL_MS = 6 * 60 * 60_000;
const HISTORY_KEY = "major-holders:TW:weeks:v1";
const HISTORY_TTL_MS = 60 * 24 * 60 * 60_000;
const WEB_WEEK_TTL_MS = 30 * 24 * 60 * 60_000;

const MAJOR_TIER = "15";
const TOTAL_TIER = "17";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseIntSafe(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = parseInt(raw.replace(/[,\s]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchLatestWeekFromCsv(): Promise<WeekSnapshot> {
  const res = await fetchWithTimeout(TDCC_CSV_URL, 20_000);
  const text = await res.text();
  const major = new Map<string, [number, number]>();
  const totals = new Map<string, number>();
  let date = "";
  for (const line of text.split(/\r?\n/)) {
    // 欄位：資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
    const cols = line.split(",");
    if (cols.length < 5) continue;
    const tier = cols[2]?.trim();
    if (tier !== MAJOR_TIER && tier !== TOTAL_TIER) continue;
    // 證券代號欄位尾端有空白（例如 "6488  "），一定要 trim。
    const code = cols[1]?.trim();
    const shares = parseIntSafe(cols[4]);
    if (!code || shares == null) continue;
    if (!date && /^\d{8}$/.test(cols[0].trim())) date = cols[0].trim();
    if (tier === TOTAL_TIER) totals.set(code, shares);
    else major.set(code, [parseIntSafe(cols[3]) ?? 0, shares]);
  }
  if (!date || totals.size === 0) throw new Error("TDCC CSV: no rows parsed");
  const rows: Record<string, MajorRow> = {};
  for (const [code, [holders, shares]] of major) {
    const total = totals.get(code);
    if (!total) continue;
    rows[code] = [holders, shares, round2((shares / total) * 100)];
  }
  return { date, rows };
}

/**
 * 解析最新 CSV，同時把週快照往前推一格。寫入失敗/讀不到舊快照都不影響本週資料本身
 * （快取層永遠 fail open）。
 */
async function loadWeeks(): Promise<WeeksBlob> {
  const latest = await fetchLatestWeekFromCsv();
  let history: WeeksBlob | undefined;
  try {
    history = await peekCached<WeeksBlob>(HISTORY_KEY);
  } catch {
    history = undefined;
  }
  const older = (history?.weeks ?? []).filter((w) => w.date < latest.date);
  const weeks = [latest, ...older].slice(0, 2);
  if (history?.weeks[0]?.date !== latest.date) {
    await writeCached(HISTORY_KEY, { weeks } satisfies WeeksBlob, HISTORY_TTL_MS).catch(() => undefined);
  }
  return { weeks };
}

function getWeeks(): Promise<WeeksBlob> {
  return cached("major-holders:TW:v1", LATEST_TTL_MS, loadWeeks);
}

// ---------------------------------------------------------------------------
// 集保官網個股查詢（上一週的備援來源）
// ---------------------------------------------------------------------------

function extractSessionCookie(res: Response): string | undefined {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  for (const c of all) {
    const m = c.match(/JSESSIONID=[^;]+/);
    if (m) return m[0];
  }
  return undefined;
}

/** 從查詢頁的「資料日期」下拉選單找出 latestDate 的前一週。 */
function findPreviousWeek(html: string, latestDate: string): string | undefined {
  const dates = Array.from(html.matchAll(/<option value="(\d{8})"/g), (m) => m[1]);
  return dates.filter((d) => d < latestDate).sort().pop();
}

/** 表格裡某一列（以第二格文字辨識）的「人數、股數」。 */
function extractRow(html: string, label: RegExp): [number, number] | undefined {
  for (const tr of html.split(/<tr[\s>]/)) {
    const cells = Array.from(tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), (m) => m[1].replace(/<[^>]*>/g, "").trim());
    const idx = cells.findIndex((c) => label.test(c));
    if (idx === -1) continue;
    const holders = parseIntSafe(cells[idx + 1]);
    const shares = parseIntSafe(cells[idx + 2]);
    if (holders != null && shares != null) return [holders, shares];
  }
  return undefined;
}

async function queryTdccWebOnce(symbol: string, latestDate: string): Promise<WeekSnapshot | undefined> {
  const pageRes = await fetchWithTimeout(TDCC_QUERY_URL, 10_000);
  const cookie = extractSessionCookie(pageRes);
  const page = await pageRes.text();
  const token = page.match(/name="SYNCHRONIZER_TOKEN" value="([^"]+)"/)?.[1];
  const firDate = page.match(/name="firDate" value="(\d{8})"/)?.[1];
  const scaDate = findPreviousWeek(page, latestDate);
  if (!cookie || !token || !firDate || !scaDate) throw new Error("TDCC query page: missing session/token/date");

  const body = new URLSearchParams({
    SYNCHRONIZER_TOKEN: token,
    SYNCHRONIZER_URI: "/portal/zh/smWeb/qryStock",
    method: "submit",
    firDate,
    scaDate,
    sqlMethod: "StockNo",
    stockNo: symbol,
    stockName: "",
  });
  const res = await fetchWithTimeout(TDCC_QUERY_URL, 10_000, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: body.toString(),
  });
  const html = await res.text();
  // 確認回來的真的是我們要的那一週，不是別週或空表。
  const roc = html.match(/資料日期：(\d{2,3})年(\d{2})月(\d{2})日/);
  const shownDate = roc ? `${parseInt(roc[1], 10) + 1911}${roc[2]}${roc[3]}` : undefined;
  const major = extractRow(html, /^1,000,001以上$/);
  const total = extractRow(html, /^合\s*計$/);
  if (shownDate !== scaDate || !major || !total || total[1] === 0) return undefined;
  return { date: scaDate, rows: { [symbol]: [major[0], major[1], round2((major[1] / total[1]) * 100)] } };
}

/**
 * 查這一檔「latestDate 前一週」的第15級資料。實測偶爾會回「查無此資料」（同樣的
 * 請求重送就好），所以重試一次；兩次都失敗就丟錯——不快取失敗結果，下次再試。
 */
function fetchPreviousWeekFromWeb(symbol: string, latestDate: string): Promise<WeekSnapshot> {
  return cached(`major-holders:TW:web:${symbol}:${latestDate}:v1`, WEB_WEEK_TTL_MS, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snap = await queryTdccWebOnce(symbol, latestDate).catch(() => undefined);
      if (snap) return snap;
    }
    throw new Error(`TDCC web query failed for ${symbol}`);
  });
}

// ---------------------------------------------------------------------------

export interface MajorHolding {
  /** YYYY-MM-DD */
  date: string;
  holders: number;
  shares: number;
  holdingPercent: number;
  prevDate?: string;
  prevHolders?: number;
  prevHoldingPercent?: number;
}

function toIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 大戶（1000張以上）持股＋上一週；本週資料抓不到或代號不在集保清單裡回 undefined。 */
export async function getMajorHolding(symbol: string): Promise<MajorHolding | undefined> {
  const { weeks } = await getWeeks();
  const latest = weeks[0];
  const row = latest?.rows[symbol];
  if (!latest || !row) return undefined;
  const result: MajorHolding = { date: toIso(latest.date), holders: row[0], shares: row[1], holdingPercent: row[2] };

  let prev: WeekSnapshot | undefined = weeks[1]?.rows[symbol] ? weeks[1] : undefined;
  if (!prev) prev = await fetchPreviousWeekFromWeb(symbol, latest.date).catch(() => undefined);
  const prevRow = prev?.rows[symbol];
  if (prev && prevRow) {
    result.prevDate = toIso(prev.date);
    result.prevHolders = prevRow[0];
    result.prevHoldingPercent = prevRow[2];
  }
  return result;
}
