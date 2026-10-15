import { callAiProviders } from "@/lib/ai/provider";
import { modelInfo, type ModelInfo } from "@/lib/ai/modelName";
import { RULE_ZH_TW_ONLY } from "@/lib/ai/compactRules";
import type { ChatTurn } from "@/lib/ai/types";
import { searchManual } from "./search";
import type { ManualSection } from "./manual";

/**
 * 教學助手回答（2026-10-16 使用者：「教學助手，讓使用者可以提問系統問題」）。
 *
 * 分工（「下限看模型、上限看我們」）：
 *  ① 程式用 searchManual 從操作手冊挑出最相關的章節（找不到就直接回「手冊沒有寫」，連 AI 都不呼叫）；
 *  ② AI 只負責「依這幾個章節的內容，用白話一步一步回答」，不能自己編功能、按鈕或數字；
 *  ③ AI 失敗（額度、逾時）就直接顯示章節內容（程式版），使用者仍然得到答案。
 * 這支跟股票問答（ask.ts）完全分開：不碰行情與評等流程，也不需要「AI 問答」權限，任何登入的帳號都能問。
 */

export const HELP_TOP_SECTIONS = 3;
const MAX_SECTION_CHARS = 1800;
const MAX_QUESTION = 300;

export const HELP_SYSTEM_PROMPT = [
  "你是「股情雷達」網站的教學助手，只負責回答「這個網站怎麼用」。",
  "只能根據使用者訊息裡的【操作手冊章節】回答：章節沒寫的功能、按鈕、數字、規則一律不要編；章節沒有涵蓋時，直接說「操作手冊沒有寫到這部分」，並建議到「📖 操作手冊」分頁搜尋，或用右上方「🛠 回報網站」告訴我們。",
  "回答格式：先一句話講結論，再用 1、2、3 編號列出操作步驟（每步一行，按鈕名稱用章節裡的原字，例如「按 ▶ 立即更新一次」）；全部不超過 250 字；不要重複貼整段章節。",
  "要使用者看更多說明時，說「點回答下方的 📖 按鈕看完整說明」，不要叫使用者去搜尋整串章節標題。",
  "功能、按鈕、頁面名稱一律照章節裡的原字寫（例如「智能清單」不可寫成「智慧清單」）。",
  "使用者問的是個股或行情（例如「2330 該買嗎」）時，告訴他切到「💬 股票問答」分頁問，這裡只教網站操作。",
  "不給投資建議，不預測股價。",
  RULE_ZH_TW_ONLY,
].join("\n");

/**
 * 功能名稱一律用網站上的原字（AI 偶爾會改寫，例如把「智能清單」寫成「智慧清單」，使用者就找不到按鈕）。
 * 程式在 AI 回答後統一更正，不只靠提示詞。
 */
const TERM_FIXES: Array<[RegExp, string]> = [
  [/智慧清單/g, "智能清單"],
  [/智慧名單/g, "智能清單"],
  [/策略資料庫/g, "策略庫"],
  [/推薦概覽/g, "推薦總覽"],
  [/推薦回測/g, "推薦回顧"],
  [/教學小幫手/g, "教學助手"],
  [/操作說明書/g, "操作手冊"],
];
export function fixTerms(text: string): string {
  return TERM_FIXES.reduce((t, [re, to]) => t.replace(re, to), text);
}

export interface HelpAnswer {
  answer: string;
  usedAi: boolean;
  model?: ModelInfo;
  /** 相關的手冊章節（前端顯示「📖 看手冊」按鈕） */
  sections: Array<{ id: string; title: string }>;
}

/** 章節轉成給 AI 的參考資料（太長截斷）。 */
export function sectionsForPrompt(sections: ManualSection[]): string {
  return sections
    .map((s, i) => `【章節 ${i + 1}：${s.title}】\n${s.body.length > MAX_SECTION_CHARS ? `${s.body.slice(0, MAX_SECTION_CHARS)}…` : s.body}${s.links?.length ? `\n（相關頁面：${s.links.map((l) => `${l.label} ${l.href}`).join("、")}）` : ""}`)
    .join("\n\n");
}

/** AI 失敗時的程式版回答：直接用最相關章節的摘要與內容。 */
export function fallbackAnswer(sections: ManualSection[]): string {
  const [first, ...rest] = sections;
  const more = rest.length ? `\n\n其他相關章節：${rest.map((s) => `「${s.title}」`).join("、")}（切到「📖 操作手冊」分頁可看全文）。` : "";
  return `AI 暫時無法整理回答，下面是操作手冊最相關的章節：\n\n**${first.title}**\n${first.summary}\n\n${first.body}${more}`;
}

export const NO_MATCH_ANSWER = [
  "操作手冊裡沒有找到跟這個問題相關的內容。你可以：",
  "- 換個說法再問一次（例如直接寫功能名稱：智能清單、策略回測、即時提醒…）；",
  "- 切到「📖 操作手冊」分頁，用搜尋框或章節列表自己找；",
  "- 如果是在問個股或行情（例如某檔該不該買），請切到「💬 股票問答」；",
  "- 覺得是網站缺少說明或有問題，請按右上方「🛠 回報網站」告訴我們。",
].join("\n");

export async function answerHelpQuestion(question: string, history: ChatTurn[] = []): Promise<HelpAnswer> {
  const q = question.trim().slice(0, MAX_QUESTION);
  const sections = searchManual(q, HELP_TOP_SECTIONS);
  if (sections.length === 0) return { answer: NO_MATCH_ANSWER, usedAi: false, sections: [] };
  const refs = sections.map((s) => ({ id: s.id, title: s.title }));
  try {
    const res = await callAiProviders(
      HELP_SYSTEM_PROMPT,
      [...history.slice(-4), { role: "user", content: `使用者問題：${q}\n\n${sectionsForPrompt(sections)}` }],
      { timeoutMs: 20_000, totalBudgetMs: 30_000, maxOutputTokens: 700 },
    );
    if (res.usedAi && res.answer.trim()) return { answer: fixTerms(res.answer.trim()), usedAi: true, model: modelInfo(res.model), sections: refs };
  } catch (err) {
    console.warn("[help-ask] AI 失敗，改用程式版：", err);
  }
  return { answer: fallbackAnswer(sections), usedAi: false, sections: refs };
}
