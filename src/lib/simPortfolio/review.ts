import { callAiProviders } from "@/lib/ai/provider";
import { modelInfo } from "@/lib/ai/modelName";
import { RULE_ZH_TW_ONLY } from "@/lib/ai/compactRules";
import { LEARNING_KEY_PREFIX } from "@/lib/ai/learning/learningStore";
import { redis } from "@/lib/data/kv";
import { sellFee, type SimPerformance } from "./rules";
import type { SimReview, SimState } from "./types";

/**
 * AI 模擬投資組合的每日收盤後檢討（13:35 時點跑完交易後一次，一天一次 AI 呼叫，用預設 lite 等級、不吃較強模型配額）。
 * 「做了什麼、為什麼、哪筆錯了」的事實（交易、評等理由、已實現獎勵、未實現損益）全部由程式先整理好（buildReviewFacts），
 * AI 只負責把它寫成白話並指出問題；AI 失敗就用程式版（同一份事實）。
 * 完整檢討另存進學習紀錄命名空間 `learning:v1:sim-review:{日期}`（永久，不設過期），跟評等紀錄、獎勵同一套學習架構；
 * 交易本身的評等也以 source＝sim-portfolio 記進評等紀錄，由每日學習工作算 1／5／20 日獎勵。
 */

/** 檢討的學習紀錄 key。 */
export function simReviewKey(day: string): string {
  return `${LEARNING_KEY_PREFIX}sim-review:${day}`;
}
/** 未實現虧損超過這個百分比（已扣賣出成本）就列為「可能判斷錯誤」要檢討。 */
export const SIM_REVIEW_LOSS_FLAG_PCT = 5;
/** 檢討帶入最近幾筆已平倉交易。 */
const SIM_REVIEW_RECENT_SELLS = 6;

const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`);
const fmtNt = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(Math.round(v)).toLocaleString("en-US")} 元`;

/** 程式整理的檢討事實（AI 的參考資料，也是 AI 失敗時的程式版內容）。 */
export function buildReviewFacts(state: SimState, perf: SimPerformance, prices: Map<string, number>, day: string): string {
  const today = state.trades.filter((t) => t.day === day);
  const lines: string[] = [];
  lines.push(
    `【成效】淨值 ${fmtNt(perf.nav)}（初始 ${fmtNt(state.initialCapital)}），累計 ${fmtPct(perf.totalReturnPct)}、今日 ${fmtPct(perf.dayReturnPct)}；同期 0050 ${fmtPct(perf.etfReturnPct)}、加權指數 ${fmtPct(perf.indexReturnPct)}；最大回撤 ${perf.maxDrawdownPct}%；已平倉勝率 ${perf.winRatePct == null ? "—（尚無平倉）" : `${perf.winRatePct}%`}。`
  );
  lines.push(
    today.length === 0
      ? "【今日交易】沒有交易（評等沒有觸發買賣條件）。"
      : `【今日交易】\n${today
          .map((t) =>
            t.status === "rejected"
              ? `- ${t.side === "buy" ? "想買" : "想賣"} ${t.name}(${t.symbol}) ${t.shares.toLocaleString("en-US")} 股，${t.rejectReason ?? "未成交"}（評等「${t.ratingLabel}」）`
              : `- ${t.side === "buy" ? "買進" : "賣出"} ${t.name}(${t.symbol}) ${t.shares.toLocaleString("en-US")} 股 @ ${t.price}（評等「${t.ratingLabel}」；理由：${t.reason}${t.basis ? `；成交依據：${t.basis}` : ""}）${
                  t.side === "sell" ? `，已實現 ${fmtNt(t.realized ?? 0)}（${fmtPct(t.realizedPct)}，同期大盤 ${fmtPct(t.indexPct)}，獎勵 ${fmtPct(t.reward)}）` : ""
                }`
          )
          .join("\n")}`
  );
  if (state.holdings.length > 0) {
    lines.push(
      `【持股（未實現，已扣假設賣出成本）】\n${state.holdings
        .map((h) => {
          const p = prices.get(h.symbol) ?? h.avgCost;
          const pnl = Math.round(p * h.shares) - sellFee(p, h.shares) - h.invested;
          const pct = h.invested > 0 ? Math.round((pnl / h.invested) * 10000) / 100 : 0;
          const flag = pct <= -SIM_REVIEW_LOSS_FLAG_PCT ? "（虧損超過門檻，需檢討）" : "";
          return `- ${h.name}(${h.symbol}) ${h.shares.toLocaleString("en-US")} 股，成本 ${h.avgCost}、現價 ${p}，${fmtNt(pnl)}（${fmtPct(pct)}）${flag}；持有中評等「${h.lastLabel ?? "—"}」；持有中出場價 ${h.stopPrice ?? "—"}`;
        })
        .join("\n")}`
    );
  } else lines.push("【持股】目前空手（全部現金）。");
  const sells = state.trades.filter((t) => t.side === "sell" && t.status !== "rejected").slice(0, SIM_REVIEW_RECENT_SELLS);
  if (sells.length > 0) {
    lines.push(
      `【最近已平倉（獎勵＝扣成本報酬−同期大盤，負的是判斷錯誤）】\n${sells
        .map((t) => `- ${t.day} ${t.name}(${t.symbol}) ${fmtPct(t.realizedPct)}，大盤 ${fmtPct(t.indexPct)}，獎勵 ${fmtPct(t.reward)}；賣出原因：${t.reason}`)
        .join("\n")}`
    );
  }
  return lines.join("\n");
}

const SIM_REVIEW_SYSTEM = [
  "你是股票研究網站「AI 模擬投資組合」的每日檢討撰稿人。這個組合的買賣全部由網站程式依「本站綜合評等」決定，你不能改變或追加任何買賣，只負責檢討。",
  "只能根據參考資料裡的數字與理由寫，不可編造數字、新聞或名單外的股票；數字照抄。",
  "輸出 3 段，每段 1~2 句，總長 ≤220 字，用「今天做了什麼：」「為什麼：」「哪裡做錯／要改進：」開頭：",
  "- 今天做了什麼：買賣了哪些（沒有交易就說沒有、為什麼沒有），以及今天與累計成效相對 0050。",
  "- 為什麼：引用評等理由的關鍵一兩點。",
  "- 哪裡做錯／要改進：點名獎勵為負的已平倉交易、或標「需檢討」的持股，推測可能原因（只能根據資料，例如追高、大盤偏弱、評等理由裡的風險提示）；都沒有就說目前沒有明顯錯誤、要持續觀察什麼。",
  "措辭誠實：這是模擬、樣本很少時不可宣稱策略有效；不要開場白、客套或免責聲明。",
  RULE_ZH_TW_ONLY,
].join("\n");

export async function writeSimReview(state: SimState, perf: SimPerformance, prices: Map<string, number>, day: string, now: Date): Promise<SimReview> {
  const facts = buildReviewFacts(state, perf, prices, day);
  let review: SimReview = { day, at: now.toISOString(), text: `（程式版）\n${facts}`, model: null, usedAi: false };
  try {
    const res = await callAiProviders(SIM_REVIEW_SYSTEM, [{ role: "user", content: `參考資料：\n${facts}` }], {
      timeoutMs: 25_000,
      totalBudgetMs: 35_000,
      maxOutputTokens: 800,
    });
    if (res.usedAi && res.answer.trim()) {
      review = { day, at: now.toISOString(), text: res.answer.trim(), model: modelInfo(res.model)?.name ?? null, usedAi: true };
    }
  } catch (err) {
    console.warn("[sim-portfolio] AI 檢討失敗，用程式版：", err);
  }
  if (redis) {
    await redis
      .set(simReviewKey(day), JSON.stringify({ ...review, facts }))
      .catch((err) => console.warn("[sim-portfolio] 檢討寫入學習紀錄失敗：", err));
  }
  return review;
}
