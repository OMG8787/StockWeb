import type { Facet } from "./actionScoring";
import { stripNameMarker } from "./fuzzyName";
import { confidenceText, type SiteRating } from "./siteRating";
import type { Signal } from "@/lib/signals";

/**
 * 個股「結論卡」（2026-10-06「提高 Lite 下限」）：買賣判斷題由程式先把結論、價位、支持／不支持面向、主要風險
 * 組成一張卡，AI 只負責把卡片解說成白話、不可改結論與數字。結論與價位全部來自 siteRating（getStockRating 的
 * 同一份評等，唯一來源），這裡只做排版；純函式、無 I/O（有測試）。
 *
 * 也提供：
 * - 比較題的程式結論（pickForComparison）：「若只能選一檔選哪檔」由程式依評等決定，AI 不用自己挑、也不會照抄規則範例。
 * - 回答後檢查（answerCardIssues）與程式版回答（renderCardFallback），給 ask.ts 的重生流程用。
 */

export const DECISION_CARD_TITLE = "【結論卡（程式依本站綜合評等算好；買賣判斷照這張卡回答，不可改結論與數字）】";
export const COMPARISON_PICK_TITLE = "【比較結論（程式依本站綜合評等算好）】";

const CARD_FIRST = "- 第一句（照抄）：";
const CARD_LEVELS = "- 價位：";
/** 把握程度行（程式判定；只有未持有且建議買進才印）。confidenceMention.ts 靠這個前綴判斷「這題該講把握程度」。 */
export const CARD_CONFIDENCE_PREFIX = "- 把握程度（照抄）：";
const CARD_SUPPORT = "- 支持的面向：";
const CARD_AGAINST = "- 不支持的面向：";
const CARD_RISK = "- 主要風險：";
/** 每個面向說明最多保留幾個字（太長會稀釋重點）。 */
const FACET_DETAIL_MAX = 90;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function shortDetail(f: Facet): string {
  const d = f.detail.replace(/\s+/g, " ").trim();
  return `${f.name.replace(/（.*$/, "")}：${d.length > FACET_DETAIL_MAX ? `${d.slice(0, FACET_DETAIL_MAX)}…` : d}`;
}

export interface DecisionCardInput {
  name: string;
  symbol: string;
  rating: SiteRating;
  facets: Facet[];
  /** 關注清單顯示已持有（有成本）：第一句用已持有結論 */
  held: boolean;
  /** 技術訊號（computeSignals 同一份）＋最後一根日K的日期與是否為今天：用來寫「死亡交叉說明」 */
  tech?: { signals: Signal[]; lastCandleDate: string | undefined; lastIsToday: boolean };
}

/** 死叉說明引用的回測（scripts/backtest/deathCross.ts，docs/backtest/2026-10-macd-near-cross.md「死亡交叉」節）。 */
export const DEATH_CROSS_BACKTEST_NOTE =
  "回測（近 4 年約 390 檔、死叉後 5／10／20 日）：死叉股票的超額報酬與沒死叉的相比沒有統計上顯著較差，多頭結構（均線多頭排列＋站上20日線）中的死叉也一樣，所以本站不因單一死叉改判";
export const CARD_DEATH_CROSS_PREFIX = "- 死亡交叉說明（程式）：";

/**
 * 技術訊號裡有「死亡交叉」時的程式說明（2026-10-07 使用者回報宏璟：「出現死亡交叉真的還可以買嗎」）。
 * 回答買賣判斷時必須讓使用者知道：哪個死叉、哪一天（已收盤確認或盤中）、本站怎麼看它、為什麼結論沒變。
 * 沒有死叉、或結論已是先不要買時不寫。
 */
export function describeDeathCrossNote(c: Pick<DecisionCardInput, "rating" | "facets" | "tech">): string {
  const t = c.tech;
  if (!t || c.rating.code === "avoid") return "";
  const deaths = t.signals.filter((s) => s.tone === "down" && s.label.includes("死亡交叉"));
  if (deaths.length === 0) return "";
  const kinds = deaths.map((s) => s.label.replace(/（.*$/, "")).join("、");
  const date = t.lastCandleDate ? `${t.lastCandleDate.slice(5).replace("-", "/")}` : "最近一個交易日";
  const when = t.lastIsToday ? `${date}（今天，盤中看到、收盤前可能消失）` : `${date}（已收盤確認）`;
  const bull = t.signals.filter((s) => s.tone === "up").length;
  const verdict = c.facets.find((f) => f.name.startsWith("技術面"))?.verdict ?? "中性";
  return `${CARD_DEATH_CROSS_PREFIX}${kinds}出現在 ${when}；本站把它算一個空方訊號，跟另外 ${bull} 個偏多訊號並列，技術面判定「${verdict}」，結論沒有因此改變。${DEATH_CROSS_BACKTEST_NOTE}；只當短線風險提醒。使用者問「死叉還能買嗎」或回答提到死叉時，照這段講清楚（哪個死叉、哪一天、為什麼結論仍是${c.rating.label}），不可把已收盤的死叉說成「今天盤中出現」。`;
}

/** 第一句要照抄的結論字樣（已持有用 holdingLabel、未持有用 label）。 */
export function cardFirstSentence(c: Pick<DecisionCardInput, "rating" | "held">): string {
  return c.held ? c.rating.holdingLabel : c.rating.label;
}

/** 主要風險（只取一句）：待確認的評等變化 → 短線風險 → 弱市況 → 第一個不支持面向 → 先不要買的改判條件。 */
function mainRisk(c: DecisionCardInput): string {
  const r = c.rating;
  // 2026-10-06 評等穩定化：今天的資料已指向不同結論、還在 2 日確認期間——使用者最需要先知道「明天可能改判」。
  if (r.pendingChange) return r.pendingChange;
  if (r.riskNote) return r.riskNote;
  if (r.marketNote) return r.marketNote;
  const against = c.facets.find((f) => f.verdict === "不支持");
  if (against) return shortDetail(against);
  return "股價波動與大盤變化（沒有特別的短線風險訊號）";
}

export function describeDecisionCard(c: DecisionCardInput): string {
  const r = c.rating;
  const support = c.facets.filter((f) => f.verdict === "支持").map(shortDetail);
  const against = c.facets.filter((f) => f.verdict === "不支持").map(shortDetail);
  const levels =
    r.code === "avoid"
      ? `先不要買時不提任何價位；改判建議買進的條件：${r.upgradeCondition ?? "評等條件轉好"}`
      : [
          r.pullbackAdd != null ? `拉回加碼參考價 ${fmt(r.pullbackAdd)}（只是加碼用，不是買進門檻）` : "",
          r.exit != null && !c.held ? `買進後跌破 ${fmt(r.exit)} 出場` : "",
        ]
          .filter(Boolean)
          .join("；") || "（無）";
  return [
    `${DECISION_CARD_TITLE}${stripNameMarker(c.name)}(${c.symbol})`,
    `${CARD_FIRST}${stripNameMarker(c.name)}(${c.symbol})${cardFirstSentence(c)}`,
    `${CARD_LEVELS}${levels}`,
    ...(c.held || !confidenceText(r) ? [] : [`${CARD_CONFIDENCE_PREFIX}${confidenceText(r)}`]),
    `${CARD_SUPPORT}${support.length ? support.join("；") : "（無）"}`,
    `${CARD_AGAINST}${against.length ? against.join("；") : "（無）"}`,
    `${CARD_RISK}${mainRisk(c)}`,
    ...(describeDeathCrossNote(c) ? [describeDeathCrossNote(c)] : []),
    "- 回答骨架（四入口最優做法：今日建議卡）：第一句照抄上面的結論；卡片有「把握程度」行時緊接一句照抄它→怎麼做一句（依【目前時段與回答立場】，價位照卡片）→2～3 點理由（每點帶一個卡片或個股資料裡的具體數字，從支持／不支持面向挑真正決定結論的）→主要風險一句。精簡，不要逐項轉述資料。",
  ].join("\n");
}

// ---------------------------------------------------------------- 比較題

export interface ComparisonEntry {
  name: string;
  symbol: string;
  rating: SiteRating;
}

/** 比較題的排序分數：建議買進優先，同評等比「支持減不支持」，再比不支持較少。 */
function comparisonScore(e: ComparisonEntry): number {
  return (e.rating.code === "avoid" ? 0 : 1000) + (e.rating.supportCount - e.rating.againstCount) * 10 - e.rating.againstCount;
}

/** 「若只能選一檔選哪檔」由程式決定（同分取問句裡先出現的那檔）；少於兩檔回 null。 */
export function pickForComparison(entries: ComparisonEntry[]): string | null {
  if (entries.length < 2) return null;
  const ranked = entries.map((e, i) => ({ e, i, s: comparisonScore(e) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const best = ranked[0].e;
  const others = ranked.slice(1).map((x) => x.e);
  const nm = (e: ComparisonEntry) => `${stripNameMarker(e.name)}(${e.symbol})`;
  const ratingWord = (e: ComparisonEntry) => (e.rating.code === "avoid" ? "建議先不要買" : "建議買進");
  const why =
    others.every((o) => o.rating.code === "avoid") && best.rating.code !== "avoid"
      ? `${nm(best)}是${ratingWord(best)}，其他是建議先不要買`
      : `評等${best.rating.code === "avoid" ? "都是建議先不要買" : "都是建議買進"}，${nm(best)}支持面向 ${best.rating.supportCount} 項、不支持 ${best.rating.againstCount} 項，條件最好（${others
          .map((o) => `${nm(o)}支持 ${o.rating.supportCount}、不支持 ${o.rating.againstCount}`)
          .join("；")}）`;
  const head =
    best.rating.code === "avoid"
      ? `比較起來這幾檔目前都建議先不要買；若一定要選一檔觀察，選${nm(best)}`
      : `若只能選一檔，選${nm(best)}`;
  return `${COMPARISON_PICK_TITLE}${head}。原因：${why}。回答第一句寫這個選擇（不可改選別檔），各檔結論仍照各自的【本站綜合評等】，再用實際數字比較差在哪。`;
}

// ---------------------------------------------------------------- 回答後檢查與程式版回答

/** 建議買進時不該出現的猶豫字眼（2026-10-05 使用者：建議買就買，不要每次給區間、到了又說不建議）。 */
export const BUY_FORBIDDEN_PATTERN = /等回檔|等拉回再買|現價不買|現價不建議|先觀望|暫時觀望|不在(買進)?區間|回到.{0,12}再(分批)?買/;

interface ParsedCard {
  first: string;
  confidence: string;
  levels: string;
  support: string;
  against: string;
  risk: string;
  name: string;
}

function lineAfter(block: string, prefix: string): string {
  const line = block.split("\n").find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

/** 從參考資料取出所有結論卡。 */
export function parseDecisionCards(grounding: string): ParsedCard[] {
  return grounding
    .split(DECISION_CARD_TITLE)
    .slice(1)
    .map((chunk) => ({
      name: chunk.split("\n")[0].trim(),
      first: lineAfter(chunk, CARD_FIRST),
      confidence: lineAfter(chunk, CARD_CONFIDENCE_PREFIX),
      levels: lineAfter(chunk, CARD_LEVELS),
      support: lineAfter(chunk, CARD_SUPPORT),
      against: lineAfter(chunk, CARD_AGAINST),
      risk: lineAfter(chunk, CARD_RISK),
    }));
}

/** 結論字樣的核心（去掉開頭「名稱(代號)」與括號說明），例如「國巨(2327)建議買進（現價 557 可分批買…）」→「建議買進」。 */
function coreOf(card: ParsedCard): string {
  const label = card.first.startsWith(card.name) ? card.first.slice(card.name.length) : card.first;
  return label.replace(/[（(].*$/, "").trim();
}

/** 「建議先不要買」也接受「先不要買」。 */
function acceptedCores(core: string): string[] {
  return core.startsWith("建議") ? [core, core.slice(2)] : [core];
}

/** 卡片名稱「國巨(2327)」拆成名稱與代號。 */
function nameAndSymbol(card: ParsedCard): { name: string; symbol: string } {
  const m = card.name.match(/^(.*)\(([^)]+)\)$/);
  return m ? { name: m[1], symbol: m[2] } : { name: card.name, symbol: card.name };
}

/** 多檔時：回答裡提到該檔（名稱或代號）後 MULTI_CARD_WINDOW 字內要有它自己的結論字樣。 */
const MULTI_CARD_WINDOW = 220;
function mentionsOwnRating(answer: string, card: ParsedCard): boolean {
  const { name, symbol } = nameAndSymbol(card);
  const cores = acceptedCores(coreOf(card));
  for (const key of [name, symbol]) {
    let i = answer.indexOf(key);
    while (i >= 0) {
      const window = answer.slice(Math.max(0, i - 30), i + MULTI_CARD_WINDOW);
      if (cores.some((c) => window.includes(c))) return true;
      i = answer.indexOf(key, i + 1);
    }
  }
  return false;
}

/** 開頭幾句（跳過錯字確認句「你是指…嗎？以下以…回答」）。 */
function openingText(answer: string): string {
  const plain = answer.replace(/[*_#>`]/g, "").replace(/^\s*你是指[^？?]*[？?]\s*(以下以[^。，,\n]*回答[。，,]?)?/, "").trim();
  const sentences = plain.split(/(?<=[。！？!?\n])/).filter((s) => s.trim());
  return sentences.slice(0, 2).join("");
}

export const TRUNCATION_ISSUE_PREFIX = "回答沒有寫完";

/** 看起來被截斷：最後一個字不是句尾標點、括號或數字單位。 */
export function looksTruncated(answer: string): boolean {
  const t = answer.replace(/[*_\s]+$/g, "");
  if (t.length < 20) return false;
  return !/[。！？!?.)）」』%元張股】~～:：]$/.test(t);
}

/**
 * 回答後檢查（只檢查程式確定的事）：①單檔結論卡（＝買賣判斷題）時，開頭兩句要有結論字樣核心；②建議買進不可出現猶豫字眼；③截斷。
 * 回傳問題清單（空＝通過），文字會直接附給模型重生用。
 */
export function answerCardIssues(answer: string, grounding: string): string[] {
  const issues: string[] = [];
  const cards = parseDecisionCards(grounding);
  // 結論卡只在買賣判斷題才附（ask.ts tradeJudgment），有卡＝判斷題。
  if (cards.length === 1) {
    const core = coreOf(cards[0]);
    const opening = openingText(answer);
    if (core && !acceptedCores(core).some((a) => opening.includes(a))) issues.push(`第一句必須照抄結論「${cards[0].first}」（目前開頭沒有「${core}」）`);
    if (core === "建議買進") {
      const hit = answer.match(BUY_FORBIDDEN_PATTERN);
      if (hit) issues.push(`評等是建議買進（現價可分批買），不可寫「${hit[0]}」這類要等或觀望的字眼`);
    }
  }
  if (cards.length > 1) {
    // 比較題：每檔都要講到自己的結論（2026-10-06 試跑：只講選中那檔，另一檔的評等沒交代）。
    const missing = cards.filter((c) => !mentionsOwnRating(answer, c));
    if (missing.length > 0) issues.push(`每一檔都要寫出各自的本站結論：${missing.map((c) => c.first).join("；")}`);
  }
  if (looksTruncated(answer)) issues.push(`${TRUNCATION_ISSUE_PREFIX}（結尾被截斷），請完整寫完、精簡一點`);
  return issues;
}

/** 重生仍不合格時的程式版回答（只用結論卡的內容，不需要 AI）。 */
export function renderCardFallback(grounding: string): string | null {
  const cards = parseDecisionCards(grounding);
  if (cards.length === 0) return null;
  if (cards.length > 1) {
    const pick = grounding.split("\n").find((l) => l.startsWith(COMPARISON_PICK_TITLE));
    const head = pick ? `${pick.slice(COMPARISON_PICK_TITLE.length).split("。")[0]}。` : "";
    return [head, ...cards.map((c) => `${c.first}。支持：${c.support}；不支持：${c.against}。`)].filter(Boolean).join("\n");
  }
  const c = cards[0];
  const parts = [`${c.first}。`];
  if (c.confidence) parts.push(`${c.confidence}。`);
  if (c.support && c.support !== "（無）") parts.push(`支持的理由：${c.support}。`);
  if (c.against && c.against !== "（無）") parts.push(`不支持的地方：${c.against}。`);
  if (c.levels && c.levels !== "（無）") parts.push(`價位：${c.levels}。`);
  if (c.risk) parts.push(`主要風險：${c.risk}。`);
  return parts.join("\n").replace(/。。/g, "。");
}

/**
 * 錯字近似比對時（fuzzyName.ts describeFuzzyGuess），回答開頭一定要先確認「你是指X嗎？」——程式保證：
 * 模型沒寫就補在最前面（2026-10-06 試跑：有結論卡時模型直接照抄結論、漏了確認句）。
 */
export function ensureFuzzyConfirmation(answer: string, grounding: string): string {
  const m = grounding.match(/回答第一句必須寫「(你是指[^」]+)」/);
  if (!m || answer.includes("你是指")) return answer;
  return `${m[1]}。\n${answer}`;
}
