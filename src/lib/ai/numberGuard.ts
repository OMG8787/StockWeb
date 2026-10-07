/**
 * 回答後的「關鍵價位」檢查（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 正式站：AI 把聯電的停損價抄成「14.85」（程式給的值正確），光靠提示詞要求「照抄數字」擋不住。
 * 做法：從這次附給 AI 的參考資料（評等行、【價位參考】、【持有中出場參考】——全部是程式產生、格式固定）
 * 取出每檔的關鍵價位，再掃描回答裡「跌破／停損／停利／出場／區間／不追／掛單／回到」後面的數字：
 *
 * - 數字本身出現在參考資料裡（任何非百分比的數字）→ 不動（可能是均線、成本、52 週高低等真實數字）。
 * - 等於某個程式價位 → 不動。
 * - 是程式價位的 ×10／÷10／×100／÷100（小數點位移）→ 改成程式價位。
 * - 跟該檔所有程式價位差距都 > MISMATCH_REL（30%）→ 依關鍵字種類（停損類／不追價／區間）改成同類最接近的程式價位。
 * - 其餘（差距 30% 內，例如掛單取區間中間價）→ 不動。
 *
 * 選擇「自動更正為程式值」而不是「重新請 AI 生成一次」的理由：程式價位本來就是唯一正確來源，更正是確定性的；
 * 重新生成要多花一次免費額度（專案零花費原則、Gemini 每分鐘限流）與 10～20 秒延遲，而且重生成仍可能再抄錯。
 */

export type LevelKind = "zone" | "exit" | "noChase";

export interface KeyLevel {
  /** 這個價位屬於哪一檔（參考資料第一個評等行之前的價位為 null） */
  symbol: string | null;
  kind: LevelKind;
  value: number;
}

export interface NumberFix {
  from: string;
  to: string;
  symbol: string | null;
  reason: "decimal-shift" | "mismatch";
}

/** 跟所有程式價位差距超過這個比例，視為「明顯不符」。 */
export const MISMATCH_REL = 0.3;
/** 關鍵字後面往後看幾個字找數字（遇到句讀就停）。 */
const KEYWORD_WINDOW = 18;

const NUM_SRC = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const RATING_ANCHOR = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：/g;

const parseNum = (s: string) => Number(s.replace(/,/g, ""));
const approx = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 0.002);
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** 從參考資料取出每檔的關鍵價位與「名稱／代號 → 代號」對照。 */
export function extractKeyLevels(grounding: string): { levels: KeyLevel[]; names: Map<string, string> } {
  const anchors: Array<{ index: number; name: string; symbol: string }> = [];
  for (const m of grounding.matchAll(RATING_ANCHOR)) {
    anchors.push({ index: m.index ?? 0, name: m[1].trim(), symbol: m[2].toUpperCase() });
  }
  const names = new Map<string, string>();
  for (const a of anchors) {
    names.set(a.symbol, a.symbol);
    if (a.name.length >= 2) names.set(a.name, a.symbol);
  }
  const segments: Array<{ symbol: string | null; text: string }> = [];
  segments.push({ symbol: null, text: grounding.slice(0, anchors[0]?.index ?? grounding.length) });
  anchors.forEach((a, i) => segments.push({ symbol: a.symbol, text: grounding.slice(a.index, anchors[i + 1]?.index ?? grounding.length) }));

  const levels: KeyLevel[] = [];
  const push = (symbol: string | null, kind: LevelKind, raw: string | undefined) => {
    if (!raw) return;
    const value = parseNum(raw);
    if (value > 0 && !levels.some((l) => l.symbol === symbol && l.kind === kind && approx(l.value, value))) levels.push({ symbol, kind, value });
  };
  for (const seg of segments) {
    for (const m of seg.text.matchAll(new RegExp(String.raw`(?:買進區間|下方支撐|支撐區|回到)\s*(${NUM_SRC})\s*[～~至到\-]\s*(${NUM_SRC})`, "g"))) {
      push(seg.symbol, "zone", m[1]);
      push(seg.symbol, "zone", m[2]);
    }
    for (const m of seg.text.matchAll(new RegExp(String.raw`(?:拉回加碼參考價|拉回到)\s*(${NUM_SRC})`, "g"))) push(seg.symbol, "zone", m[1]);
    for (const m of seg.text.matchAll(new RegExp(String.raw`(?:跌破|停損價|移動停利價|出場參考價)\s*(${NUM_SRC})`, "g"))) push(seg.symbol, "exit", m[1]);
    for (const m of seg.text.matchAll(new RegExp(String.raw`高於\s*(${NUM_SRC})\s*不追|漲過\s*(${NUM_SRC})`, "g"))) push(seg.symbol, "noChase", m[1] ?? m[2]);
  }
  return { levels, names };
}

/** 參考資料裡出現過的所有非百分比數字（回答引用這些不算抄錯）。 */
export function groundingNumberSet(grounding: string): number[] {
  const out: number[] = [];
  for (const m of grounding.matchAll(new RegExp(`(${NUM_SRC})(?!\\s*%)(?![\\d.,])`, "g"))) out.push(parseNum(m[1]));
  return out;
}

function kindOfKeyword(k: string): LevelKind | null {
  if (/跌破|停損|停利|出場/.test(k)) return "exit";
  if (/不追/.test(k)) return "noChase";
  if (/區間|掛單|回到|回檔到|加碼/.test(k)) return "zone";
  return null;
}

const KEYWORD_RE = /跌破|停損|停利|出場|區間|不追|掛單|回檔到|回到|加碼/g;
const UNIT_AFTER = /^\s*(?:%|％|張|倍|日|天|個|年|月|季|檔|筆|週|次|成|億|萬|股|分)/;

/** 回答中這個位置之前最後提到的是哪一檔。 */
function stockAt(answer: string, pos: number, names: Map<string, string>): string | null {
  let best = -1;
  let sym: string | null = null;
  const head = answer.slice(0, pos);
  for (const [key, s] of names) {
    const i = head.lastIndexOf(key);
    if (i > best) {
      best = i;
      sym = s;
    }
  }
  return sym;
}

/**
 * 檢查並更正回答裡的關鍵價位。參考資料裡沒有任何程式價位時原樣回傳。
 */
export function guardAnswerNumbers(answer: string, grounding: string): { text: string; fixes: NumberFix[] } {
  const { levels, names } = extractKeyLevels(grounding);
  if (levels.length === 0 || !answer) return { text: answer, fixes: [] };
  const known = groundingNumberSet(grounding);
  const symbolCodes = new Set([...names.values()]);
  const edits = new Map<number, { end: number; to: string; fix: NumberFix }>();

  for (const km of answer.matchAll(KEYWORD_RE)) {
    const start = (km.index ?? 0) + km[0].length;
    const windowText = answer.slice(start, start + KEYWORD_WINDOW).split(/[。；;\n！？]/)[0];
    for (const nm of windowText.matchAll(new RegExp(NUM_SRC, "g"))) {
      const raw = nm[0];
      const at = start + (nm.index ?? 0);
      if (edits.has(at)) continue;
      const before = answer[at - 1] ?? "";
      const after = answer.slice(at + raw.length);
      if (/[A-Za-z/\d.]/.test(before) || /^[/\d]/.test(after) || UNIT_AFTER.test(after)) continue;
      if (symbolCodes.has(raw)) continue;
      const n = parseNum(raw);
      if (!(n > 0)) continue;
      if (known.some((k) => approx(k, n))) continue;
      const sym = stockAt(answer, km.index ?? 0, names);
      const own = levels.filter((l) => l.symbol === sym);
      const cands = own.length > 0 ? own : levels;
      if (cands.some((c) => approx(c.value, n))) continue;
      const shifted = cands.find((c) => [10, 0.1, 100, 0.01].some((f) => approx(n * f, c.value)));
      if (shifted) {
        edits.set(at, { end: at + raw.length, to: fmt(shifted.value), fix: { from: raw, to: fmt(shifted.value), symbol: sym, reason: "decimal-shift" } });
        continue;
      }
      const minRel = Math.min(...cands.map((c) => Math.abs(n - c.value) / c.value));
      if (minRel <= MISMATCH_REL) continue;
      const kind = kindOfKeyword(km[0]);
      const sameKind = cands.filter((c) => c.kind === kind);
      const pool = sameKind.length > 0 ? sameKind : cands;
      const nearest = pool.reduce((a, b) => (Math.abs(b.value - n) < Math.abs(a.value - n) ? b : a));
      edits.set(at, { end: at + raw.length, to: fmt(nearest.value), fix: { from: raw, to: fmt(nearest.value), symbol: sym, reason: "mismatch" } });
    }
  }
  if (edits.size === 0) return { text: answer, fixes: [] };
  let text = answer;
  const sorted = [...edits.entries()].sort((a, b) => b[0] - a[0]);
  for (const [at, e] of sorted) text = text.slice(0, at) + e.to + text.slice(e.end);
  return { text, fixes: sorted.reverse().map(([, e]) => e.fix) };
}

// ---------------------------------------------------------------- 編造股價／指數防線（2026-10-07 開放題）
//
// 2026-10-07 02:15 使用者📝（NVIDIA）：問「有看起來抗壓性強且有上漲趨勢的股票嗎？」，回答寫「台積電參考價約600元」
// 「台光電120元」——實際約 2,570 與 5,900，參考資料裡根本沒有這兩個價格。guardAnswerNumbers 只更正「程式價位」
// （評等行／價位參考裡有的），參考資料沒有個股價位時完全不檢查，模型用記憶補的價格就直接送到使用者面前。
// 這裡補一條「回答裡的股價／指數點數必須出自參考資料」的檢查（唯一入口；ask.ts finalizeAiAnswer 用它決定重生或刪句，
// 評測 graders 用同一個函式評分）：
// - 「價格」＝後面接「元／點／美元」，或前面緊接價格字眼（現價、股價、收盤、參考價、停損、跌破、站上…）的數字；
//   前面是漲跌／差距字眼（漲、跌、差、多、少…）的是變動量，不算價格。
// - 這個價格寫在某檔名稱／代號之後（同一句），而那一檔根本不在參考資料裡 → 一定是編的。
// - 否則跟參考資料裡任一個「不帶單位」的數字差距在 UNGROUNDED_PRICE_TOLERANCE 內就算有出處（容許「約 2,570」這種四捨五入）。

export interface UngroundedPrice {
  /** 回答裡的原字串（數字本身） */
  raw: string;
  /** 所在句子（刪句用） */
  sentence: string;
  /** 歸屬的個股代號（同一句有提到時） */
  symbol: string | null;
  reason: "stock-not-in-grounding" | "number-not-in-grounding";
}

/** 跟參考資料數字的相對差距容許值（四捨五入、「約」）。 */
export const UNGROUNDED_PRICE_TOLERANCE = 0.012;
const PRICE_CUE_BEFORE =
  /(現價|股價|收盤價?|收在|參考價|價格|報價|成交價|目標價|停損價?|停利價?|出場價?|買進價|進場價|加碼價?|支撐|壓力|跌破|站上|突破|跌到|漲到|來到|回到|回測|拉回到?|下探|上看|最新價|指數|夜盤|點位)\s*(?:約|大約|約為|為|在|是|於|到|至|：|:)?\s*(?:約)?\s*$/;
const CHANGE_CUE_BEFORE = /(漲|跌|差|增加|減少|多|少|上升|下降|價差|獲利|虧損|賺|賠|高出|低了|相差|距離|落後|領先|共|合計|買超|賣超)\s*(?:了|約|近|逾|超過|達|約為)?\s*$/;
const PRICE_UNIT_AFTER = /^\s*(?:美元|元|點)/;
const NON_PRICE_UNIT_AFTER = /^\s*(?:%|％|張|倍|日|天|個|年|月|季|檔|筆|週|周|次|成|億|萬|千|股|分|項|名|家|檔|兆|位|歲|小時|分鐘|秒|bp|基點)/;
const STOCK_REF = /([一-鿿A-Za-z0-9&.\-*＊]{1,20}?)[（(]\s*([0-9]{4,6}[A-Z]?|[A-Z]{1,5})\s*[)）]/g;
const SENTENCE_SPLIT = /[。！？!?\n；;]/;
/** 括號裡是常見縮寫、不是股票代號（「每股盈餘（EPS）」）。 */
const NOT_TICKER = new Set(["EPS", "RSI", "KD", "MACD", "ETF", "PE", "PB", "VIX", "AI", "YOY", "MOM", "ROE", "GDP", "CPI", "PMI", "FED", "DIF", "MA", "USD", "TWD", "ADR", "OK", "K", "D", "PER", "PBR"]);
/** 明講是假設／舉例的句子（名詞題用假設數字舉例是允許的，見 RULE_GENERAL_KNOWLEDGE）。 */
const HYPOTHETICAL = /假設|舉例|舉個例|例如某|比如某|若某|如果某|某公司|某檔|某支/;

/** 參考資料裡「不帶非價格單位」的數字（張、%、億…之類的數量不算價格出處）。 */
function groundingPriceNumbers(grounding: string): number[] {
  const out: number[] = [];
  for (const m of grounding.matchAll(new RegExp(NUM_SRC, "g"))) {
    const at = m.index ?? 0;
    const before = grounding[at - 1] ?? "";
    if (/[\d.,]/.test(before)) continue;
    const after = grounding.slice(at + m[0].length, at + m[0].length + 4);
    if (/^\s*(?:%|％|張|億|萬|兆|倍|天|日|個|檔)/.test(after)) continue;
    out.push(parseNum(m[0]));
  }
  return out;
}

function sentenceAround(text: string, at: number): { start: number; end: number } {
  let start = at;
  while (start > 0 && !SENTENCE_SPLIT.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !SENTENCE_SPLIT.test(text[end])) end++;
  return { start, end: Math.min(text.length, end + 1) };
}

/**
 * 找出回答裡「參考資料沒有出處」的股價／指數點數。參考資料是空的（沒有任何數字）時不檢查（交給誠實規則）。
 */
export function findUngroundedPrices(answer: string, grounding: string): UngroundedPrice[] {
  if (!answer || !grounding) return [];
  const known = groundingPriceNumbers(grounding);
  if (known.length === 0) return [];
  // 回答裡「名稱(代號)」對照，名稱也能拿來歸屬（「台積電參考價約600元」那句沒寫代號）。
  const refs: Array<{ key: string; symbol: string }> = [];
  for (const m of answer.matchAll(STOCK_REF)) {
    const symbol = m[2].toUpperCase();
    if (NOT_TICKER.has(symbol)) continue;
    refs.push({ key: symbol, symbol });
    const name = m[1].replace(/^[*＊\s、，,：:]+/, "").trim();
    if (name.length >= 2) refs.push({ key: name, symbol });
  }
  const out: UngroundedPrice[] = [];
  for (const m of answer.matchAll(new RegExp(NUM_SRC, "g"))) {
    const raw = m[0];
    const at = m.index ?? 0;
    const before = answer.slice(Math.max(0, at - 12), at);
    const after = answer.slice(at + raw.length, at + raw.length + 6);
    const prevChar = answer[at - 1] ?? "";
    if (/[A-Za-z/\d.(（:：]/.test(prevChar) && !/[：:]/.test(prevChar)) continue;
    if (/^[/\d]/.test(after) || /^\s*[)）]/.test(after)) continue;
    if (NON_PRICE_UNIT_AFTER.test(after)) continue;
    const priceLike = PRICE_UNIT_AFTER.test(after) || PRICE_CUE_BEFORE.test(before);
    if (!priceLike) continue;
    if (CHANGE_CUE_BEFORE.test(before)) continue;
    const n = parseNum(raw);
    if (!(n >= 1)) continue;
    // 年份、日期（2026 年、10 月）已由單位排除；四位數代號在括號裡也已排除。
    const sent = sentenceAround(answer, at);
    const head = answer.slice(sent.start, at);
    let symbol: string | null = null;
    let bestIdx = -1;
    for (const r of refs) {
      const i = head.lastIndexOf(r.key);
      if (i > bestIdx) {
        bestIdx = i;
        symbol = r.symbol;
      }
    }
    const sentence = answer.slice(sent.start, sent.end);
    if (!symbol && HYPOTHETICAL.test(sentence)) continue;
    // 沒歸屬到任何個股、只有「X 元」（「每 1 元盈餘付 50 元」這種一般說明）不算報價；要有價格字眼或是指數點數。
    if (!symbol && !PRICE_CUE_BEFORE.test(before) && !/^\s*點/.test(after)) continue;
    if (symbol && !grounding.includes(`(${symbol})`) && !grounding.includes(`（${symbol}）`) && !grounding.includes(symbol)) {
      out.push({ raw, sentence, symbol, reason: "stock-not-in-grounding" });
      continue;
    }
    const ok = known.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * UNGROUNDED_PRICE_TOLERANCE));
    if (!ok) out.push({ raw, sentence, symbol, reason: "number-not-in-grounding" });
  }
  return out;
}

/** 重生後仍有沒出處的價格：刪掉含這些價格的句子（整句刪，不留半句）；刪完不到原文一半就不刪（交給呼叫端決定）。 */
export function stripUngroundedPriceSentences(answer: string, found: UngroundedPrice[]): string {
  if (found.length === 0) return answer;
  let text = answer;
  for (const s of [...new Set(found.map((f) => f.sentence))]) {
    if (s.trim()) text = text.replace(s, "");
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length >= answer.length * 0.5 ? text : answer;
}

/** 回答後檢查的問題說明（重生時附給模型）。 */
export function ungroundedPriceIssues(found: UngroundedPrice[]): string[] {
  if (found.length === 0) return [];
  const list = found.slice(0, 5).map((f) => (f.symbol ? `${f.symbol} 的 ${f.raw}` : f.raw));
  return [`${UNGROUNDED_PRICE_ISSUE_PREFIX}：${list.join("、")}；只能寫參考資料裡真實出現的股價／指數點數，資料沒有的價格就不要寫，不可用自己的記憶補`];
}
export const UNGROUNDED_PRICE_ISSUE_PREFIX = "回答裡有參考資料沒有的價格";
