"use client";

import { useState } from "react";
import { useVoiceInput } from "@/lib/useVoiceInput";

type Phase = "idle" | "asking-reason" | "reporting" | "done";
type Rating = "up" | "down" | "report";

const DONE_TEXT: Record<Rating, string> = {
  up: "👍 已回饋，謝謝",
  down: "👎 已回饋，謝謝",
  report: "📝 已收到你的回報，謝謝",
};

/** 「回報問題／建議」最多幾個字（跟 /api/ask-feedback 的 MAX_REPORT 一致）。 */
const REPORT_MAX_CHARS = 1000;

/**
 * 每則 AI 回答下方的 👍／👎／📝回報。只有使用者真的按了才會 POST /api/ask-feedback；
 * 送出後鎖定（同一則不能重複送）。送出失敗（網路/無 Redis）一律安靜吞掉、仍顯示已回饋，
 * 因為這只是給開發者的參考資料，不值得打斷使用者。
 *
 * 📝回報（2026-10-04 使用者要求）：比 👎 的一句原因更完整，可以自由描述問題或建議，
 * 跟聊天輸入框一樣支援打字與🎤語音輸入（共用 lib/useVoiceInput）。
 */
export default function AnswerFeedback({ question, answer, symbol }: { question: string; answer: string; symbol?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rating, setRating] = useState<Rating | null>(null);
  const [reason, setReason] = useState("");
  const [report, setReport] = useState("");
  const { listening, voiceError, toggleVoiceInput, clearVoiceError } = useVoiceInput({
    input: report,
    setInput: (v) => setReport(v.slice(0, REPORT_MAX_CHARS)),
    active: phase === "reporting",
  });

  function submit(r: Rating, why?: string) {
    setRating(r);
    setPhase("done");
    fetch("/api/ask-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: r, question, answer, reason: why?.trim() || undefined, symbol, at: new Date().toISOString() }),
    }).catch(() => {});
  }

  if (phase === "done" && rating) {
    return (
      <p className="mt-1 text-[11px] text-(--text-muted)" role="status">
        {DONE_TEXT[rating]}
      </p>
    );
  }

  if (phase === "reporting") {
    return (
      <form
        className="mt-1 space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (report.trim()) submit("report", report);
        }}
      >
        {(listening || voiceError) && (
          <p className={`text-[11px] font-medium ${listening ? "text-(--accent)" : "text-(--price-up)"}`} role="status">
            {listening ? "🎤 聆聽中…請說話" : `⚠️ ${voiceError}`}
          </p>
        )}
        <div className="flex items-end gap-1">
          <textarea
            value={report}
            onChange={(e) => {
              setReport(e.target.value);
              if (voiceError) clearVoiceError();
            }}
            maxLength={REPORT_MAX_CHARS}
            rows={3}
            autoFocus
            placeholder="這則回答有什麼問題，或你有什麼建議？可以打字或按🎤用說的"
            aria-label="回報問題或建議"
            className="min-w-0 flex-1 resize-none rounded border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs leading-snug focus:outline-none focus:ring-1 focus:ring-(--accent)"
          />
          <button
            type="button"
            onClick={toggleVoiceInput}
            aria-label={listening ? "停止語音輸入" : "開始語音輸入"}
            title={listening ? "停止語音輸入" : "語音輸入"}
            className={`shrink-0 rounded px-2 py-1 text-xs ${
              listening ? "animate-pulse bg-(--price-up) text-white" : "border border-(--gridline) bg-(--surface-2) hover:bg-(--page-plane)"
            }`}
          >
            {listening ? "⏹" : "🎤"}
          </button>
        </div>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setReport("");
            }}
            className="rounded px-1 py-1 text-xs text-(--text-muted) hover:text-(--text-primary)"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!report.trim()}
            className="rounded bg-(--accent) px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            送出回報
          </button>
        </div>
      </form>
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
      <button
        type="button"
        onClick={() => setPhase("reporting")}
        aria-label="回報問題或建議"
        title="回報問題或建議（可打字或語音）"
        className="rounded px-1.5 py-0.5 text-(--text-muted) hover:bg-(--page-plane) hover:text-(--text-primary)"
      >
        📝 回報
      </button>
    </div>
  );
}
