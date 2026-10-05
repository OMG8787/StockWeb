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
