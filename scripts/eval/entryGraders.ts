// 四入口比較（entries.ts）的逐檔評分器：純函式、無 I/O。
// 同一檔股票在四個入口（今日建議卡／關注清單深度分析／個股頁按鈕／直接提問）的「該檔那一段文字」用同一套規則評分，
// 規則沿用 graders.ts（第一句照抄評等、關鍵價位照抄、無內部標記…），另加四入口共通的「講清楚做法／風險／把握程度」。
import { extractKeyLevels, guardAnswerNumbers } from "@/lib/ai/numberGuard";
import { MARGIN_SIGNAL_TITLE } from "@/lib/ai/marginSignalData";
import { BUY_FORBIDDEN_PATTERN } from "@/lib/ai/decisionCard";
import { coreLabel, firstSentences, mentionedSymbols, parseProgramRatings, plain } from "./graders";
import type { CheckResult } from "./types";

export interface EntryStock {
  symbol: string;
  name: string;
}

export interface EntryGradeInput {
  stock: EntryStock;
  /** 這一檔在該入口的最終文字（使用者實際看到的那一段） */
  text: string;
  /** 模型原始輸出（今日建議卡沒有；用 text） */
  raw?: string;
  /** 繁中轉換修了幾個字（整則回答） */
  zhFixedCount: number;
  /** 該檔的個股參考資料（含【本站綜合評等】行、價位參考）——同一檔四入口用同一份比對 */
  grounding: string;
  /** 回答裡允許出現的股票代號（單檔入口＝那一檔；關注清單＝整批） */
  allowedSymbols: string[];
}

const ENGLISH_SENTENCE = /(?:\b[A-Za-z][a-z']+\b[\s,]+){5,}\b[A-Za-z][a-z']+/;
const INTERNAL_MARKERS = /【內部|非使用者可見|禁止原樣|內部系統標記|未持有[：:]\s*「|已持有[：:]\s*「|參考資料(顯示|中|裡)/;
/** 先不要買時不可出現的買進價位／出場價／加碼寫法。 */
const AVOID_FORBIDDEN_PRICE = /拉回到\s*[\d.]+\s*附近可加碼|加碼參考價|跌破\s*[\d.,]+\s*(元)?\s*(建議)?出場|買進區間|分批買進/;
const RISK_WORDS = /風險|留意|小心|注意|回檔|跌破|不確定|波動|過熱|追高|轉弱/;
const ACTION_WORDS_BUY = /分批|可買|可以買|加碼|買進後|開盤|盤中/;
const ACTION_WORDS_AVOID = /改判|轉為建議買進|條件|等到|再評估|不要買|不建議/;

/** 從該檔評等行讀出程式的把握程度（高／中／低）；沒有＝null。 */
export function programConfidence(grounding: string, symbol: string): string | null {
  const line = grounding.split("\n").find((l) => l.includes("【本站綜合評等】") && l.includes(`(${symbol})`));
  return line?.match(/本站把握程度：(高|中|低)/)?.[1] ?? null;
}

/** 先不要買的改判條件原文（評等行「改判建議買進的條件：X（」）。 */
export function upgradeConditionOf(grounding: string, symbol: string): string | null {
  const line = grounding.split("\n").find((l) => l.includes("【本站綜合評等】") && l.includes(`(${symbol})`));
  return line?.match(/改判建議買進的條件：([^（\n]+)/)?.[1]?.trim() ?? null;
}

export function gradeEntryStock(g: EntryGradeInput): CheckResult[] {
  const out: CheckResult[] = [];
  const text = g.text;
  const raw = g.raw ?? g.text;
  const rating = parseProgramRatings(g.grounding).get(g.stock.symbol.toUpperCase());
  const isAvoid = !!rating && coreLabel(rating.unheld).includes("不要買");

  out.push({ rule: "繁中（無簡體／日文字）", pass: g.zhFixedCount === 0, detail: g.zhFixedCount ? `轉換了 ${g.zhFixedCount} 個字` : undefined });
  const eng = raw.match(ENGLISH_SENTENCE);
  out.push({ rule: "無英文句子", pass: !eng, detail: eng?.[0].slice(0, 60) });
  const leak = raw.match(INTERNAL_MARKERS);
  out.push({ rule: "無內部標記外洩", pass: !leak, detail: leak?.[0] });

  if (!rating) {
    out.push({ rule: "結論照抄本站評等", pass: false, detail: "參考資料沒有該檔評等" });
  } else {
    const label = coreLabel(rating.unheld);
    // 單一入口的該檔文字，前兩句（含名稱那句）要有評等字樣；「建議先不要買」也接受「先不要買」。
    const head = firstSentences(text, 2);
    const ok = head.includes(label) || (label.startsWith("建議") && head.includes(label.slice(2)));
    out.push({ rule: "結論照抄本站評等", pass: ok, detail: ok ? undefined : `應含「${label}」，開頭：${head.slice(0, 70)}` });
  }

  if (extractKeyLevels(g.grounding).levels.length > 0) {
    const { fixes } = guardAnswerNumbers(text, g.grounding);
    out.push({ rule: "關鍵價位照抄程式值", pass: fixes.length === 0, detail: fixes.length ? fixes.map((f) => `${f.from}→${f.to}`).join("、") : undefined });
  }

  if (isAvoid) {
    const hit = text.match(AVOID_FORBIDDEN_PRICE);
    out.push({ rule: "先不要買不給買進／出場價", pass: !hit, detail: hit?.[0] });
  } else {
    const hit = text.match(BUY_FORBIDDEN_PATTERN);
    out.push({ rule: "建議買進不說等回檔／觀望", pass: !hit, detail: hit?.[0] });
  }

  const allowed = new Set([...g.allowedSymbols.map((s) => s.toUpperCase()), "0050"]);
  const extra = mentionedSymbols(text).filter((c) => !allowed.has(c));
  out.push({ rule: "不扯無關個股", pass: extra.length === 0, detail: extra.join("、") || undefined });

  // 把握程度（只有建議買進才有）：要講出來，且等級跟程式一致。
  const conf = programConfidence(g.grounding, g.stock.symbol);
  if (!isAvoid && conf) {
    const m = text.match(/把握程度[：:為是]{0,2}\s*(高|中|低)/);
    out.push({ rule: "把握程度照程式", pass: m?.[1] === conf, detail: m ? (m[1] === conf ? undefined : `程式「${conf}」回答「${m[1]}」`) : `沒講把握程度（程式：${conf}）` });
  }

  // 融資融券組合判讀：該檔有非中性訊號就要講出名稱。
  const sig = g.grounding.match(new RegExp(`${MARGIN_SIGNAL_TITLE}（[^）]*）：【([^】]+)】`));
  if (sig) out.push({ rule: "講出融資融券組合判讀", pass: plain(text).includes(sig[1]), detail: plain(text).includes(sig[1]) ? undefined : `應提到「${sig[1]}」` });

  // 做法與風險：每個入口都該讓人知道「怎麼做」「最大風險」。
  out.push({ rule: "講清楚怎麼做", pass: (isAvoid ? ACTION_WORDS_AVOID : ACTION_WORDS_BUY).test(text) });
  out.push({ rule: "講出風險", pass: RISK_WORDS.test(text) });
  if (isAvoid) {
    const cond = upgradeConditionOf(g.grounding, g.stock.symbol);
    if (cond) {
      const key = cond.replace(/\s/g, "").slice(0, 6);
      out.push({ rule: "先不要買講出改判條件", pass: plain(text).replace(/\s/g, "").includes(key), detail: `應提到「${cond.slice(0, 30)}」` });
    }
  }
  // 理由要帶數字：至少 2 個含數字的片段（數字＋單位／百分比／倍數／張）。
  const numbered = (plain(text).match(/\d[\d,.]*\s*(?:%|張|倍|元|億|萬|日|天|分|點)/g) ?? []).length;
  out.push({ rule: "理由帶至少 2 個具體數字", pass: numbered >= 2, detail: `${numbered} 個` });
  return out;
}

// ---------------------------------------------------------------- 取出「某一檔那一段」

/** 關注清單深度分析：回答依每檔粗體小標分段；取出指定股票那一段（到下一檔小標或總結段為止）。 */
export function extractStockSegment(answer: string, stocks: EntryStock[], symbol: string): string {
  const posOf = (s: EntryStock) => {
    const keys = [`${s.name}(${s.symbol})`, `${s.name}（${s.symbol}）`, `${s.name} (${s.symbol})`, s.name, s.symbol];
    const idx = keys.map((k) => answer.indexOf(k)).filter((i) => i >= 0);
    return idx.length ? Math.min(...idx) : -1;
  };
  const me = stocks.find((s) => s.symbol === symbol);
  if (!me) return "";
  const start = posOf(me);
  if (start < 0) return "";
  let end = answer.length;
  for (const s of stocks) {
    if (s.symbol === symbol) continue;
    const p = posOf(s);
    if (p > start && p < end) end = p;
  }
  let seg = answer.slice(start, end);
  // 每檔是「小標＋緊接的內容」，遇到第一個空行就結束（之後是總結段、程式附的融資融券說明等，不屬於這一檔）；
  // 小標那行本身不算內容，所以至少要先有一行正文才切。
  const firstBreak = seg.search(/\n\s*\n/);
  const headEnd = seg.indexOf("\n");
  if (firstBreak > 0 && headEnd >= 0 && firstBreak > headEnd) seg = seg.slice(0, firstBreak);
  // 程式附在整則回答最後的「融資融券組合判讀」說明，若有這一檔的那一行，併入這一檔（③④也都含這段，才公平）。
  const sup = answer.split("\n").find((l) => /^\s*[-•]\s*/.test(l) && l.includes(`(${symbol})`) && l.includes("【") && l.includes("依據"));
  if (sup && !seg.includes(sup.trim())) seg = `${seg.trim()}\n${sup.trim()}`;
  seg = seg.replace(/\*\*/g, "");
  return seg.trim();
}

/** 今日建議卡：取出該檔那一行「- **名稱(代號)**：…」。 */
export function extractCardLine(cardText: string, symbol: string): string {
  const line = cardText.split("\n").find((l) => l.startsWith("- ") && l.includes(`(${symbol})`));
  return line ? line.replace(/^-\s*/, "").replace(/\*\*/g, "") : "";
}

