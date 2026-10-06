import { CARD_CONFIDENCE_PREFIX, DECISION_CARD_TITLE } from "./decisionCard";
import { WATCH_SUMMARY_TITLE } from "./holdingRating";

/**
 * 「本站把握程度」回答後保證（2026-10-06 四入口比較，docs/eval/2026-10-06-four-entries.md）：
 * 今日建議卡每檔都由程式印出把握程度，但直接提問／關注清單深度分析的 AI 回答幾乎不講（評測 0～25%），個股頁按鈕也只有 gemini 會講。
 * 把握程度是程式判定（siteRating.ratingConfidence），AI 照抄即可——所以跟 ensureMarginSignalMentioned 同一個做法：
 * 買賣判斷題（有結論卡）或關注清單深度分析（有【僅關注評等彙整】）裡，回答提到某檔建議買進卻沒講把握程度時，
 * 在回答最後補上程式寫好的一行（確定性、不重生）。已持有的股票不適用（持有建議不分把握程度）。
 */
export const CONFIDENCE_APPENDIX_TITLE = "把握程度（本站程式判定）";
/** 最多補幾檔（關注清單可能十幾檔，全補會稀釋重點）。 */
export const CONFIDENCE_APPENDIX_MAX = 8;
/** 回答裡提到該檔（名稱或代號）後 260 字內（到下一檔被提到為止）有「把握程度」就算已經講了。 */
const MENTION_WINDOW_AFTER = 260;

interface ConfidenceItem {
  name: string;
  symbol: string;
  /** 「本站把握程度：中（原因；回測…）」整句（程式字樣，siteRating.confidenceText） */
  text: string;
}

const RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：[^\n]*?(本站把握程度：(?:高|中|低)（[^）]*）)/g;

/** 從參考資料找出「該講把握程度」的股票：結論卡有把握程度行（未持有、建議買進）、或【僅關注評等彙整】列了把握程度的。 */
export function confidenceItemsFromGrounding(grounding: string): ConfidenceItem[] {
  const ratingText = new Map<string, ConfidenceItem>();
  for (const m of grounding.matchAll(RATING_LINE)) {
    const symbol = m[2].toUpperCase();
    if (!ratingText.has(symbol)) ratingText.set(symbol, { name: m[1].replace(/[*＊]/g, "").trim(), symbol, text: m[3] });
  }
  const applicable = new Set<string>();
  // ①結論卡：卡片有「把握程度（照抄）」行才適用（decisionCard.describeDecisionCard 只在未持有且建議買進時印）。
  for (const chunk of grounding.split(DECISION_CARD_TITLE).slice(1)) {
    const head = chunk.split("\n")[0].match(/\(([^)]+)\)\s*$/);
    if (head && chunk.includes(CARD_CONFIDENCE_PREFIX)) applicable.add(head[1].toUpperCase());
  }
  // ②關注清單深度分析：【僅關注評等彙整】每項「名稱(代號)「label」（本站把握程度：X）」。
  const w = grounding.indexOf(WATCH_SUMMARY_TITLE);
  if (w >= 0) {
    const line = grounding.slice(w).split("\n")[0];
    for (const m of line.matchAll(/\(([0-9A-Za-z.\-]+)\)「[^」]*」（本站把握程度：(?:高|中|低)）/g)) applicable.add(m[1].toUpperCase());
  }
  return [...applicable].map((s) => ratingText.get(s)).filter((x): x is ConfidenceItem => !!x);
}

function mentionsConfidenceNear(answer: string, item: ConfidenceItem, all: ConfidenceItem[]): boolean {
  for (const key of [item.name, item.symbol]) {
    if (key.length < 2) continue;
    for (let i = answer.indexOf(key); i >= 0; i = answer.indexOf(key, i + 1)) {
      // 視窗到下一個「別檔」被提到的位置為止，不會把別檔的把握程度算在這一檔頭上。
      let end = Math.min(answer.length, i + key.length + MENTION_WINDOW_AFTER);
      for (const o of all) {
        if (o.symbol === item.symbol) continue;
        for (const k of [o.name, o.symbol]) {
          const j = k.length >= 2 ? answer.indexOf(k, i + key.length) : -1;
          if (j >= 0 && j < end) end = j;
        }
      }
      if (answer.slice(i, end).includes("把握程度")) return true;
    }
  }
  return false;
}

function isMentioned(answer: string, item: ConfidenceItem): boolean {
  return answer.includes(item.symbol) || (item.name.length >= 2 && answer.includes(item.name));
}

/** 回答第一次提到該檔的位置（名稱或代號），沒有 -1。 */
function firstMention(answer: string, item: ConfidenceItem): number {
  const idx = [item.name, item.symbol].filter((k) => k.length >= 2).map((k) => answer.indexOf(k)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : -1;
}

/**
 * 該檔結論句（第一次提到後 200 字內、下一檔被提到之前的「建議買進（…）」）結尾可以插入把握程度的位置；
 * 結論後面不是句號／換行／結尾（句子還沒講完）就回 null，改用附在最後的做法。
 */
function conclusionInsertPoint(answer: string, item: ConfidenceItem, all: ConfidenceItem[]): { pos: number; text: string } | null {
  const first = firstMention(answer, item);
  if (first < 0) return null;
  let limit = Math.min(answer.length, first + 200);
  for (const o of all) {
    if (o.symbol === item.symbol) continue;
    for (const k of [o.name, o.symbol]) {
      const j = k.length >= 2 ? answer.indexOf(k, first + 1) : -1;
      if (j >= 0 && j < limit) limit = j;
    }
  }
  const at = answer.indexOf("建議買進", first);
  if (at < 0 || at >= limit) return null;
  let i = at + "建議買進".length;
  if (answer.startsWith("**", i)) i += 2;
  if (answer[i] === "（" || answer[i] === "(") {
    const close = answer.slice(i).search(/[）)]/);
    if (close < 0) return null;
    i += close + 1;
    if (answer.startsWith("**", i)) i += 2;
  }
  if (answer[i] === "。") return { pos: i + 1, text: `${item.text}。` };
  if (i >= answer.length || answer[i] === "\n") return { pos: i, text: `。${item.text}。` };
  return null;
}

export function ensureConfidenceMentioned(answer: string, grounding: string): { text: string; appended: string[] } {
  if (!answer || (!grounding.includes(CARD_CONFIDENCE_PREFIX) && !grounding.includes(WATCH_SUMMARY_TITLE))) return { text: answer, appended: [] };
  const items = confidenceItemsFromGrounding(grounding);
  const missing = items.filter((it) => isMentioned(answer, it) && !mentionsConfidenceNear(answer, it, items));
  if (missing.length === 0) return { text: answer, appended: [] };
  // 優先插在該檔結論句後面（讀起來跟今日建議卡「建議買進（…）。本站把握程度：中（…）。」一樣），插不進去的才附在最後。
  const inline: Array<{ pos: number; text: string }> = [];
  const rest: ConfidenceItem[] = [];
  for (const it of missing) {
    const pt = conclusionInsertPoint(answer, it, items);
    if (pt) inline.push(pt);
    else rest.push(it);
  }
  let text = answer;
  for (const pt of inline.sort((x, y) => y.pos - x.pos)) text = `${text.slice(0, pt.pos)}${pt.text}${text.slice(pt.pos)}`;
  const shown = rest.slice(0, CONFIDENCE_APPENDIX_MAX);
  if (shown.length > 0) text = `${text.replace(/\s+$/, "")}\n\n${CONFIDENCE_APPENDIX_TITLE}：\n${shown.map((x) => `- ${x.name}(${x.symbol})：${x.text}`).join("\n")}`;
  return { text, appended: missing.slice(0, CONFIDENCE_APPENDIX_MAX + inline.length).map((x) => x.symbol) };
}
