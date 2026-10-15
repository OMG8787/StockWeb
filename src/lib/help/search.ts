import { MANUAL, type ManualSection } from "./manual";

/**
 * 操作手冊搜尋（程式做、不靠 AI；純函式有測試 src/__tests__/helpSearch.test.ts）。
 *
 * 中文沒有空白分詞：把問題切成 2～4 字的片段（bigram／trigram），拆出英數字詞，
 * 比對章節的標題、關鍵字、摘要、內文，標題與關鍵字權重最高。教學助手用它挑出最相關的幾個章節再交給 AI 白話回答，
 * AI 失敗時直接顯示這些章節——所以「找對章節」這一步一定要穩，不能交給模型。
 */

const STOP = new Set(["怎麼", "如何", "什麼", "可以", "請問", "我要", "我想", "要怎麼", "怎樣", "是什麼", "為什麼", "為何", "有沒有", "可不可以", "能不能", "一下", "功能", "使用", "操作", "教我", "告訴我", "的話", "還是"]);

/** 一個問題的搜尋詞（小寫、去重、去掉太泛的詞） */
export function queryTerms(q: string): string[] {
  const text = q.toLowerCase().replace(/[，。！？、；：「」（）()\[\]【】,.!?;:"'\s]+/g, " ").trim();
  const terms = new Set<string>();
  for (const word of text.split(" ")) {
    if (!word) continue;
    if (/^[a-z0-9+*＊#._-]+$/.test(word)) {
      if (word.length >= 2) terms.add(word);
      continue;
    }
    // 中文（可能夾雜英數）：英數連續片段單獨成詞，其餘切 2～4 字片段
    for (const m of word.match(/[a-z0-9]{2,}/g) ?? []) terms.add(m);
    const cjk = word.replace(/[a-z0-9]+/g, " ");
    for (const run of cjk.split(" ")) {
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n));
      }
    }
  }
  return [...terms].filter((t) => !STOP.has(t));
}

interface Scored {
  section: ManualSection;
  score: number;
}

function scoreSection(s: ManualSection, terms: string[]): number {
  const title = s.title.toLowerCase();
  const keywords = s.keywords.map((k) => k.toLowerCase());
  const summary = s.summary.toLowerCase();
  const body = s.body.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const w = Math.min(4, t.length); // 長片段比短片段可信
    if (title.includes(t)) score += 6 * w;
    if (keywords.some((k) => k.includes(t) || (k.length >= 2 && t.includes(k)))) score += 5 * w;
    if (summary.includes(t)) score += 2 * w;
    if (body.includes(t)) score += 1 * w;
  }
  return score;
}

/** 依問題找最相關的章節（分數高到低；沒有任何命中回空陣列）。minScore 擋掉只靠單字巧合的命中。 */
export function searchManual(query: string, topN = 3, sections: ManualSection[] = MANUAL): ManualSection[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: Scored[] = sections.map((section) => ({ section, score: scoreSection(section, terms) })).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id));
  if (scored.length === 0) return [];
  // 第一名的 35% 以下視為雜訊（長問題會讓很多章節零星命中）
  const floor = scored[0].score * 0.35;
  return scored.filter((x) => x.score >= floor && x.score >= 8).slice(0, topN).map((x) => x.section);
}

/** 手冊頁搜尋框：標題／關鍵字／內文任一包含輸入字串（不分詞，直接找字） */
export function filterManual(query: string, sections: ManualSection[] = MANUAL): ManualSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const hits = sections.filter((s) => `${s.title} ${s.keywords.join(" ")} ${s.summary} ${s.body}`.toLowerCase().includes(q));
  return hits.length ? hits : searchManual(q, 5, sections);
}
