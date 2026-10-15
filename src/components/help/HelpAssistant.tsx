"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownLite from "../MarkdownLite";
import AnswerFeedback from "../AnswerFeedback";
import ManualView from "./ManualView";

/**
 * 教學助手（聊天視窗的「🎓 教學助手」分頁）：「問問題」＝問網站怎麼用（/api/help-ask：程式先從操作手冊挑章節，AI 只負責白話回答，
 * AI 失敗直接顯示章節）；「📖 操作手冊」＝自己搜尋、閱讀（同 /help 頁）。回答下方的章節按鈕會跳到手冊那一章。
 * 對話只存在這個視窗（關閉分頁不清掉，重新整理才清）。
 */

interface HelpMessage {
  role: "user" | "assistant";
  text: string;
  isError?: boolean;
  usedAi?: boolean;
  model?: { id: string; name: string };
  sections?: Array<{ id: string; title: string }>;
}

const HELP_SUGGESTIONS = ["怎麼設定智能清單？", "推薦總覽怎麼看？", "怎麼回測一個策略？", "「買＊」是什麼意思？", "為什麼推薦不買、AI 卻持有？"];

export default function HelpAssistant({
  onNavigate,
  canFeedback = false,
  request,
}: {
  onNavigate?: () => void;
  /** 有「AI 問答」權限才顯示 👍／👎／📝（回饋 API 的權限） */
  canFeedback?: boolean;
  /** 外部要求（例如「看手冊」連結）：切到某個分頁、開某一章；n 變了就重新套用 */
  request?: { n: number; view?: "ask" | "manual"; sectionId?: string };
}) {
  const [view, setView] = useState<"ask" | "manual">("ask");
  const [messages, setMessages] = useState<HelpMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [manualOpenId, setManualOpenId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!request) return;
    const t = setTimeout(() => {
      if (request.view) setView(request.view);
      if (request.sectionId) {
        setView("manual");
        setManualOpenId(null);
        setTimeout(() => setManualOpenId(request.sectionId ?? null), 0);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [request]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, loading]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || loading) return;
    const history = messages.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/help-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, history }) });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(res.status === 504 ? "處理逾時，請再問一次" : `伺服器暫時無法回應（${res.status}）`);
      if (!res.ok) throw new Error(data.error ?? "發生錯誤");
      setMessages((m) => [...m, { role: "assistant", text: data.answer, usedAi: data.usedAi, model: data.model, sections: data.sections }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `抱歉，發生錯誤：${(err as Error).message}。可以先切到「📖 操作手冊」自己查。`, isError: true }]);
    } finally {
      setLoading(false);
    }
  }

  const tab = (id: "ask" | "manual", label: string) => (
    <button
      type="button"
      onClick={() => setView(id)}
      className={`flex-1 rounded-md px-2 py-1 text-xs ${view === id ? "bg-(--accent) font-semibold text-white" : "border border-(--gridline) text-(--text-secondary) hover:bg-(--page-plane)"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2 border-b border-(--gridline) px-3 py-2">
        {tab("ask", "❓ 問問題")}
        {tab("manual", "📖 操作手冊")}
      </div>

      {view === "manual" ? (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <ManualView openId={manualOpenId} compact onNavigate={onNavigate} />
          <p className="mt-3 text-[11px] text-(--text-muted)">
            想用整頁閱讀：<a href="/help" className="text-(--accent) underline" onClick={onNavigate}>開啟完整操作手冊</a>
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-xs text-(--text-secondary)">我是教學助手，可以回答「這個網站怎麼用」（不是個股行情，那個請到「💬 股票問答」）。試試看：</p>
                {HELP_SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="block w-full rounded-md border border-(--gridline) px-3 py-2 text-left text-xs hover:bg-(--page-plane)">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[90%]">
                  <div className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-(--accent) text-white" : "bg-(--page-plane) text-(--text-primary)"}`}>
                    {m.role === "assistant" ? <MarkdownLite text={m.text} /> : <p className="whitespace-pre-wrap">{m.text}</p>}
                  </div>
                  {m.role === "assistant" && !m.isError && (
                    <p className="mt-0.5 text-[11px] text-(--text-muted)">{m.usedAi && m.model ? `由 ${m.model.name} 依操作手冊回答` : "依操作手冊整理（程式版）"}</p>
                  )}
                  {m.role === "assistant" && m.sections && m.sections.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.sections.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => {
                            setManualOpenId(null);
                            setTimeout(() => setManualOpenId(s.id), 0);
                            setView("manual");
                          }}
                          className="rounded-full border border-(--gridline) px-2 py-0.5 text-[11px] text-(--accent) hover:bg-(--page-plane)"
                          title="在操作手冊裡開啟這一章"
                        >
                          📖 {s.title.replace(/[：:（(].*$/, "")}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && !m.isError && canFeedback && (
                    <AnswerFeedback question={`【教學助手】${messages[i - 1]?.text ?? ""}`} answer={m.text} model={m.model?.id} />
                  )}
                </div>
              </div>
            ))}
            {loading && <p className="text-xs text-(--text-muted)">查手冊中…</p>}
            <div ref={bottomRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2 border-t border-(--gridline) p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="問網站怎麼用，例如：怎麼設定提醒？"
              maxLength={300}
              className="min-w-0 flex-1 rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-(--accent)"
            />
            <button type="submit" disabled={loading || !input.trim()} className="shrink-0 rounded-md bg-(--accent) px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              送出
            </button>
          </form>
        </>
      )}
    </div>
  );
}
