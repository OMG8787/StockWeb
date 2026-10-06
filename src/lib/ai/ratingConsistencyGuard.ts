/**
 * 回答後的「評等與價位建議一致性」檢查（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 正式站：評等為「建議先不要買」，AI 仍自己補「若買進後跌破 134.5 元建議出場」（134.5 是觀察用支撐），
 * 或寫「等回到 A～B 再分批買」——跟「先不要買」矛盾。numberGuard 只管數字抄錯，抓不到這種「不該出現的價位建議」。
 * 規則：參考資料裡某檔是「建議先不要買」且使用者沒持有（該檔沒有【持有中出場參考】）時，回答裡歸屬於那檔的
 * 「出場價／停損價／買進區間／回到 X 再買」子句一律刪掉（只能講改判建議買進的條件，見 describeSiteRating）。
 *
 * 選擇「刪掉子句」而不是重生：同 numberGuard 的理由（零花費、確定性、重生仍可能再犯）。
 */

import { HOLDING_SUMMARY_TITLE, WATCH_SUMMARY_TITLE } from "./holdingRating";

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：未持有：「([^」]*)」/g;
/** 使用者持有這檔時，參考資料會附這個標題（持有中出場價是合理的）。 */
export const HOLDING_EXIT_MARKER = "持有中出場參考";

/** 「先不要買」時不可出現的價位建議（出場、停損、買進區間、回到 X 再買）。 */
export const AVOID_FORBIDDEN_PRICE_ADVICE = new RegExp(
  [
    String.raw`跌破\s*(?:${NUM})[^，,。；;\n]{0,10}(?:出場|停損|賣出)`,
    String.raw`(?:停損|出場)(?:價|點|參考價)?\s*(?:設|在|為|於|：|:)?\s*(?:約)?\s*(?:${NUM})`,
    String.raw`(?:回到|回檔到|拉回到|拉回至|回測)\s*(?:約)?\s*(?:${NUM})(?:\s*[～~至到\-]\s*(?:${NUM}))?[^，,。；;\n]{0,10}(?:買|進場|布局|承接)`,
    String.raw`(?:買進區間|分批買進區間|進場區間|買點)\s*(?:約|為|在|：|:)?\s*(?:${NUM})`,
  ].join("|")
);

interface Anchor {
  symbol: string;
  name: string;
  avoid: boolean;
  held: boolean;
}

function parseAnchors(grounding: string): Anchor[] {
  const raw = [...grounding.matchAll(RATING_LINE)];
  return raw.map((m, i) => {
    const seg = grounding.slice(m.index ?? 0, raw[i + 1]?.index ?? grounding.length);
    return {
      symbol: m[2].toUpperCase(),
      name: m[1].trim(),
      avoid: m[3].startsWith("建議先不要買"),
      held: seg.includes(HOLDING_EXIT_MARKER),
    };
  });
}

function stockBefore(text: string, anchors: Anchor[]): Anchor | null {
  let best = -1;
  let hit: Anchor | null = null;
  for (const a of anchors) {
    for (const key of [a.symbol, a.name]) {
      if (key.length < 2) continue;
      const i = text.lastIndexOf(key);
      if (i > best) {
        best = i;
        hit = a;
      }
    }
  }
  if (hit) return hit;
  // 單一檔的問答常常不重複寫名稱：參考資料只有一檔時就是那檔。
  const unique = new Set(anchors.map((a) => a.symbol));
  return unique.size === 1 ? anchors[0] : null;
}

export interface AvoidAdviceFix {
  symbol: string;
  removed: string;
}

/** 刪掉「先不要買」股票的出場價／買進區間子句。參考資料沒有先不要買的檔就原樣回傳。 */
export function guardAvoidPriceAdvice(answer: string, grounding: string): { text: string; fixes: AvoidAdviceFix[] } {
  const anchors = parseAnchors(grounding);
  if (!answer || !anchors.some((a) => a.avoid && !a.held)) return { text: answer, fixes: [] };
  const fixes: AvoidAdviceFix[] = [];
  const out: string[] = [];
  let consumed = "";
  for (const line of answer.split("\n")) {
    const clauses = line.split(/(?<=[，,。；;！？])/);
    const kept: string[] = [];
    let lineSoFar = "";
    for (const c of clauses) {
      lineSoFar += c;
      if (AVOID_FORBIDDEN_PRICE_ADVICE.test(c)) {
        const who = stockBefore(consumed + lineSoFar, anchors);
        if (who && who.avoid && !who.held) {
          fixes.push({ symbol: who.symbol, removed: c });
          continue;
        }
      }
      kept.push(c);
    }
    consumed += line + "\n";
    if (kept.length < clauses.length) {
      let fixed = kept.join("").replace(/[，,]\s*$/, "。");
      if (/^\s*(?:[-•*]|\d+[.、])?\s*$/.test(fixed)) continue;
      // 被刪的是句尾、留下的句子沒有句號時補一個。
      if (!/[。！？：:）)]\s*$/.test(fixed) && /[。；;]\s*$/.test(line)) fixed += "。";
      out.push(fixed);
    } else {
      out.push(line);
    }
  }
  return { text: out.join("\n"), fixes };
}

// ---------------------------------------------------------------- 持有中的持有建議逐字一致（2026-10-06）

/**
 * 2026-10-06 09:29 使用者回報（關注清單逐檔分析，gemini-3.1-flash-lite）：程式的持有建議是「建議減碼」，
 * AI 卻寫成「建議停損／全部賣出」「建議減碼或出場」；虧損中的股票寫「獲利已吐回」。
 * 規則（程式保證，不靠模型自律）：參考資料裡「持有中」的每一檔（【持股評等彙整】或評等行的「已持有」字樣），
 * 回答裡歸屬於那檔、且不是條件句（若跌破 X…）的持有動作，跟程式的動作類別不同時，改成程式字樣的核心；
 * 「減碼或出場」這種混寫一律改成程式的單一動作；虧損中的那檔不可出現「獲利已吐回」。
 * 改寫而不重生：多檔長回答重生很容易逾時（同 numberGuard 的理由：零花費、確定性）。
 */

type HoldClass = "keep" | "reduce" | "exit";

export interface HeldAnchor {
  symbol: string;
  name: string;
  /** 程式的「已持有」字樣全文 */
  label: string;
  /** 字樣核心（去掉括號說明），例如「建議減碼」 */
  core: string;
  cls: HoldClass;
  /** 現價對成本漲跌%（彙整有附才有） */
  pnlPct: number | null;
}

function holdClassOf(label: string): HoldClass {
  if (/出場|停損|賣出|清倉/.test(label)) return "exit";
  if (/減碼/.test(label)) return "reduce";
  return "keep";
}

const SUMMARY_ITEM = /([^、：；」（）()\n]+?)\(([0-9A-Za-z.\-]+)\)「([^」]*)」(?:（目前(虧損|獲利)約 ([\d.]+)%）)?/g;
const HELD_RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：未持有：「[^」]*」／已持有：「([^」]*)」/g;

/** 從參考資料取出「持有中」的每一檔與程式的持有建議（彙整優先，含賺賠；個股題用評等行＋持有中出場參考）。 */
export function parseHeldAnchors(grounding: string, summaryTitle: string = HOLDING_SUMMARY_TITLE): HeldAnchor[] {
  const out = new Map<string, HeldAnchor>();
  const add = (name: string, symbol: string, label: string, pnl: number | null) => {
    const core = label.replace(/[（(].*$/, "").trim();
    out.set(symbol.toUpperCase(), { symbol: symbol.toUpperCase(), name: name.trim(), label, core, cls: holdClassOf(core), pnlPct: pnl });
  };
  const summaryLine = grounding.split("\n").find((l) => l.includes(summaryTitle));
  if (summaryLine) {
    for (const m of summaryLine.slice(summaryLine.indexOf(summaryTitle) + summaryTitle.length).matchAll(SUMMARY_ITEM)) {
      const name = m[1].replace(/^.*(?:的|）)[：:]?/, "").replace(/^[：:、\s]+/, "");
      const pnl = m[4] ? (m[4] === "虧損" ? -Number(m[5]) : Number(m[5])) : null;
      add(name, m[2], m[3], pnl);
    }
  }
  const raw = [...grounding.matchAll(HELD_RATING_LINE)];
  raw.forEach((m, i) => {
    const sym = m[2].toUpperCase();
    if (out.has(sym)) return;
    const seg = grounding.slice(m.index ?? 0, raw[i + 1]?.index ?? grounding.length);
    if (!seg.includes(HOLDING_EXIT_MARKER)) return;
    const loss = seg.match(/目前虧損約\s*([\d.]+)%/);
    const gain = seg.match(/目前(?:小賺|獲利)約\s*([\d.]+)%/);
    add(m[1], sym, m[3], loss ? -Number(loss[1]) : gain ? Number(gain[1]) : null);
  });
  return [...out.values()];
}

const ACT = "續抱|持續持有|加碼|減碼|停損|出場|全部賣出|全數賣出|賣出|清倉";
/**
 * 持有動作的寫法：必須是「建議／動作：／操作：／結論：」帶出的動作（避免把「外資賣出」「拉回可加碼」當成持有建議），
 * 可帶「／、或」串起的混寫（「建議停損／全部賣出」「建議減碼或出場」）；前面是「不／別／勿」的否定句不算。
 */
const HOLD_ACTION = new RegExp(
  String.raw`(?<![不無別勿])(建議|動作[：:]\s*|操作建議[：:]\s*|操作[：:]\s*|結論[：:]\s*)((?:${ACT})(?:\s*[／/、或]\s*(?:建議)?(?:${ACT}))*)`,
  "g"
);
/** 沒有「建議」前綴的賣出類混寫（「減碼或出場」「停損／全部賣出」）。 */
const MIXED_SELL = /(?<![不無別勿])(?:減碼|停損|出場|全部賣出|全數賣出|清倉)\s*[／/或]\s*(?:減碼|停損|出場|全部賣出|全數賣出|賣出|清倉)/g;
/** 條件句（「若跌破 30 就停損出場」）是出場條件，不是現在的動作，不改。 */
const CONDITIONAL = /跌破|若|如果|一旦|萬一|收盤低於|假如|否則|才/;
const GAVE_BACK = /獲利(?:已|全部|全數)?(?:吐回|回吐)(?:了)?/g;

function actionClassOf(action: string): HoldClass | "mixed" {
  const parts = action.split(/\s*[／/、或]\s*/).filter(Boolean);
  const classes = new Set(parts.map(holdClassOf));
  return classes.size > 1 ? "mixed" : [...classes][0];
}

export interface HoldingLabelFix {
  symbol: string;
  from: string;
  to: string;
}

/** 依程式持有建議改寫回答（只動持有中那幾檔、只動非條件句）。 */
export function guardHoldingLabels(answer: string, grounding: string): { text: string; fixes: HoldingLabelFix[] } {
  const anchors = parseHeldAnchors(grounding);
  if (!answer || anchors.length === 0) return { text: answer, fixes: [] };
  const asAnchor = anchors.map((a) => ({ symbol: a.symbol, name: a.name, avoid: false, held: true }));
  const fixes: HoldingLabelFix[] = [];
  let consumed = "";
  const out = answer.split("\n").map((line) => {
    const clauses = line.split(/(?<=[，,。；;！？])/);
    let lineSoFar = "";
    const fixed = clauses.map((c) => {
      lineSoFar += c;
      const who = stockBefore(consumed + lineSoFar, asAnchor);
      const a = who ? anchors.find((x) => x.symbol === who.symbol) : undefined;
      if (!a) return c;
      let next = c;
      if (!CONDITIONAL.test(c)) {
        const conflicts = (act: string) => {
          const cls = actionClassOf(act);
          if (cls === a.cls) return a.core.includes("不加碼") && /加碼/.test(act) && !/不加碼/.test(act);
          // 「續抱」「加碼」同屬保留部位（程式字樣是續抱、拉回可加碼時，AI 寫建議加碼不算矛盾）。
          return !(cls === "keep" && a.cls === "keep");
        };
        const coreWithout = a.core.replace(/^建議/, "");
        next = next.replace(HOLD_ACTION, (all, prefix: string, act: string) => {
          if (!conflicts(act)) return all;
          const to = prefix === "建議" ? `建議${coreWithout}` : `${prefix}${a.core}`;
          fixes.push({ symbol: a.symbol, from: all, to });
          return to;
        });
        next = next.replace(MIXED_SELL, (all) => {
          if (!conflicts(all)) return all;
          fixes.push({ symbol: a.symbol, from: all, to: coreWithout });
          return coreWithout;
        });
      }
      if (a.pnlPct != null && a.pnlPct < 0) {
        next = next.replace(GAVE_BACK, (g) => {
          fixes.push({ symbol: a.symbol, from: g, to: "已跌回成本以下" });
          return "已跌回成本以下";
        });
      }
      return next;
    });
    consumed += line + "\n";
    return fixed.join("");
  });
  return { text: out.join("\n").replace(/建議建議/g, "建議"), fixes };
}

/** 回答裡有提到、但附近沒寫出程式持有建議的持有中股票（給 finalize 補一行程式結論）。 */
export function heldWithoutLabel(answer: string, grounding: string, window = 220): HeldAnchor[] {
  return parseHeldAnchors(grounding).filter((a) => {
    const keys = [a.symbol, a.name].filter((k) => k.length >= 2);
    let mentioned = false;
    for (const key of keys) {
      let i = answer.indexOf(key);
      while (i >= 0) {
        mentioned = true;
        const w = answer.slice(Math.max(0, i - 30), i + window);
        if (w.includes(a.core) || w.includes(a.core.replace(/^建議/, ""))) return false;
        i = answer.indexOf(key, i + 1);
      }
    }
    return mentioned;
  });
}

export const HELD_LABEL_APPENDIX_TITLE = "本站持有建議（程式依評等與你的成本算好）";

/**
 * 持有中結論的回答後處理（唯一入口，ask.ts postProcessAiAnswer 呼叫）：改寫矛盾的持有動作／混寫／「獲利已吐回」，
 * 有提到卻沒寫出程式持有建議的持有中股票，在回答最後補一行程式結論（確定性、不重生）。
 */
export function guardHeldAnswer(answer: string, grounding: string): { text: string; fixes: HoldingLabelFix[]; appended: string[] } {
  const g = guardHoldingLabels(answer, grounding);
  const missing = heldWithoutLabel(g.text, grounding);
  if (missing.length === 0) return { ...g, appended: [] };
  const line = `${HELD_LABEL_APPENDIX_TITLE}：${missing.map((a) => `${a.name}(${a.symbol})「${a.label}」`).join("；")}`;
  return { text: `${g.text.replace(/\s+$/, "")}

${line}`, fixes: g.fixes, appended: missing.map((a) => a.symbol) };
}

export const COVERAGE_APPENDIX_TITLE = "清單裡其他股票的本站評等（回答漏掉，程式補上）";

/**
 * 關注清單深度分析：【持股評等彙整】與【僅關注評等彙整】裡的每一檔，回答都要提到（名稱或代號）；
 * 漏掉的在最後補一行程式結論（2026-10-06 13:25 使用者回報：漏掉僅關注的旺矽）。只在附了僅關注彙整
 * （＝深度分析）時檢查，輕量清單題（例如只問賣哪些）不補。
 */
export function guardHoldingsCoverage(answer: string, grounding: string): { text: string; appended: string[] } {
  if (!answer || !grounding.includes(WATCH_SUMMARY_TITLE)) return { text: answer, appended: [] };
  const items: Array<{ name: string; symbol: string; label: string }> = [];
  for (const title of [HOLDING_SUMMARY_TITLE, WATCH_SUMMARY_TITLE]) {
    const line = grounding.split("\n").find((l) => l.includes(title));
    if (!line) continue;
    for (const m of line.slice(line.indexOf(title) + title.length).matchAll(SUMMARY_ITEM)) {
      const name = m[1].replace(/^.*(?:的|）)[：:]?/, "").replace(/^[：:、\s]+/, "").trim();
      items.push({ name, symbol: m[2].toUpperCase(), label: m[3] });
    }
  }
  const missing = items.filter((it) => !answer.includes(it.symbol) && !(it.name.length >= 2 && answer.includes(it.name)));
  if (missing.length === 0) return { text: answer, appended: [] };
  const line = `${COVERAGE_APPENDIX_TITLE}：${missing.map((m) => `${m.name}(${m.symbol})「${m.label}」`).join("；")}`;
  return { text: `${answer.replace(/\s+$/, "")}\n\n${line}`, appended: missing.map((m) => m.symbol) };
}
