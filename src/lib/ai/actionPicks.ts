import type { RatingCode, SiteRating } from "./siteRating";
import type { TradingStance } from "./tradingStance";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT, SCORED_FACET_LABEL } from "./actionScoring";

/**
 * 今日建議「名單由程式決定、AI 只寫解說」（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 正式站：AI 在「等回檔」列了 7 檔（規則寫最多 3 檔）、同一檔同時出現在「不建議追」與「等回檔」。
 * 只靠提示詞擋不住，所以分組、上限、排序、去重、互斥、「不建議追」選哪一檔全部由這裡決定；
 * AI 只回 JSON（每檔理由／風險、排序偏好、我的看法、留意），畫面文字由 renderActionBrief 組出來。
 */

/**
 * 「建議買進」最多幾檔。2026-10-05 使用者：「明日操作建議都沒有建議買的，是太保守嗎？不要為了勝率錯失機會」——
 * 評等改為果斷二分（不再有等回檔組），建議買進最多列 5 檔、排序由程式決定（selectPickGroups）。
 */
export const PICK_GROUP_LIMIT = 5;
/** 「不建議追」只從面向支持數 ≤ 這個值的漲幅榜股票挑。 */
export const NOT_CHASE_MAX_SUPPORT = 1;
/** 「不建議追」只看漲幅榜前幾名。 */
export const NOT_CHASE_GAINER_TOP = 10;

export interface PickInput {
  symbol: string;
  name: string;
  rating: SiteRating;
}

export interface ActionBriefPick {
  symbol: string;
  name: string;
  /** 本站綜合評等字樣（未持有），例如「建議買進（現價 557 可分批買；若拉回到 534 附近可加碼）」 */
  label: string;
  /** buy＝建議買進（今日建議只列這種；buy-on-pullback 只會出現在舊快取，視同建議買進） */
  code: RatingCode;
  holdingLabel: string;
  reason: string;
  /** 程式組好的操作計畫（價位全部來自評等） */
  plan?: string;
  /** AI 判斷層的一行看法——2026-10-06 起不顯示給使用者（冠軍／挑戰者證明前只記錄），保留欄位相容舊快取 */
  aiView?: string | null;
}

/**
 * 排序＋去重＋上限（只有「建議買進」一組）：面向支持數多→少、不支持少→多、現價貼近支撐（沒有拉回加碼價）
 * 優先於已漲離支撐的、同分維持原順序（原順序＝候選名單順序）。同一代號只留第一次出現。
 */
export function selectPickGroups<T extends PickInput>(picks: T[], limit = PICK_GROUP_LIMIT): { buy: T[] } {
  const seen = new Set<string>();
  const uniq = picks.filter((p) => {
    const k = p.symbol.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sorted = uniq
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        b.p.rating.supportCount - a.p.rating.supportCount ||
        a.p.rating.againstCount - b.p.rating.againstCount ||
        Number(a.p.rating.pullbackAdd != null) - Number(b.p.rating.pullbackAdd != null) ||
        a.i - b.i
    )
    .map((x) => x.p);
  return { buy: sorted.filter((p) => p.rating.code === "buy" || p.rating.code === "buy-on-pullback").slice(0, limit) };
}

/** 依 AI 給的排序偏好重排（只動程式給的名單；AI 沒提到的照原順序接在後面、AI 多寫的代號忽略）。 */
export function applyAiOrder<T extends { symbol: string }>(list: T[], order: unknown): T[] {
  if (!Array.isArray(order)) return list;
  const rank = new Map<string, number>();
  order.forEach((s, i) => {
    const k = String(s).trim().toUpperCase();
    if (!rank.has(k)) rank.set(k, i);
  });
  return list
    .map((p, i) => ({ p, i, r: rank.get(p.symbol.toUpperCase()) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

export interface NotChasePick {
  symbol: string;
  name: string;
  changePercent: number;
  supportCount: number;
  /** 沒跟上的面向（不支持／無資料／中性）名稱 */
  weakFacets: string[];
}

/**
 * 「不建議追」：漲幅榜前 NOT_CHASE_GAINER_TOP 名裡，體檢表也有、面向支持數 ≤ NOT_CHASE_MAX_SUPPORT 的第一檔；
 * 一定排除已列在建議買進／等回檔的代號（互斥）。找不到回 null（畫面寫「漲幅榜前段體質大多說得過去」）。
 */
export function selectNotChase(
  gainers: Array<{ symbol: string; name: string; changePercent: number }>,
  scored: Array<{ symbol: string; supportCount: number; facets: Array<{ name: string; verdict: string }> }>,
  exclude: Iterable<string>
): NotChasePick | null {
  const ex = new Set([...exclude].map((s) => s.toUpperCase()));
  for (const g of gainers.slice(0, NOT_CHASE_GAINER_TOP)) {
    if (ex.has(g.symbol.toUpperCase())) continue;
    const c = scored.find((s) => s.symbol.toUpperCase() === g.symbol.toUpperCase());
    if (!c || c.supportCount > NOT_CHASE_MAX_SUPPORT) continue;
    return {
      symbol: g.symbol,
      name: g.name,
      changePercent: g.changePercent,
      supportCount: c.supportCount,
      weakFacets: c.facets.filter((f) => f.verdict !== "支持").map((f) => f.name.replace(/（.*$/, "")),
    };
  }
  return null;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** 程式組的操作計畫（價位全部來自評等，AI 不寫價位）。先不要買不給計畫（沒有買進價位與出場價）。 */
export function buildPlan(r: SiteRating, stance: Pick<TradingStance, "briefMode" | "nextOpenLabel">): string {
  if (r.code === "avoid") return r.upgradeCondition ? `先不買；改判建議買進的條件：${r.upgradeCondition}` : "先不買";
  const nextOpen = stance.briefMode === "next-open";
  const exit = r.exit != null ? `買進後跌破 ${fmt(r.exit)} 出場` : "";
  const add = r.pullbackAdd != null ? `拉回到 ${fmt(r.pullbackAdd)} 附近可加碼` : "";
  const parts = nextOpen ? [`${stance.nextOpenLabel}開盤或盤中可買（分批）`, add, exit] : ["現價可分批買", add, exit];
  return parts.filter(Boolean).join("；");
}

/** AI 回傳的 JSON（每個欄位都可能缺，缺了用程式文字補）。 */
export interface ActionBriefAiJson {
  market?: string;
  order?: string[];
  picks?: Record<string, { reason?: string; risk?: string }>;
  view?: string;
  confidence?: string;
  confidenceReason?: string;
  notChase?: string;
  watch?: string;
}

/** 從 AI 回答取出 JSON 物件；格式錯回 null。 */
export function parseActionBriefJson(answer: string): ActionBriefAiJson | null {
  const m = answer.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ActionBriefAiJson) : null;
  } catch {
    return null;
  }
}

/**
 * 找 AI JSON 裡這一檔的理由／風險：key 可能是「2527」「宏璟」「宏璟(2527)」，picks 也可能被寫成陣列
 * [{symbol, reason, risk}]（正式站實測 key 對不上時整段理由退回程式版）。
 */
function aiPickText(ai: ActionBriefAiJson | null, p: { symbol: string; name: string }): { reason?: string; risk?: string } | undefined {
  const picks = ai?.picks as unknown;
  if (!picks || typeof picks !== "object") return undefined;
  const sym = p.symbol.toUpperCase();
  const entries: Array<[string, unknown]> = Array.isArray(picks)
    ? picks.map((x) => [String((x as Record<string, unknown>)?.symbol ?? (x as Record<string, unknown>)?.name ?? ""), x])
    : Object.entries(picks as Record<string, unknown>);
  const hit = entries.find(([k]) => k.trim().toUpperCase() === sym) ?? entries.find(([k]) => k.toUpperCase().includes(sym) || k.includes(p.name));
  const v = hit?.[1];
  return v && typeof v === "object" ? (v as { reason?: string; risk?: string }) : undefined;
}

/** 「先不要買／不建議追」那段的小標。 */
export const NOT_CHASE_TITLE = "先不要買／不建議追";

const str = (v: unknown, max = 160) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const sentence = (s: string) => s.replace(/[。.]+$/, "");

/** AI 的「不建議追」一句：去掉開頭重複的名稱代號與「面向支持數為N」這種跟程式文字重複的片段。 */
function notChaseText(ai: ActionBriefAiJson | null, nc: NotChasePick): string {
  let t = str(ai?.notChase, 80);
  for (const prefix of [`${nc.name}(${nc.symbol})`, `${nc.name}（${nc.symbol}）`, nc.name]) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length).replace(/^\s*[：:，,]?\s*/, "");
      break;
    }
  }
  return sentence(t.replace(/^[^，,。]*面向支持數(?:為|只有)?\s*\d+\s*[，,、]?/, "").trim());
}

export interface RenderInput {
  stance: Pick<TradingStance, "briefMode" | "nextOpenLabel">;
  marketLine: string;
  buy: ActionBriefPick[];
  notChase: NotChasePick | null;
  /** 大盤偏弱提示（siteRating.ts weakMarketNote；大盤不弱是 null），頁首提示一次 */
  marketNote?: string | null;
  /** 今天有沒有漲幅榜資料（沒有就寫「今日漲幅榜無資料」） */
  gainersAvailable: boolean;
  /** AI 回的 JSON；null＝AI 失敗（fallback，只用程式文字） */
  ai: ActionBriefAiJson | null;
  /** fallback 時最後一行的原因 */
  failureNote?: string;
}

/**
 * 「建議買進」的條列（AI 版與 fallback 共用）。名單只取 picks 裡建議買進的、最多 PICK_GROUP_LIMIT 檔；
 * AI JSON 只提供每檔理由／風險與排序偏好，多寫的代號一律忽略。
 */
export function groupedPickLines(
  picks: ActionBriefPick[],
  stance: Pick<TradingStance, "briefMode" | "nextOpenLabel">,
  ai: ActionBriefAiJson | null = null
): string[] {
  const nextOpen = stance.briefMode === "next-open";
  const buy = applyAiOrder(picks.filter((p) => p.code !== "avoid").slice(0, PICK_GROUP_LIMIT), ai?.order);
  const pickLine = (p: ActionBriefPick) => {
    const t = aiPickText(ai, p);
    const reason = str(t?.reason) || p.reason;
    const risk = str(t?.risk);
    // AI 看法接在同一個條列尾端（MarkdownLite 不支援巢狀清單，另起一行會被當成另一檔）。
    return [
      `- **${p.name}(${p.symbol})**：${p.label}。${p.plan ? `操作：${sentence(p.plan)}。` : ""}理由：${sentence(reason)}。${risk ? `風險：${sentence(risk)}。` : ""}`,
    ];
  };
  const buyTitle = nextOpen ? `**${stance.nextOpenLabel} 建議買進（開盤或盤中可買）**` : "**建議買進（現價可分批買）**";
  if (buy.length === 0) {
    return [
      buyTitle,
      `- ${nextOpen ? `${stance.nextOpenLabel} 先不買` : "今天先不買"}：沒有個股同時通過${SCORED_FACET_LABEL}的體質門檻（至少 ${QUALIFY_MIN_SUPPORT} 項支持、不支持最多 ${QUALIFY_MAX_AGAINST} 項、技術面不能是不支持）。`,
    ];
  }
  return [buyTitle, ...buy.flatMap(pickLine)];
}

/**
 * 組出今日建議全文（AI 版與 fallback 共用同一個函式，名單、分組、價位一定一致）。
 */
export function renderActionBrief(input: RenderInput): string {
  const { stance, ai } = input;
  const picks = input.buy;
  const out: string[] = [`**大盤**：${sentence(str(ai?.market, 80) || input.marketLine)}。`];
  if (input.marketNote && picks.length > 0) out.push(`**${sentence(input.marketNote).replace(/^大盤偏弱提示：/, "大盤偏弱提示**：")}。`);
  out.push(...groupedPickLines(picks, stance, ai));
  const view = str(ai?.view, 220);
  if (view && picks.length > 0) {
    const conf = ["高", "中", "低"].includes(str(ai?.confidence)) ? str(ai?.confidence) : "";
    const why = str(ai?.confidenceReason, 80);
    out.push(`**我的看法**：${sentence(view)}。${conf ? `把握程度：${conf}${why ? `（${sentence(why)}）` : ""}。` : ""}`);
  }
  const nc = input.notChase;
  out.push(
    nc
      ? `**${NOT_CHASE_TITLE}**：${nc.name}(${nc.symbol}) 今日 ${nc.changePercent >= 0 ? "+" : ""}${nc.changePercent}%，但面向支持數只有 ${nc.supportCount}${
          notChaseText(ai, nc) ? `，${notChaseText(ai, nc)}` : nc.weakFacets.length ? `（${nc.weakFacets.join("、")}沒跟上）` : ""
        }。`
      : input.gainersAvailable
        ? `**${NOT_CHASE_TITLE}**：漲幅榜前段體質大多說得過去。`
        : `**${NOT_CHASE_TITLE}**：今日漲幅榜無資料。`
  );
  const watch = str(ai?.watch, 120);
  if (ai && watch) out.push(`**留意**：${sentence(watch)}。`);
  if (!ai) out.push(`**留意**：AI 白話說明暫時無法產生（${(input.failureNote ?? "未知原因").replace(/。$/, "")}），以上為程式依各面向評分與價位算出的評等。`);
  return out.join("\n");
}

/** AI 解說層（只在時點重寫）：撰寫當下每一檔的結論字樣，用來判斷現在還能不能沿用。 */
export interface ActionAiLayer {
  ai: ActionBriefAiJson | null;
  /** 撰寫當下名單：代號 → 評等字樣（label）。結論或價位字樣不同就不可沿用該檔解說。 */
  labels: Record<string, string>;
  notChaseSymbol: string | null;
}

/**
 * 合併「程式即時名單」與「時點撰寫的 AI 解說」（純函式，有測試）。
 * - 名單裡某檔在撰寫當下也在名單、而且評等字樣（含價位）完全相同 → 沿用 AI 理由／風險。
 * - 新加入或結論／價位已改變 → 只用程式理由，並註明「解說將於下次更新（HH:MM）補上」；絕不沿用舊解說。
 * - 「我的看法」只在名單（代號＋字樣）跟撰寫當下完全相同時才顯示；「不建議追」AI 句只在同一檔時沿用。
 */
export function mergeAiExplanation(
  picks: ActionBriefPick[],
  layer: ActionAiLayer | null,
  notChaseSymbol: string | null,
  nextUpdate: string
): { picks: ActionBriefPick[]; ai: ActionBriefAiJson | null; stale: string[] } {
  if (!layer?.ai) return { picks, ai: null, stale: [] };
  const stale: string[] = [];
  const keepPicks: Record<string, { reason?: string; risk?: string }> = {};
  const merged = picks.map((p) => {
    const sym = p.symbol.toUpperCase();
    const same = layer.labels[sym] === p.label;
    const t = same ? aiPickText(layer.ai, p) : undefined;
    if (t) {
      keepPicks[sym] = t;
      return p;
    }
    if (!same) stale.push(sym);
    return same ? p : { ...p, reason: `${sentence(p.reason)}（解說將於下次更新（${nextUpdate}）補上）` };
  });
  const sameList =
    stale.length === 0 && Object.keys(layer.labels).length === picks.length && picks.every((p) => layer.labels[p.symbol.toUpperCase()] === p.label);
  const ai: ActionBriefAiJson = {
    ...layer.ai,
    picks: keepPicks,
    view: sameList ? layer.ai.view : undefined,
    confidence: sameList ? layer.ai.confidence : undefined,
    confidenceReason: sameList ? layer.ai.confidenceReason : undefined,
    notChase: layer.notChaseSymbol && layer.notChaseSymbol === notChaseSymbol ? layer.ai.notChase : undefined,
  };
  return { picks: merged, ai, stale };
}
