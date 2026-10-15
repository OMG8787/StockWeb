"use client";

import ManualView from "@/components/help/ManualView";
import { HELP_OPEN_EVENT, type HelpOpenDetail } from "@/lib/chatEvents";

/** 操作手冊整頁版（內容同教學助手的「📖 操作手冊」分頁，來源 lib/help/manual.ts） */
export default function HelpClient() {
  const openAssistant = () => window.dispatchEvent(new CustomEvent<HelpOpenDetail>(HELP_OPEN_EVENT, { detail: { view: "ask" } }));
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-16">
      <div>
        <h1 className="text-xl font-semibold">📖 操作手冊</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">
          每個功能在哪裡、怎麼用、畫面上的名詞是什麼意思。可以用搜尋框找，或點章節展開；章節底下的按鈕直接帶你到那個功能。
        </p>
        <button
          type="button"
          onClick={openAssistant}
          className="mt-2 rounded-md border border-(--accent) bg-(--accent-soft) px-3 py-1.5 text-sm font-medium text-(--text-primary) hover:opacity-90"
        >
          🎓 找不到？問教學助手
        </button>
      </div>
      <ManualView />
    </div>
  );
}
