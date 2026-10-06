import { CARD_CONFIDENCE_PREFIX, DECISION_CARD_TITLE } from "./decisionCard";
import { WATCH_SUMMARY_TITLE } from "./holdingRating";
import { parseLiveQuotes, type LiveQuoteEntry } from "./livePrice";

/**
 * 「每檔該講的程式事實」回答後保證（唯一入口 ensureStockFactsMentioned，ask.ts postProcessAiAnswer 呼叫；跨模型評測同一路徑）。
 * 2026-10-06 四入口比較（docs/eval/2026-10-06-four-entries.md）：今日建議卡每檔都由程式印出把握程度，但直接提問／關注清單深度分析
 * 的 AI 回答幾乎不講（評測 0～25%）；2026-10-07 使用者再要求四入口出現的每一檔股票都要顯示當前現價。兩件事都是程式判定／即時報價、
 * AI 照抄即可，所以跟 ensureMarginSignalMentioned 同一個做法——回答提到某檔卻沒講時，由程式寫好的字樣補進去（確定性、不重生）：
 * - 現價（livePrice.ts 的即時報價行）：買賣判斷題（有結論卡）或關注清單深度分析的每一檔都要有，先不要買、持有中也要。
 * - 把握程度：只有未持有且建議買進的（結論卡有把握程度行、或【僅關注評等彙整】列了把握程度的）。
 * 優先插在該檔「結論句」後面（讀起來跟今日建議卡「建議買進（…）。現價 234（+6.4%，13:31）。本站把握程度：中（…）。」一樣），
 * 插不進去（結論後面句子還沒講完、或找不到結論）才附在回答最後。
 */
export const FACTS_APPENDIX_TITLE = "現價與把握程度（本站程式判定）";
/** 最多補幾檔（關注清單可能十幾檔，全補會稀釋重點）。 */
export const FACTS_APPENDIX_MAX = 8;
/** 回答裡提到該檔後這麼多字內（到下一檔被提到為止）算「在講這一檔」。 */
const MENTION_WINDOW_AFTER = 260;
/** 結論句要在第一次提到後這麼多字內。 */
const CONCLUSION_WINDOW = 200;

interface StockFacts {
  name: string;
  symbol: string;
  /** 結論字樣核心（未持有／已持有各一，找結論句用），例如「建議買進」「建議先不要買」「續抱」 */
  cores: string[];
  /** 現價片段「現價 234（+6.4%，13:31）」；這一檔不需要（或沒有即時報價）就 undefined */
  price?: LiveQuoteEntry;
  /** 「本站把握程度：中（…）」整句；不適用 undefined */
  confidence?: string;
}

const RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：未持有：「([^」]*)」／已持有：「([^」]*)」/g;
const CONFIDENCE_IN_LINE = /本站把握程度：(?:高|中|低)（[^）]*）/;

const coreOf = (label: string) => label.split(/[（(]/)[0].trim();

function coresOf(unheld: string, held: string): string[] {
  const out = new Set<string>();
  for (const l of [unheld, held]) {
    const c = coreOf(l);
    if (!c) continue;
    out.add(c);
    if (c.startsWith("建議")) out.add(c.slice(2));
  }
  // 長的先找（「建議買進」比「買進」精準）
  return [...out].sort((a, b) => b.length - a.length);
}

/** 參考資料是「買賣判斷題」還是「關注清單深度分析」——只有這兩種才要求每檔現價。 */
function priceApplicableSymbols(grounding: string, all: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const chunk of grounding.split(DECISION_CARD_TITLE).slice(1)) {
    const head = chunk.split("\n")[0].match(/\(([^)]+)\)\s*$/);
    if (head) out.add(head[1].toUpperCase());
  }
  // 關注清單深度分析：個股區塊都有「狀態：持有中／僅關注／已賣出」行
  if (/^狀態：(持有中|僅關注|已賣出)/m.test(grounding) || grounding.includes(WATCH_SUMMARY_TITLE)) for (const s of all) out.add(s);
  return out;
}

/** 從參考資料找出每檔該講的事實。 */
export function stockFactsFromGrounding(grounding: string): StockFacts[] {
  const live = parseLiveQuotes(grounding);
  const ratings = new Map<string, { name: string; cores: string[]; confidence?: string }>();
  for (const m of grounding.matchAll(RATING_LINE)) {
    const symbol = m[2].toUpperCase();
    if (ratings.has(symbol)) continue;
    const lineEnd = grounding.indexOf("\n", m.index ?? 0);
    const line = grounding.slice(m.index ?? 0, lineEnd < 0 ? undefined : lineEnd);
    ratings.set(symbol, { name: m[1].replace(/[*＊]/g, "").trim(), cores: coresOf(m[3], m[4]), confidence: line.match(CONFIDENCE_IN_LINE)?.[0] });
  }
  // 把握程度適用：結論卡有把握程度行、或【僅關注評等彙整】列了把握程度。
  const confApplicable = new Set<string>();
  for (const chunk of grounding.split(DECISION_CARD_TITLE).slice(1)) {
    const head = chunk.split("\n")[0].match(/\(([^)]+)\)\s*$/);
    if (head && chunk.includes(CARD_CONFIDENCE_PREFIX)) confApplicable.add(head[1].toUpperCase());
  }
  const w = grounding.indexOf(WATCH_SUMMARY_TITLE);
  if (w >= 0) {
    const line = grounding.slice(w).split("\n")[0];
    for (const m of line.matchAll(/\(([0-9A-Za-z.\-]+)\)「[^」]*」（本站把握程度：(?:高|中|低)）/g)) confApplicable.add(m[1].toUpperCase());
  }
  const priceApplicable = priceApplicableSymbols(grounding, new Set(live.keys()));
  const symbols = new Set<string>([...ratings.keys(), ...live.keys()]);
  const out: StockFacts[] = [];
  for (const symbol of symbols) {
    const r = ratings.get(symbol);
    const l = live.get(symbol);
    const name = (l?.name ?? r?.name ?? symbol).replace(/[*＊]/g, "");
    const price = l && priceApplicable.has(symbol) ? l : undefined;
    const confidence = r?.confidence && confApplicable.has(symbol) ? r.confidence : undefined;
    if (!price && !confidence) continue;
    out.push({ name, symbol, cores: r?.cores ?? [], price, confidence });
  }
  return out;
}

function firstMention(answer: string, f: StockFacts): number {
  const idx = [f.name, f.symbol].filter((k) => k.length >= 2).map((k) => answer.indexOf(k)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : -1;
}

/** 從第一次提到這一檔開始，到「下一檔被提到」或最多 maxLen 字為止的範圍結尾。 */
function windowEnd(answer: string, f: StockFacts, all: StockFacts[], from: number, maxLen: number): number {
  let end = Math.min(answer.length, from + maxLen);
  for (const o of all) {
    if (o.symbol === f.symbol) continue;
    for (const k of [o.name, o.symbol]) {
      const j = k.length >= 2 ? answer.indexOf(k, from + 1) : -1;
      if (j >= 0 && j < end) end = j;
    }
  }
  return end;
}

/** 回答裡該檔附近（任一次提到後到下一檔被提到為止）有沒有這段文字。 */
function mentionsNear(answer: string, f: StockFacts, all: StockFacts[], needle: string): boolean {
  for (const key of [f.name, f.symbol]) {
    if (key.length < 2) continue;
    for (let i = answer.indexOf(key); i >= 0; i = answer.indexOf(key, i + 1)) {
      if (answer.slice(i, windowEnd(answer, f, all, i + key.length - 1, MENTION_WINDOW_AFTER + key.length)).includes(needle)) return true;
    }
  }
  return false;
}

/**
 * 該檔結論句結尾可以插入的位置（結論字樣後可跟「（…）」，後面是句號、換行或結尾）；
 * 結論後面句子還沒講完或找不到結論回 null。
 */
function conclusionEnd(answer: string, f: StockFacts, all: StockFacts[]): { pos: number; period: boolean } | null {
  const first = firstMention(answer, f);
  if (first < 0) return null;
  const limit = windowEnd(answer, f, all, first, CONCLUSION_WINDOW);
  let at = -1;
  let coreLen = 0;
  for (const c of f.cores) {
    const j = answer.indexOf(c, first);
    if (j >= 0 && j < limit && (at < 0 || j < at)) {
      at = j;
      coreLen = c.length;
    }
  }
  if (at < 0) return null;
  let i = at + coreLen;
  if (answer.startsWith("**", i)) i += 2;
  if (answer[i] === "（" || answer[i] === "(") {
    const close = answer.slice(i).search(/[）)]/);
    if (close < 0) return null;
    i += close + 1;
    if (answer.startsWith("**", i)) i += 2;
  }
  if (answer[i] === "。") return { pos: i + 1, period: true };
  // 結論後面只剩行尾空白（Markdown 換行常見的兩個空白）也算句尾；插在空白前面，保留原本的換行效果。
  let j = i;
  while (answer[j] === " " || answer[j] === "\t" || answer[j] === "　") j++;
  if (j >= answer.length || answer[j] === "\n") return { pos: i, period: false };
  return null;
}

export function ensureStockFactsMentioned(answer: string, grounding: string): { text: string; appended: string[] } {
  if (!answer) return { text: answer, appended: [] };
  const facts = stockFactsFromGrounding(grounding);
  if (facts.length === 0) return { text: answer, appended: [] };
  const todo: Array<{ f: StockFacts; parts: string[] }> = [];
  for (const f of facts) {
    if (firstMention(answer, f) < 0) continue;
    const parts: string[] = [];
    if (f.price && !mentionsNear(answer, f, facts, f.price.text)) parts.push(f.price.text);
    if (f.confidence && !mentionsNear(answer, f, facts, "把握程度")) parts.push(f.confidence);
    if (parts.length > 0) todo.push({ f, parts });
  }
  if (todo.length === 0) return { text: answer, appended: [] };
  const inline: Array<{ pos: number; text: string }> = [];
  const rest: typeof todo = [];
  for (const t of todo) {
    const end = conclusionEnd(answer, t.f, facts);
    if (end) inline.push({ pos: end.pos, text: `${end.period ? "" : "。"}${t.parts.join("。")}。` });
    else rest.push(t);
  }
  let text = answer;
  for (const ins of inline.sort((x, y) => y.pos - x.pos)) text = `${text.slice(0, ins.pos)}${ins.text}${text.slice(ins.pos)}`;
  const shown = rest.slice(0, FACTS_APPENDIX_MAX);
  if (shown.length > 0)
    text = `${text.replace(/\s+$/, "")}\n\n${FACTS_APPENDIX_TITLE}：\n${shown.map((t) => `- ${t.f.name}(${t.f.symbol})：${t.parts.join("；")}`).join("\n")}`;
  return { text, appended: todo.map((t) => t.f.symbol) };
}
