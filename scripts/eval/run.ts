/**
 * 跨模型 AI 品質評測執行器（說明見 scripts/eval/README.md）：
 *   npx tsx scripts/eval/run.ts                       # 全部題目 × 預設模型組
 *   npx tsx scripts/eval/run.ts --only buy-twse,compare-tw
 *   npx tsx scripts/eval/run.ts --variants gemini,nvidia --judge
 *
 * 做法：每題先用正式的 answerQuestion() 組好系統提示詞與參考資料（攔截鉤子截下輸入、不呼叫 AI），
 * 再把「同一份輸入」分別強制送給各模型（provider.ts forceProvider），套用與 ask.ts 相同的後處理，
 * 交給 graders.ts 評分。這樣各模型比較的是同一份資料，不受報價跳動影響。
 * 金鑰只從 .env.local 讀，不會印出。全部走免費額度：題目間隔＋429 退避。
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { ChatTurn } from "@/lib/ai/types";
import type { CallAiProvidersOptions, ProviderResult } from "@/lib/ai/provider";
import { EVAL_CASES } from "./cases";
import { gradeAnswer, type Phase } from "./graders";
import { renderComparison, renderReport, type CaseCapture, type EvalRecord } from "./report";
import type { EvalCase } from "./types";

loadEnvConfig(process.cwd());
// 2026-10-05 實測：gemini-2.5-flash 對這把金鑰回 404（不再開放新用戶）、非 lite 的 3.x flash 免費層每模型每天只有
// 20 次且思考 token 會吃掉輸出上限而被截斷。評測預設把 Gemini 固定在 lite（正式站原本實際在用的模型），
// 參考資料裡的 AI 判斷層等輔助呼叫也走它；要測正式流程的自動挑選加 --gemini-auto，要測其他模型用 gemini:<模型>。
if (!process.env.GEMINI_MODEL && !process.argv.includes("--gemini-auto")) process.env.GEMINI_MODEL = "gemini-flash-lite-latest";

/** 評測的「模型組」：gemini＝正式 Gemini 轉接層（模型見上面 GEMINI_MODEL）；gemini:<model>＝評測腳本直接指定 Gemini 模型。 */
const DEFAULT_VARIANTS = ["gemini", "nvidia", "groq"];
const CASE_GAP_MS = 6000;
const RETRY_WAITS_MS = [30_000, 65_000];
/** 評測給寬一點的逾時，量的是品質；實際延遲另外記錄在報告裡。 */
const EVAL_TIMEOUT_MS = 60_000;
/** 組參考資料時不放行輔助 AI 呼叫（省額度；改前改後要用同一設定比較）。 */
const NO_AUX_AI = process.argv.includes("--no-aux-ai");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
/** 進度輸出直接寫 stdout：組下一題參考資料時 console 會被暫時靜音。 */
const log = (s: string) => process.stdout.write(`${s}
`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 假時鐘（只在組參考資料時用）
const RealDate = Date;
function withFakeClock<T>(iso: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!iso) return fn();
  const offset = new RealDate(iso).getTime() - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FakeDate as DateConstructor;
  return fn().finally(() => {
    globalThis.Date = RealDate;
  });
}

// ---------------------------------------------------------------- 截下 ask.ts 組好的輸入
interface Captured {
  system: string;
  messages: ChatTurn[];
  options: CallAiProvidersOptions;
  grounding: string;
  phase: Phase;
}

async function captureCase(c: EvalCase): Promise<Captured | { error: string }> {
  const { setAiEvalInterceptor } = await import("@/lib/ai/provider");
  const { SYSTEM_ROLE } = await import("@/lib/ai/askSystemPrompt");
  const { answerQuestion } = await import("@/lib/ai/ask");
  const { getTwTradingPhase } = await import("@/lib/pollingSchedule");
  let cap: Omit<Captured, "grounding" | "phase"> | undefined;
  let phase: Phase = "after-close";
  setAiEvalInterceptor((system, messages, options) => {
    // 評測自己的強制呼叫、以及 AI 判斷層／新聞分類等其他用途照常放行，只截下 AI 問答那一次。
    if (options.forceProvider) return undefined;
    // --no-aux-ai：組參考資料時的其他 AI 呼叫（AI 判斷層、今日建議解說等）一律擋下，不吃免費額度（Gemini 共用金鑰）。
    if (!system.startsWith(SYSTEM_ROLE))
      return NO_AUX_AI ? ({ answer: "", usedAi: false, failureReason: "eval aux blocked" } satisfies ProviderResult) : undefined;
    cap = { system, messages: messages.map((m) => ({ ...m })), options: { ...options } };
    return { answer: "", usedAi: false, failureReason: "eval capture" } satisfies ProviderResult;
  });
  const quiet = silenceConsole();
  try {
    await withFakeClock(c.clock, async () => {
      phase = getTwTradingPhase(new Date());
      await answerQuestion(c.question, c.contextSymbol, c.history ?? [], c.holdings ?? []);
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    quiet.restore();
    setAiEvalInterceptor(undefined);
  }
  if (!cap) return { error: "answerQuestion 沒有呼叫 AI（可能走了別的分支）" };
  const user = cap.messages[cap.messages.length - 1]?.content ?? "";
  const m = user.match(/^參考資料：\n([\s\S]*)\n\n使用者問題：/);
  return { ...cap, grounding: m ? m[1] : "", phase };
}

function silenceConsole() {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = () => {};
  return { restore: () => Object.assign(console, saved) };
}

// ---------------------------------------------------------------- 各模型呼叫
async function callGeminiDirect(model: string, cap: Captured): Promise<{ text: string; model: string }> {
  const { AI_TEMPERATURE } = await import("@/lib/ai/types");
  const key = process.env.GEMINI_API_KEY ?? "";
  // 與 gemini.ts callGemini 相同的請求格式（只差在直接指定模型）。
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: cap.system }] },
      contents: cap.messages.slice(-10).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: cap.options.maxOutputTokens ?? 1000, temperature: AI_TEMPERATURE },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("回覆被輸出長度上限截斷");
  if (!text.trim()) throw new Error("回應為空");
  return { text: text.trim(), model };
}

async function callVariant(variant: string, cap: Captured): Promise<{ text: string; model: string } | { error: string }> {
  const { callAiProviders } = await import("@/lib/ai/provider");
  for (let attempt = 0; ; attempt++) {
    let error: string;
    try {
      if (variant.startsWith("gemini:")) return await callGeminiDirect(variant.slice(7), cap);
      const r = await callAiProviders(cap.system, cap.messages, {
        ...cap.options,
        timeoutMs: EVAL_TIMEOUT_MS,
        totalBudgetMs: EVAL_TIMEOUT_MS + 5000,
        forceProvider: variant as "gemini" | "nvidia" | "groq",
        normalizeZhTw: false,
      });
      if (r.usedAi) return { text: r.answer, model: r.model ?? variant };
      error = r.failureReason ?? "未知原因";
      if (/請求太大|接不住/.test(error) || error === "") return { error: "請求太大，這家接不住（canHandle＝false，未送出）" };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const retryable = /429|額度|quota|rate|5\d\d|忙碌|overloaded|逾時|abort|timeout/i.test(error);
    if (!retryable || attempt >= RETRY_WAITS_MS.length) return { error };
    await sleep(RETRY_WAITS_MS[attempt]);
  }
}

/** 回答後檢查不過時，用同一個模型（同一個 variant）帶錯誤說明重生一次——跟正式流程 ask.ts 一樣。 */
async function regenerateWith(variant: string, cap: Captured, previous: string, issues: string[]): Promise<string | null> {
  const ask = (await import("@/lib/ai/ask")) as { regenerateTurns?: (p: string, i: string[]) => ChatTurn[] };
  if (!ask.regenerateTurns) return null;
  const r = await callVariant(variant, { ...cap, messages: [...cap.messages, ...ask.regenerateTurns(previous, issues)] });
  if ("error" in r) return null;
  const { normalizeZhTw } = await import("@/lib/ai/zhTwNormalize");
  const checked = normalizeZhTw(r.text);
  return "rejectReason" in checked && checked.rejectReason ? null : checked.text;
}

async function postProcess(
  raw: string,
  grounding: string,
  regenerate?: (issues: string[]) => Promise<string | null>
): Promise<{ final: string; zhFixed: number; reject?: string; outcome?: string; issues?: string[] }> {
  const { normalizeZhTw } = await import("@/lib/ai/zhTwNormalize");
  const checked = normalizeZhTw(raw);
  if ("rejectReason" in checked && checked.rejectReason) return { final: "", zhFixed: checked.fixedCount, reject: checked.rejectReason };
  // 與正式流程同一個入口（ask.ts finalizeAiAnswer：後處理→回答後檢查→重生→程式版）；舊版沒有就退回 postProcessAiAnswer。
  const fin = (await import("@/lib/ai/ask")) as {
    finalizeAiAnswer?: (i: { raw: string; grounding: string; regenerate?: (issues: string[]) => Promise<string | null> }) => Promise<{
      answer: string;
      outcome: string;
      issues: string[];
    }>;
  };
  if (fin.finalizeAiAnswer) {
    const f = await fin.finalizeAiAnswer({ raw: checked.text, grounding, regenerate });
    return { final: f.answer, zhFixed: checked.fixedCount, outcome: f.outcome, issues: f.issues };
  }
  // 與正式流程同一個後處理入口（ask.ts postProcessAiAnswer）。舊版程式（例如評測改動前的 commit）沒有這個匯出時，
  // 退回當時 ask.ts 的寫法：清內部標記→拿掉評等標籤→關鍵價位更正。
  const ask = (await import("@/lib/ai/ask")) as { postProcessAiAnswer?: (a: string, g: string) => string };
  if (ask.postProcessAiAnswer) return { final: ask.postProcessAiAnswer(checked.text, grounding), zhFixed: checked.fixedCount };
  const { sanitizeLeakedMarkers } = await import("@/lib/ai/askFallback");
  const { stripRatingTags } = await import("@/lib/ai/siteRating");
  const { guardAnswerNumbers } = await import("@/lib/ai/numberGuard");
  return { final: guardAnswerNumbers(stripRatingTags(sanitizeLeakedMarkers(checked.text)), grounding).text, zhFixed: checked.fixedCount };
}

// ---------------------------------------------------------------- LLM 評審（輔助）
const JUDGE_SYSTEM =
  "你是嚴格的評審，評估一個台股網站 AI 助理的回答品質。依下列評分表給 1～5 分整數：①有沒有直接回答使用者的問題（第一句就是結論）；②一般人看得懂、白話；③理由具體且帶數字、不空泛；④給出可照做的動作（價位、條件）；⑤精簡不囉嗦、不自相矛盾。只回 JSON：{\"score\":整數,\"reason\":\"一句繁體中文理由\"}。";

async function judge(question: string, answer: string, judgeVariant: string): Promise<{ score: number; reason: string } | undefined> {
  const { callAiProviders } = await import("@/lib/ai/provider");
  const r = await callAiProviders(JUDGE_SYSTEM, [{ role: "user", content: `使用者問題：${question}\n\nAI 回答：\n${answer}` }], {
    forceProvider: judgeVariant as "gemini" | "nvidia",
    simpleTask: true,
    maxOutputTokens: 200,
    timeoutMs: 30_000,
  });
  const m = r.answer.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { score: number; reason: string };
    return Number.isFinite(j.score) ? j : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 重新評分（改了 graders／checks 後不用重打模型）
async function regrade(jsonPath: string) {
  const { normalizeZhTw } = await import("@/lib/ai/zhTwNormalize");
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { startedAt: string; variants: string[]; captures: CaseCapture[]; records: EvalRecord[] };
  const cases = EVAL_CASES.filter((c) => data.captures.some((x) => x.caseId === c.id));
  for (const r of data.records) {
    const c = cases.find((x) => x.id === r.caseId);
    const cap = data.captures.find((x) => x.caseId === r.caseId);
    if (!c || !cap?.grounding || !r.ok || r.rawAnswer == null) continue;
    r.checks = gradeAnswer({
      caseDef: c,
      rawAnswer: r.rawAnswer,
      finalAnswer: r.finalAnswer ?? "",
      grounding: cap.grounding,
      zhFixedCount: normalizeZhTw(r.rawAnswer).fixedCount,
      phase: (cap.phase ?? "after-close") as Phase,
    });
  }
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 1));
  const date = path.basename(jsonPath, ".json");
  fs.writeFileSync(jsonPath.replace(/\.json$/, ".md"), renderReport({ date, startedAt: data.startedAt, variants: data.variants, cases, captures: data.captures, records: data.records }));
  log(`重新評分完成：${jsonPath.replace(/\.json$/, ".md")}`);
}

// ---------------------------------------------------------------- 主程式
async function main() {
  const regradePath = arg("regrade");
  if (regradePath) return regrade(regradePath);
  // --compare 前.json 後.json：產生「改前 vs 改後」比較表（輸出到 --out，預設 docs/eval/compare.md）
  const compareIdx = process.argv.indexOf("--compare");
  if (compareIdx >= 0) {
    const [a, b] = [process.argv[compareIdx + 1], process.argv[compareIdx + 2]];
    const load = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as { variants: string[]; records: EvalRecord[] };
    const before = load(a);
    const after = load(b);
    const out = path.join("docs", "eval", `${arg("out") ?? "compare"}.md`);
    fs.writeFileSync(
      out,
      renderComparison({
        title: `評測比較：${path.basename(a, ".json")} → ${path.basename(b, ".json")}`,
        before: { label: path.basename(a, ".json"), records: before.records },
        after: { label: path.basename(b, ".json"), records: after.records },
        variants: after.variants,
      })
    );
    return log(`比較表：${out}`);
  }
  const only = arg("only")?.split(",");
  const variants = arg("variants")?.split(",") ?? DEFAULT_VARIANTS;
  const withJudge = process.argv.includes("--judge");
  const cases = EVAL_CASES.filter((c) => !only || only.includes(c.id));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const outBase = path.join("docs", "eval", arg("out") ?? date);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });

  const records: EvalRecord[] = [];
  const captures: CaseCapture[] = [];
  const startedAt = new Date().toISOString();
  log(`評測 ${cases.length} 題 × ${variants.join("／")}${withJudge ? "（含 LLM 評審）" : ""}`);

  // 下一題的參考資料在這一題呼叫模型時先組（兩者互不干擾：強制呼叫不會被攔截）。
  let nextCapture = cases[0] ? captureCase(cases[0]) : undefined;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const t0 = performance.now();
    const cap = await (nextCapture ?? captureCase(c));
    // 下一題有假時鐘就不要跟這一題的模型呼叫重疊（假時鐘是全域的，會打亂逾時計算）。
    const next = cases[i + 1];
    nextCapture = next && !next.clock ? sleep(1000).then(() => captureCase(next)) : undefined;
    if ("error" in cap) {
      log(`[${i + 1}/${cases.length}] ${c.id}：組參考資料失敗 ${cap.error}`);
      captures.push({ caseId: c.id, error: cap.error });
      continue;
    }
    captures.push({
      caseId: c.id,
      phase: cap.phase,
      systemChars: cap.system.length,
      userChars: cap.messages.reduce((n, m) => n + m.content.length, 0),
      grounding: cap.grounding,
    });
    const results = await Promise.all(
      variants.map(async (v) => {
        const s = performance.now();
        const r = await callVariant(v, cap);
        const latencyMs = Math.round(performance.now() - s);
        if ("error" in r) return { caseId: c.id, variant: v, ok: false, latencyMs, failure: r.error, checks: [] } satisfies EvalRecord;
        const pp = await postProcess(r.text, cap.grounding, (issues) => regenerateWith(v, cap, r.text, issues));
        const checks = gradeAnswer({
          caseDef: c,
          rawAnswer: r.text,
          finalAnswer: pp.final,
          grounding: cap.grounding,
          zhFixedCount: pp.zhFixed,
          phase: cap.phase,
        });
        return {
          caseId: c.id,
          variant: v,
          model: r.model,
          ok: true,
          latencyMs,
          rawAnswer: r.text,
          finalAnswer: pp.final,
          checks,
          ...(pp.outcome && pp.outcome !== "ok" ? { postCheck: { outcome: pp.outcome, issues: pp.issues ?? [] } } : {}),
        } satisfies EvalRecord;
      })
    );
    records.push(...results);
    const line = results
      .map((r) => (r.ok ? `${r.variant} ${r.checks.filter((x) => x.pass).length}/${r.checks.length}` : `${r.variant} ✗`))
      .join("｜");
    log(`[${i + 1}/${cases.length}] ${c.id}（${Math.round((performance.now() - t0) / 1000)}s）${line}`);
    fs.writeFileSync(`${outBase}.json`, JSON.stringify({ startedAt, variants, captures, records }, null, 1));
    await sleep(CASE_GAP_MS);
  }

  if (withJudge) {
    log("LLM 評審中…");
    for (const r of records) {
      if (!r.ok || !r.finalAnswer) continue;
      // 不讓模型評自己：Gemini 系列的回答交給 NVIDIA 評，其他交給 Gemini 評。
      // --judge-with nvidia：全部交給 NVIDIA 評（省 Gemini 額度；NVIDIA 自評有偏差，只當參考）。
      const judgeWith = arg("judge-with") ?? (r.variant.startsWith("gemini") ? "nvidia" : "gemini");
      const q = cases.find((c) => c.id === r.caseId)?.question ?? "";
      r.judge = await judge(q, r.finalAnswer, judgeWith).catch(() => undefined);
      if (r.judge) r.judge = { ...r.judge, by: judgeWith };
      await sleep(4000);
    }
  }

  fs.writeFileSync(`${outBase}.json`, JSON.stringify({ startedAt, variants, captures, records }, null, 1));
  fs.writeFileSync(`${outBase}.md`, renderReport({ date, startedAt, variants, cases, captures, records }));
  log(`完成：${outBase}.md／.json`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
