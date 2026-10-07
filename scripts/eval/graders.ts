// 跨模型 AI 品質評測的自動評分器（純函式、無 I/O；測試見 src/__tests__/evalGraders.test.ts）。
// 主分數一律以這裡的程式規則為準；LLM 評審（run.ts --judge）只是輔助參考。
import { extractKeyLevels, findUngroundedPrices, guardAnswerNumbers } from "@/lib/ai/numberGuard";
import { MARGIN_SIGNAL_TITLE } from "@/lib/ai/marginSignalData";
import type { CheckResult, CheckSpec, EvalCase } from "./types";

export type Phase = "pre-open" | "intraday" | "after-hours-fixed" | "after-close" | "weekend";

export interface GradeInput {
  caseDef: EvalCase;
  /** 模型原始輸出（繁中轉換、標記清理、價位更正之前） */
  rawAnswer: string;
  /** 經過正式流程後處理（與 ask.ts 相同）之後使用者實際看到的回答 */
  finalAnswer: string;
  /** 這次附給 AI 的參考資料（ask.ts 組好的 grounding） */
  grounding: string;
  /** 繁中轉換修了幾個字（normalizeZhTw.fixedCount） */
  zhFixedCount: number;
  /** 組參考資料當下的台股時段 */
  phase: Phase;
}

export interface ProgramRating {
  name: string;
  symbol: string;
  unheld: string;
  held: string;
}

// ---------------------------------------------------------------- 小工具

/** 去掉 Markdown 粗體／標題／清單符號，方便比對文字。 */
export function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    .trim();
}

/** 前 n 句（以。！？或換行切）。 */
export function firstSentences(text: string, n = 1): string {
  const parts = plain(text)
    .split(/(?<=[。！？!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(0, n).join("");
}

/** 評等字樣核心（括號前），例如「建議等回檔再買（現價不買…）」→「建議等回檔再買」。 */
export function coreLabel(label: string): string {
  return label.split(/[（(]/)[0].trim();
}

const RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：未持有：「([^」]*)」／已持有：「([^」]*)」/g;

/** 參考資料裡每一檔的程式評等（同一檔出現多次取第一次）。 */
export function parseProgramRatings(grounding: string): Map<string, ProgramRating> {
  const out = new Map<string, ProgramRating>();
  for (const m of grounding.matchAll(RATING_LINE)) {
    const symbol = m[2].toUpperCase();
    if (!out.has(symbol)) out.set(symbol, { name: m[1].trim(), symbol, unheld: m[3], held: m[4] });
  }
  return out;
}

/** 回答裡出現的股票代號：只看括號內（RULE_FULL_NAME_WITH_TICKER 要求「名稱(代號)」格式）；裸數字多半是價格，不算。 */
const NOT_TICKERS = new Set(["EPS", "RSI", "KD", "MACD", "ETF", "MA", "PE", "PB", "VIX", "WTI", "AI", "USD", "TWD", "DIF", "YOY", "MOM", "ROE", "GDP", "CPI", "PMI", "FED", "OK", "K", "D", "TSMC", "ADR", "IC", "PCB", "HBM", "GPU", "CPU"]);

export function mentionedSymbols(answer: string): string[] {
  const set = new Set<string>();
  for (const m of answer.matchAll(/[（(]\s*([0-9]{4,6}[A-Z]?|[A-Z]{1,5}(?:\.[A-Z])?)\s*[)）]/g)) {
    if (!NOT_TICKERS.has(m[1].toUpperCase())) set.add(m[1].toUpperCase());
  }
  return [...set];
}

function nameOrSymbolIndex(text: string, r: { name: string; symbol: string }): number {
  const names = [r.symbol, r.name.replace(/[*＊]|-KY$/g, ""), r.name].filter((s) => s.length >= 2);
  const idx = names.map((n) => text.indexOf(n)).filter((i) => i >= 0);
  return idx.length > 0 ? Math.min(...idx) : -1;
}

export type HoldVerdict = "sell" | "keep" | "unknown";

export function verdictCategory(text: string): HoldVerdict {
  const sell = text.search(/減碼|出場|停損|賣出|賣掉|全部賣/);
  const keep = text.search(/續抱|加碼|持有觀察|繼續持有/);
  if (sell < 0 && keep < 0) return "unknown";
  if (sell < 0) return "keep";
  if (keep < 0) return "sell";
  return sell < keep ? "sell" : "keep";
}

// ---------------------------------------------------------------- 通用檢查（每題都套）

const ENGLISH_SENTENCE = /(?:\b[A-Za-z][a-z']+\b[\s,]+){5,}\b[A-Za-z][a-z']+/;
const INTERNAL_MARKERS = /【內部|非使用者可見|禁止原樣|內部系統標記|未持有[：:]\s*「|已持有[：:]\s*「|參考資料(顯示|中|裡)/;

export function gradeUniversal(g: GradeInput): CheckResult[] {
  const out: CheckResult[] = [];
  const raw = g.rawAnswer;
  out.push({ rule: "繁中（無簡體／日文字）", pass: g.zhFixedCount === 0, detail: g.zhFixedCount ? `轉換了 ${g.zhFixedCount} 個字` : undefined });
  const eng = raw.match(ENGLISH_SENTENCE);
  out.push({ rule: "無英文句子", pass: !eng, detail: eng?.[0].slice(0, 80) });
  const leak = raw.match(INTERNAL_MARKERS);
  out.push({ rule: "無內部標記外洩", pass: !leak, detail: leak?.[0] });
  const opener = plain(raw).match(/^(好的|根據(參考)?資料|您好|嗨)/);
  out.push({ rule: "第一句不是開場白", pass: !opener, detail: opener?.[0] });

  if (extractKeyLevels(g.grounding).levels.length > 0) {
    const { fixes } = guardAnswerNumbers(raw, g.grounding);
    out.push({
      rule: "關鍵價位照抄程式值",
      pass: fixes.length === 0,
      detail: fixes.length ? fixes.map((f) => `${f.from}→${f.to}`).join("、") : undefined,
    });
  }

  const codes = mentionedSymbols(g.finalAnswer).filter((c) => /^[0-9]/.test(c));
  const ungrounded = codes.filter((c) => !g.grounding.includes(c) && !g.caseDef.question.includes(c));
  out.push({ rule: "代號都出自參考資料（不編股票）", pass: ungrounded.length === 0, detail: ungrounded.join("、") || undefined });

  // 引用教訓／相似案例時要帶數字證據（2026-10-05 已知問題：AI 引用教訓沒帶證據數字）。
  const lessonSentences = plain(g.finalAnswer)
    .split(/(?<=[。！？])|\n+/)
    .filter((s) => /教訓|相似案例|本站回測|回測(顯示|結果|統計|中|數據)/.test(s));
  if (lessonSentences.length > 0) {
    const bare = lessonSentences.filter((s) => !/\d/.test(s));
    out.push({ rule: "引用教訓／相似案例帶數字", pass: bare.length === 0, detail: bare[0]?.slice(0, 80) });
  }

  if (g.phase === "intraday") {
    const m = g.finalAnswer.match(/今天收在|收盤價為|今日收盤/);
    out.push({ rule: "盤中不說收盤", pass: !m, detail: m?.[0] });
  }
  if (g.phase === "weekend") {
    const m = g.finalAnswer.match(/今天(上漲|下跌|收|開盤|漲|跌)|今日(上漲|下跌|收|漲|跌)/);
    out.push({ rule: "週末不說今天行情", pass: !m, detail: m?.[0] });
  }
  if (g.phase === "after-close" || g.phase === "weekend") {
    const m = g.finalAnswer.match(/現在盤中|目前盤中|現在掛單可成交/);
    out.push({ rule: "收盤後不說現在盤中", pass: !m, detail: m?.[0] });
  }
  return out;
}

// ---------------------------------------------------------------- 題目專屬檢查

export function gradeCheck(spec: CheckSpec, g: GradeInput): CheckResult {
  const ans = g.finalAnswer;
  const ratings = parseProgramRatings(g.grounding);
  switch (spec.kind) {
    case "ratingFirst": {
      const r = ratings.get(spec.symbol.toUpperCase());
      if (!r) return { rule: "第一句照抄評等", pass: false, detail: `參考資料沒有 ${spec.symbol} 的評等（資料抓取失敗或沒解析到股票）` };
      const label = coreLabel(spec.held ? r.held : r.unheld);
      const head = firstSentences(ans, 1);
      return { rule: "第一句照抄評等", pass: head.includes(label), detail: head.includes(label) ? undefined : `應含「${label}」，第一句：${head.slice(0, 80)}` };
    }
    case "ratingEach": {
      const miss: string[] = [];
      const head = firstSentences(ans, 2);
      for (const s of spec.symbols) {
        const r = ratings.get(s.toUpperCase());
        if (!r) {
          miss.push(`${s}(無評等資料)`);
          continue;
        }
        const label = coreLabel(r.unheld);
        // 通過條件：該檔任一次出現的前 80～後 200 字內有自己的評等字樣；或開頭用「兩檔都／都是＋字樣」一起講（且各檔字樣相同）。
        const names = [r.symbol, r.name.replace(/[*＊]|-KY$/g, ""), r.name].filter((n) => n.length >= 2);
        const near = names.some((n) => {
          for (let i = ans.indexOf(n); i >= 0; i = ans.indexOf(n, i + 1)) {
            if (ans.slice(Math.max(0, i - 80), i + 200).includes(label)) return true;
          }
          return false;
        });
        const sameLabelAll = spec.symbols.every((x) => {
          const rx = ratings.get(x.toUpperCase());
          return rx && coreLabel(rx.unheld) === label;
        });
        const collective =
          (sameLabelAll && new RegExp(`都(是|為)?「?${label}`).test(head)) ||
          // 只問一檔時，第一句就是評等字樣即可（名稱常在後面才出現）。
          (spec.symbols.length === 1 && firstSentences(ans, 1).includes(label));
        if (!near && !collective) miss.push(`${r.name}(${s})應為「${label}」`);
      }
      return { rule: "每檔照各自評等", pass: miss.length === 0, detail: miss.join("；") || undefined };
    }
    case "picksOne": {
      const head = firstSentences(ans, 2);
      const named = spec.symbols.filter((s) => {
        const r = ratings.get(s) ?? { name: s, symbol: s };
        return nameOrSymbolIndex(head, r) >= 0;
      });
      const choosing = /選|較|優先|首選|更看好|比較推薦|勝出|偏好/.test(head);
      return { rule: "比較題選出一檔", pass: choosing && named.length >= 1, detail: choosing && named.length >= 1 ? undefined : `前兩句：${head.slice(0, 100)}` };
    }
    case "onlySymbols": {
      const allowed = new Set(spec.allowed.map((s) => s.toUpperCase()));
      const extra = mentionedSymbols(ans).filter((c) => !allowed.has(c) && c !== "0050");
      return { rule: "不扯無關個股", pass: extra.length === 0, detail: extra.join("、") || undefined };
    }
    case "onlyRatedSymbols": {
      // 「推薦」的股票都要有【本站綜合評等】：回答裡出現的代號必須是評等名單裡的（0050 對照句除外）。
      const extra = mentionedSymbols(ans).filter((c) => !ratings.has(c) && c !== "0050");
      return { rule: "只推有評等的股票", pass: extra.length === 0, detail: extra.join("、") || undefined };
    }
    case "marginSignalMention": {
      const m = g.grounding.match(new RegExp(`${MARGIN_SIGNAL_TITLE}（[^）]*）：【([^】]+)】`));
      if (!m) return { rule: "講出融資融券組合判讀", pass: true, detail: "當日該檔無非中性訊號，不適用" };
      return { rule: "講出融資融券組合判讀", pass: plain(ans).includes(m[1]), detail: plain(ans).includes(m[1]) ? undefined : `應提到「${m[1]}」` };
    }
    case "require": {
      const ok = spec.any.some((p) => new RegExp(p, "m").test(plain(ans)));
      return { rule: spec.name, pass: ok };
    }
    case "forbid": {
      const hit = spec.any.map((p) => plain(ans).match(new RegExp(p, "m"))).find(Boolean);
      return { rule: spec.name, pass: !hit, detail: hit?.[0] };
    }
    case "length": {
      const n = plain(ans).replace(/\s/g, "").length;
      const ok = (spec.min == null || n >= spec.min) && (spec.max == null || n <= spec.max);
      return { rule: "字數區間", pass: ok, detail: `${n} 字（${spec.min ?? 0}～${spec.max ?? "∞"}）` };
    }
    case "yesNoDirect": {
      const head = firstSentences(ans, 1);
      const bareStart = /^(有的|沒有|是的|對|有)[，,。！]/.test(head);
      const hasSubject = spec.subject.some((s) => head.includes(s));
      return { rule: "是非題直答（主詞完整）", pass: !bareStart && hasSubject, detail: !bareStart && hasSubject ? undefined : head.slice(0, 80) };
    }
    case "holdingVerdicts": {
      const bad: string[] = [];
      for (const s of spec.symbols) {
        const r = ratings.get(s);
        if (!r) continue;
        const want = verdictCategory(r.held);
        const at = nameOrSymbolIndex(ans, r);
        if (at < 0) {
          bad.push(`${r.name}沒提到`);
          continue;
        }
        const got = verdictCategory(ans.slice(at, at + 120));
        if (got !== want) bad.push(`${r.name}程式「${r.held}」回答判成 ${got}`);
      }
      return { rule: "持股結論與程式評等一致", pass: bad.length === 0, detail: bad.join("；") || undefined };
    }
    case "sellListMatches": {
      const want = spec.symbols.filter((s) => {
        const r = ratings.get(s);
        return r && verdictCategory(r.held) === "sell";
      });
      const got = spec.symbols.filter((s) => {
        const r = ratings.get(s);
        return r && nameOrSymbolIndex(ans, r) >= 0;
      });
      const ok = want.length === got.length && want.every((s) => got.includes(s));
      return {
        rule: "賣出名單與程式評等一致",
        pass: ok,
        detail: ok ? undefined : `程式減碼／出場：${want.join("、") || "無"}；回答列出：${got.join("、") || "無"}`,
      };
    }
    case "noStopLossUnheld": {
      const m = ans.match(/.{0,10}停損.{0,10}/);
      return { rule: "未持有不說停損", pass: !m, detail: m?.[0] };
    }
    case "minSymbols": {
      const n = mentionedSymbols(g.finalAnswer).length;
      return { rule: `至少點名 ${spec.min} 檔股票`, pass: n >= spec.min, detail: `${n} 檔` };
    }
    case "noUngroundedPrice": {
      const found = findUngroundedPrices(g.finalAnswer, g.grounding);
      return { rule: "股價／指數不編造（出自參考資料）", pass: found.length === 0, detail: found.map((f) => `${f.symbol ?? ""}${f.raw}`).join("、") || undefined };
    }
  }
}

/** 一題的所有檢查（通用＋題目專屬）。 */
export function gradeAnswer(g: GradeInput): CheckResult[] {
  if (!g.finalAnswer.trim()) return [{ rule: "有回答", pass: false, detail: "空白或被拒（繁中把關不合格）" }];
  return [...gradeUniversal(g), ...g.caseDef.checks.map((c) => gradeCheck(c, g))];
}
