import { NextRequest, NextResponse } from "next/server";
import { answerQuestion, type HoldingInput } from "@/lib/ai/ask";
import type { ChatTurn } from "@/lib/ai/types";
import { recordModelEvent } from "@/lib/ai/modelStats";

// Default Node function budget isn't enough for the "分析我的關注清單" path:
// that fans out a full buildStockGrounding() (quote+chart+chips+fundamentals+
// earnings+news, several sub-fetches each) per holding, then a longer AI
// call to actually write a per-stock analysis — see ask.ts's
// HOLDINGS_ANALYSIS_INTENT_PATTERN branch for the fuller reasoning.
export const maxDuration = 60;

const MAX_HISTORY_TURNS = 10;
const MAX_TURN_LENGTH = 2000;
const MAX_HOLDINGS = 50;

// Mirrors the client's localStorage WatchlistItem shape, but this is
// unvalidated request input (anyone can POST here, not just the chat
// widget), so every field is re-checked rather than trusted as typed.
function parseHoldings(raw: unknown): HoldingInput[] {
  if (!Array.isArray(raw)) return [];
  const holdings: HoldingInput[] = [];
  for (const entry of raw.slice(0, MAX_HOLDINGS)) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.symbol === "string" &&
      entry.symbol.length > 0 &&
      entry.symbol.length <= 20 &&
      (entry.market === "TW" || entry.market === "US") &&
      typeof entry.name === "string"
    ) {
      const costBasis = typeof entry.costBasis === "number" && Number.isFinite(entry.costBasis) && entry.costBasis >= 0 ? entry.costBasis : undefined;
      const shares = typeof entry.shares === "number" && Number.isFinite(entry.shares) && entry.shares >= 0 ? entry.shares : undefined;
      holdings.push({ symbol: entry.symbol, market: entry.market, name: entry.name.slice(0, 100), costBasis, shares });
    }
  }
  return holdings;
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of raw.slice(-MAX_HISTORY_TURNS)) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry.role === "user" || entry.role === "assistant") &&
      typeof entry.content === "string" &&
      entry.content.trim()
    ) {
      turns.push({ role: entry.role, content: entry.content.slice(0, MAX_TURN_LENGTH) });
    }
  }
  return turns;
}

export async function POST(req: NextRequest) {
  // `unknown` rather than a declared shape: this is unvalidated request
  // input, and typing it as strings up front invites trusting it as such.
  let body: { question?: unknown; symbol?: unknown; history?: unknown; holdings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "問題不可為空" }, { status: 400 });
  }
  if (question.length > 500) {
    return NextResponse.json({ error: "問題過長，請控制在 500 字以內" }, { status: 400 });
  }

  // `symbol` becomes a cache key and a fetch target, so only a plausible
  // ticker is accepted — anything else is treated as no symbol at all
  // rather than passed down and coerced into a garbage lookup.
  const symbol =
    typeof body.symbol === "string" && /^[A-Za-z0-9.^-]{1,12}$/.test(body.symbol.trim())
      ? body.symbol.trim()
      : undefined;

  const history = parseHistory(body.history);
  const holdings = parseHoldings(body.holdings);
  try {
    const result = await answerQuestion(question, symbol, history, holdings);
    // 各模型回答數（成績看板「各模型」，modelStats.ts）。
    recordModelEvent(result.model?.id, result.usedAi ? "answer" : "fallback");
    return NextResponse.json(result);
  } catch (err) {
    // The widget renders `data.error` on a non-OK response; without this an
    // unexpected throw became an HTML error page and the chat bubble showed
    // a JSON parse failure instead of anything a reader could act on.
    console.error("[ask] answerQuestion failed:", err);
    return NextResponse.json({ error: "AI 問答暫時無法使用，請稍後再試" }, { status: 503 });
  }
}
