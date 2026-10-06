/**
 * 跨入口一致性評測（2026-10-06 整合稽核；程式比對、不呼叫任何 AI、不讀 .env.local）。
 *
 * 同一檔股票經不同入口組出來的參考資料（AI 實際看到的那一份），本站綜合評等那一行必須逐字相同：
 *  - AI 問答個股題（「X 可以買嗎？」）
 *  - 個股頁「問AI關於」（contextSymbol）
 *  - 關注清單深度分析（未持有）
 *  - 持有中（帶成本）：個股題 vs「持股要賣哪些」輕量清單——「已持有」結論要相同
 *  - 今日建議程式名單（buildActionGrounding；該檔在名單／體檢表時）
 * 用正式的 answerQuestion() 組參考資料，評測攔截鉤子擋下所有 AI 呼叫（含 AI 判斷層），所以零額度、零花費。
 * 不讀 .env.local：沒有 Redis，評等紀錄與快取只在記憶體，不會寫進正式站資料。
 *
 * 用法：npx tsx scripts/eval/consistency.ts [--symbols 2330,3044] [--cost 2330=900]
 * 會打證交所／櫃買等上游（每檔約 4 次組資料，有記憶體快取），短時間不要重複跑。
 */
import type { HoldingInput } from "@/lib/ai/askTypes";
import { parseProgramRatings } from "./graders";
import { parseLiveQuotes } from "@/lib/ai/livePrice";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const log = (s: string) => process.stdout.write(`${s}\n`);

/** 參考資料裡某檔完整的評等行（含理由與價位），沒有回 null。 */
function ratingLine(grounding: string, symbol: string): string | null {
  const re = new RegExp(`【本站綜合評等】[^\\n【]*\\(${symbol.replace(/\./g, "\\.")}\\)：[^\\n]*`);
  return grounding.match(re)?.[0] ?? null;
}

async function capture(question: string, opts: { contextSymbol?: string; holdings?: HoldingInput[] } = {}): Promise<string> {
  const { setAiEvalInterceptor } = await import("@/lib/ai/provider");
  const { SYSTEM_ROLE } = await import("@/lib/ai/askSystemPrompt");
  const { answerQuestion } = await import("@/lib/ai/ask");
  let grounding = "";
  setAiEvalInterceptor((system, messages) => {
    if (system.startsWith(SYSTEM_ROLE)) {
      const user = messages[messages.length - 1]?.content ?? "";
      grounding = user.match(/^參考資料：\n([\s\S]*)\n\n使用者問題：/)?.[1] ?? "";
    }
    // 一律擋下（含 AI 判斷層、新聞分類）：這支只比對程式組出來的資料。
    return { answer: "", usedAi: false, failureReason: "consistency capture" };
  });
  try {
    await answerQuestion(question, opts.contextSymbol, [], opts.holdings ?? []);
  } finally {
    setAiEvalInterceptor(undefined);
  }
  return grounding;
}

async function main() {
  const symbols = (arg("symbols") ?? "2330,3044").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const costs = new Map(
    (arg("cost") ?? "")
      .split(",")
      .filter(Boolean)
      .map((kv) => kv.split("=") as [string, string])
      .map(([s, c]) => [s.toUpperCase(), Number(c)])
  );
  const { getStockRating } = await import("@/lib/ai/stockRating");
  const { buildActionGrounding } = await import("@/lib/ai/actionGrounding");
  let fails = 0;
  const check = (title: string, pass: boolean, detail = "") => {
    if (!pass) fails++;
    log(`${pass ? "✅" : "❌"} ${title}${detail ? `：${detail}` : ""}`);
  };

  const action = await buildActionGrounding().catch(() => null);
  for (const sym of symbols) {
    const r = await getStockRating(sym);
    if (!r) {
      check(`${sym} 取得評等`, false, "抓不到資料");
      continue;
    }
    log(`\n## ${r.name}(${r.symbol})：${r.rating.label}`);
    const holding: HoldingInput = { symbol: r.symbol, market: r.market, name: r.name };
    const entries: Array<[string, string]> = [
      ["AI問答個股題", await capture(`${r.name}可以買嗎？`)],
      ["問AI關於", await capture(`請完整分析${r.name}(${r.symbol})`, { contextSymbol: r.symbol })],
      ["關注清單深度分析（未持有）", await capture("幫我分析我的關注清單", { holdings: [holding] })],
    ];
    if (action && action.text.includes(`(${r.symbol})`)) entries.push(["今日建議程式名單", action.text]);
    const lines = entries.map(([name, g]) => [name, ratingLine(g, r.symbol)] as const);
    const base = lines[0][1];
    for (const [name, line] of lines) check(`${name} 評等行與 AI 問答個股題相同`, !!line && line === base, line ? (line === base ? "" : line.slice(0, 120)) : "參考資料沒有這檔的評等行");

    // 現價（2026-10-07）：三個 AI 入口的【即時報價】片段要逐字相同；今日建議卡用同一個 getQuote＋formatLiveQuote（actionBrief.ts）。
    const livePrices = entries.slice(0, 3).map(([name, g]) => [name, parseLiveQuotes(g).get(r.symbol)?.text ?? null] as const);
    for (const [name, text] of livePrices) check(`${name} 現價片段與 AI 問答個股題相同`, !!text && text === livePrices[0][1], text ?? "參考資料沒有這檔的即時報價行");

    const cost = costs.get(r.symbol) ?? Math.round(r.price * 1.1 * 100) / 100;
    const held: HoldingInput = { ...holding, costBasis: cost, shares: 1000 };
    const heldAsk = parseProgramRatings(await capture(`${r.name}要賣嗎？`, { holdings: [held] })).get(r.symbol)?.held;
    const heldList = parseProgramRatings(await capture("我的持股要賣哪些？", { holdings: [held] })).get(r.symbol)?.held;
    check(`持有中（成本 ${cost}）個股題與「賣哪些」清單的已持有結論相同`, !!heldAsk && heldAsk === heldList, `${heldAsk ?? "無"} vs ${heldList ?? "無"}`);
  }
  log(`\n結果：${fails === 0 ? "全部一致" : `${fails} 項不一致`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();
