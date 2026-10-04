"use client";

import { useState } from "react";

type Phase = "idle" | "asking-reason" | "done";

/**
 * 每則 AI 回答下方的 👍／👎。只有使用者真的按了才會 POST /api/ask-feedback；
 * 送出後鎖定（同一則不能重複送）。送出失敗（網路/無 Redis）一律安靜吞掉、仍顯示已回饋，
 * 因為這只是給開發者的參考資料，不值得打斷使用者。
 */
export default function AnswerFeedback({ question, answer, symbol }: { question: string; answer: string; symbol?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState("");

  function submit(r: "up" | "down", why?: string) {
    setRating(r);
    setPhase("done");
    fetch("/api/ask-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: r, question, answer, reason: why?.trim() || undefined, symbol, at: new Date().toISOString() }),
    }).catch(() => {});
  }

  if (phase === "done") {
    return (
      <p className="mt-1 text-[11px] text-(--text-muted)" role="status">
        {rating === "up" ? "👍" : "👎"} 已回饋，謝謝
      </p>
    );
  }

  if (phase === "asking-reason") {
    return (
      <form
        className="mt-1 flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit("down", reason);
        }}
      >
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          autoFocus
          placeholder="哪裡不好？（可略過）"
          aria-label="不滿意的原因（選填）"
          className="min-w-0 flex-1 rounded border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
        <button type="submit" className="shrink-0 rounded bg-(--accent) px-2 py-1 text-xs font-medium text-white">
          送出
        </button>
        <button
          type="button"
          onClick={() => submit("down")}
          className="shrink-0 rounded px-1 py-1 text-xs text-(--text-muted) hover:text-(--text-primary)"
        >
          略過
        </button>
      </form>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={() => submit("up")}
        aria-label="這則回答有幫助"
        title="有幫助"
        className="rounded px-1.5 py-0.5 hover:bg-(--page-plane)"
      >
        👍
      </button>
      <button
        type="button"
        onClick={() => setPhase("asking-reason")}
        aria-label="這則回答沒幫助"
        title="沒幫助"
        className="rounded px-1.5 py-0.5 hover:bg-(--page-plane)"
      >
        👎
      </button>
    </div>
  );
}
