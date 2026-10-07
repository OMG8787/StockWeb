/**
 * 帳號權限的唯一來源：權限代碼、角色範本、投資策略、以及「哪個網址需要哪個權限」。
 * proxy（擋請求）、導覽列（隱藏選單）、管理頁（勾選表格）、API 都只讀這一份，
 * 新增功能時只要在這裡加一行，三邊就會一起生效。
 *
 * 設計沿用 FonegleWeb：權限以「功能模組」授權，13 最高管理員不受限制。
 * 這個檔案會被 proxy 載入，不能 import 任何 Node 專用模組。
 */

export const PERM = {
  SUPER_ADMIN: 13,
  ADMIN: 3,
  MARKET: 30,
  AI_CHAT: 31,
  ACTION: 32,
  SIM_PORTFOLIO: 33,
  SCOREBOARD: 34,
  // 35（關注清單同步）2026-10-07 取消：關注清單與庫存一律綁定帳號，試算表裡殘留的 35 會被 parsePerms 忽略
} as const;

export type PermCode = (typeof PERM)[keyof typeof PERM];

export const PERMISSION_LIST: Array<{ code: PermCode; label: string; detail: string }> = [
  { code: PERM.SUPER_ADMIN, label: "最高管理員", detail: "全部功能；只有最高管理員能授予或移除此權限" },
  { code: PERM.ADMIN, label: "系統管理", detail: "帳號與權限、登入狀態與紀錄" },
  { code: PERM.MARKET, label: "行情瀏覽", detail: "首頁、個股、搜尋篩選、每日焦點、重大新聞" },
  { code: PERM.AI_CHAT, label: "AI 問答", detail: "右下角 AI 問答、個股 AI 分析、回報" },
  { code: PERM.ACTION, label: "今日建議", detail: "今日建議／明日操作、每日快報" },
  { code: PERM.SIM_PORTFOLIO, label: "AI 模擬組合", detail: "AI 模擬投資組合" },
  { code: PERM.SCOREBOARD, label: "評等看板", detail: "評等紀錄、勝率統計、學習紀錄" },
];

export const ROLE_TEMPLATES: Array<{ id: string; label: string; perms: PermCode[] }> = [
  { id: "admin", label: "管理員", perms: [PERM.ADMIN, PERM.MARKET, PERM.AI_CHAT, PERM.ACTION, PERM.SIM_PORTFOLIO, PERM.SCOREBOARD] },
  { id: "advanced", label: "進階使用者", perms: [PERM.MARKET, PERM.AI_CHAT, PERM.ACTION, PERM.SIM_PORTFOLIO, PERM.SCOREBOARD] },
  { id: "basic", label: "一般使用者", perms: [PERM.MARKET, PERM.AI_CHAT] },
  { id: "viewer", label: "只看行情", perms: [PERM.MARKET] },
];

/** 投資策略（每個帳號一個）。目前只記錄與顯示，尚未影響 AI 建議內容。 */
export const STRATEGIES: Array<{ id: string; label: string }> = [
  { id: "default", label: "本站綜合評等（預設）" },
  { id: "conservative", label: "保守穩健" },
  { id: "aggressive", label: "積極成長" },
  { id: "swing", label: "短線波段" },
  { id: "long", label: "長線存股" },
];

export const DEFAULT_STRATEGY = "default";

export function strategyLabel(id: string): string {
  return STRATEGIES.find((s) => s.id === id)?.label ?? STRATEGIES[0].label;
}

const KNOWN_CODES = new Set<number>(PERMISSION_LIST.map((p) => p.code));

/** 試算表裡的 "30,31, 32" → [30,31,32]；未知代碼直接丟掉。 */
export function parsePerms(raw: string | number[] | undefined | null): PermCode[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,|\s]+/);
  const out = new Set<PermCode>();
  for (const v of list) {
    const n = Number(v);
    if (KNOWN_CODES.has(n)) out.add(n as PermCode);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatPerms(perms: readonly number[]): string {
  return parsePerms([...perms]).join(",");
}

/** 擁有 need 裡任一個權限即可；need 空陣列＝登入即可；13 不受限制。 */
export function hasPerm(perms: readonly number[], need: readonly number[]): boolean {
  if (perms.includes(PERM.SUPER_ADMIN)) return true;
  if (need.length === 0) return true;
  return need.some((n) => perms.includes(n));
}

export function isAdmin(perms: readonly number[]): boolean {
  return hasPerm(perms, [PERM.ADMIN]);
}

/** 不需要登入的路徑（登入頁、登入／申請帳號／忘記密碼 API、排程） */
const PUBLIC_PREFIXES = ["/login", "/api/auth/login", "/api/auth/setup", "/api/auth/register", "/api/auth/forgot", "/api/cron/"];

/** 登入後即可使用、不需要任何功能權限的路徑（帳號設定、登出、改密碼、自己的關注清單與庫存） */
const ANY_USER_PREFIXES = ["/account", "/api/auth/", "/api/watchlist"];

/**
 * 網址 → 需要的權限。依序比對，第一個符合的生效；都不符合就需要「行情瀏覽」。
 * 頁面與它用到的 API 寫在同一行，避免頁面開了、API 卻被擋。
 */
const ROUTE_RULES: Array<{ prefixes: string[]; need: PermCode[] }> = [
  { prefixes: ["/admin", "/api/admin"], need: [PERM.ADMIN] },
  { prefixes: ["/action", "/api/action-brief", "/api/daily-brief", "/api/brief-archive"], need: [PERM.ACTION] },
  { prefixes: ["/portfolio", "/api/sim-portfolio"], need: [PERM.SIM_PORTFOLIO] },
  { prefixes: ["/scoreboard", "/api/rating-log", "/api/learning"], need: [PERM.SCOREBOARD] },
  { prefixes: ["/api/ask"], need: [PERM.AI_CHAT] }, // 含 /api/ask-feedback（AI 回答回饋與網站回報）
];

function matches(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix + "?");
}

export type RouteAccess = { kind: "public" } | { kind: "user"; need: PermCode[] };

export function routeAccess(pathname: string): RouteAccess {
  if (PUBLIC_PREFIXES.some((p) => matches(pathname, p))) return { kind: "public" };
  if (ANY_USER_PREFIXES.some((p) => matches(pathname, p))) return { kind: "user", need: [] };
  for (const rule of ROUTE_RULES) {
    // 刻意用前綴比對：/api/ask 也涵蓋 /api/ask-feedback
    if (rule.prefixes.some((p) => pathname.startsWith(p))) return { kind: "user", need: rule.need };
  }
  return { kind: "user", need: [PERM.MARKET] };
}

/** 導覽列項目與需要的權限（SiteHeader 用；網址的實際擋法以 routeAccess 為準）。 */
export function canSeePath(perms: readonly number[], pathname: string): boolean {
  const access = routeAccess(pathname);
  return access.kind === "public" || hasPerm(perms, access.need);
}
