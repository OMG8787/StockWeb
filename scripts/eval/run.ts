/**
 * 跨模型 AI 品質評測執行器（說明見 scripts/eval/README.md）：
 *   npx tsx scripts/eval/run.ts                       # 全部題目 × 預設模型組
 *   npx tsx scripts/eval/run.ts --only buy-twse,compare-tw
 *   npx tsx scripts/eval/run.ts --variants gemini,nvidia --judge
 * 組參考資料、呼叫模型、後處理、評審等共用函式在 runtime.ts（四入口比較 entries.ts 也用）。
 */
import fs from "node:fs";
import path from "node:path";
import { EVAL_CASES } from "./cases";
import { gradeAnswer, type Phase } from "./graders";
import { renderComparison, renderReport, type CaseCapture, type EvalRecord } from "./report";
import {
  CASE_GAP_MS,
  DEFAULT_VARIANTS,
  arg,
  callVariant,
  captureCase,
  judge,
  log,
  postProcess,
  regenerateWith,
  sleep,
} from "./runtime";

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
