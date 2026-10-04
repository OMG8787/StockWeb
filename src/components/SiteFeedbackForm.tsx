"use client";

import { useState } from "react";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { FEEDBACK_SEND_FAILED_TEXT, postFeedback } from "@/lib/feedbackClient";

/** 跟 /api/ask-feedback 的 MAX_REPORT 一致 */
const SITE_REPORT_MAX_CHARS = 1000;

/**
 * AI 問答面板裡的「🛠 回報網站問題／建議」（2026-10-04 使用者要求）：跟每則 AI 回答下方的
 * 📝回報不同，這裡可以回報整個網站任何地方要修正、改進或優化的內容。可以打字或🎤語音
 * （共用 lib/useVoiceInput）。送出時自動附上「目前所在頁面」，方便開發者對照查證。
 * 存進同一個 Redis list（/api/ask-feedback，rating＝site），開發者用 scripts/check-feedback.py 讀。
 */
export default function SiteFeedbackForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const { listening, voiceError, toggleVoiceInput, clearVoiceError } = useVoiceInput({
    input: text,
    setInput: (v) => setText(v.slice(0, SITE_REPORT_MAX_CHARS)),
    active: !sent,
  });

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || sending) return;
    setSending(true);
    setSendError(null);
    const page = `${window.location.pathname}${window.location.search}`;
    const ok = await postFeedback({ rating: "site", reason: text.trim(), page });
    setSending(false);
    if (ok) setSent(true);
    else setSendError(FEEDBACK_SEND_FAILED_TEXT);
  }

  if (sent) {
    return (
      <div className="border-b border-(--gridline) bg-(--accent-soft) px-4 py-2 text-xs" role="status">
        🛠 已收到你的網站回報，謝謝！
        <button type="button" onClick={onClose} className="ml-2 text-(--accent) hover:underline">
          關閉
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-1 border-b border-(--gridline) bg-(--surface-2) px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-xs font-medium">🛠 回報網站問題或建議</p>
      <p className="text-[11px] text-(--text-muted)">
        整個網站任何地方都可以：哪裡壞了、數字怪怪的、想新增或改進什麼功能。會自動附上你目前所在的頁面。
      </p>
      {(listening || voiceError) && (
        <p className={`text-[11px] font-medium ${listening ? "text-(--accent)" : "text-(--price-up)"}`} role="status">
          {listening ? "🎤 聆聽中…請說話" : `⚠️ ${voiceError}`}
        </p>
      )}
      <div className="flex items-end gap-1">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (voiceError) clearVoiceError();
          }}
          maxLength={SITE_REPORT_MAX_CHARS}
          rows={2}
          autoFocus
          placeholder="例如：某個按鈕在手機上太小、希望首頁多一個○○功能…（可以打字或按🎤用說的）"
          aria-label="回報網站問題或建議"
          className="min-w-0 flex-1 resize-none rounded border border-(--gridline) bg-(--surface-1) px-2 py-1 text-xs leading-snug focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
        <button
          type="button"
          onClick={toggleVoiceInput}
          aria-label={listening ? "停止語音輸入" : "開始語音輸入"}
          title={listening ? "停止語音輸入" : "語音輸入"}
          className={`shrink-0 rounded px-2 py-1 text-xs ${
            listening ? "animate-pulse bg-(--price-up) text-white" : "border border-(--gridline) bg-(--surface-1) hover:bg-(--page-plane)"
          }`}
        >
          {listening ? "⏹" : "🎤"}
        </button>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button type="button" onClick={onClose} className="rounded px-1 py-1 text-xs text-(--text-muted) hover:text-(--text-primary)">
          取消
        </button>
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="rounded bg-(--accent) px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {sending ? "送出中…" : "送出回報"}
        </button>
      </div>
      {sendError && (
        <p className="text-[11px] font-medium text-(--price-up)" role="alert">
          ⚠️ {sendError}
        </p>
      )}
    </form>
  );
}
