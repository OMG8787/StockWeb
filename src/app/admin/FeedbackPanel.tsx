"use client";

import { useCallback, useEffect, useState } from "react";
import { btnGhost, btnPrimary, inputCls, sendJson } from "@/components/auth/ui";

/** /api/ask-feedback 回傳的一筆（欄位見 lib/feedbackStore.ts 的 FeedbackView） */
interface FeedbackItem {
  id: string;
  rating: "up" | "down" | "report" | "site";
  question: string;
  answer: string;
  reason?: string;
  symbol?: string;
  model?: string;
  page?: string;
  account?: string;
  name?: string;
  date: string;
  atTaipei: string;
  status: "待處理" | "已完成" | "不處理";
  confirm: "未確認" | "已確認" | "需重改";
  resolveNote: string;
  resolvedAt: string;
  confirmedBy: string;
  confirmedAt: string;
  adminNote: string;
}

type View = "open" | "review" | "confirmed" | "all";

const VIEWS: Array<[View, string]> = [
  ["open", "待處理"],
  ["review", "已處理待確認"],
  ["confirmed", "已確認"],
  ["all", "全部"],
];

const RATING_LABEL: Record<FeedbackItem["rating"], string> = {
  up: "👍 好評",
  down: "👎 差評",
  report: "📝 回報",
  site: "🛠 網站回報",
};

const STATUSES: FeedbackItem["status"][] = ["待處理", "已完成", "不處理"];

function badge(item: FeedbackItem): { text: string; cls: string } {
  if (item.confirm === "已確認") return { text: "✅ 已確認", cls: "border-(--price-down) text-(--price-down)" };
  if (item.confirm === "需重改") return { text: "↩️ 退回重改", cls: "border-(--price-up) text-(--price-up)" };
  if (item.status === "已完成") return { text: "🔧 已完成・待確認", cls: "border-(--accent) text-(--accent)" };
  if (item.status === "不處理") return { text: "不處理・待確認", cls: "border-(--gridline) text-(--text-muted)" };
  return { text: "⏳ 待處理", cls: "border-(--gridline) text-(--text-secondary)" };
}

export default function FeedbackPanel() {
  const [view, setView] = useState<View>("open");
  const [hideUp, setHideUp] = useState(true);
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ask-feedback?limit=300&view=${view}`, { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "載入失敗");
      setItems(d.items);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [view]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const shown = (items ?? []).filter((x) => !hideUp || x.rating !== "up");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`${btnGhost} text-xs ${view === id ? "!border-(--accent) font-semibold" : ""}`}
          >
            {label}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1 text-xs text-(--text-muted)">
          <input type="checkbox" checked={hideUp} onChange={(e) => setHideUp(e.target.checked)} />
          不顯示 👍 好評
        </label>
        <span className="ml-auto text-xs text-(--text-muted)">{items ? `${shown.length} 筆` : ""}</span>
      </div>
      <p className="text-xs text-(--text-muted)">
        流程：新回饋＝待處理 → 程式修改後標「已完成」並寫處理說明 → 管理員確認，或退回重改（回到待處理）。也可以直接在試算表 Feedback 分頁修改。
      </p>
      {error && <p className="text-sm text-(--price-up)">⚠️ {error}</p>}
      {!items && !error && <p className="text-sm text-(--text-muted)">載入中…</p>}
      {items && shown.length === 0 && <p className="text-sm text-(--text-muted)">沒有符合的回饋</p>}
      {shown.map((item) => (
        <FeedbackCard key={`${item.id}:${item.status}:${item.confirm}:${item.resolveNote}:${item.adminNote}`} item={item} onChanged={load} />
      ))}
    </div>
  );
}

function FeedbackCard({ item, onChanged }: { item: FeedbackItem; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(item.status);
  const [resolveNote, setResolveNote] = useState(item.resolveNote);
  const [adminNote, setAdminNote] = useState(item.adminNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const b = badge(item);
  const dirty = status !== item.status || resolveNote !== item.resolveNote || adminNote !== item.adminNote;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/ask-feedback", { id: item.id, ...body }, "PATCH");
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-(--text-muted)">{item.date}</span>
        <span className="text-xs text-(--text-muted)">{item.atTaipei.slice(11, 16)}</span>
        <span className="font-medium">{RATING_LABEL[item.rating]}</span>
        <span className="text-xs text-(--text-secondary)">
          {item.name || "—"}
          {item.account && `（${item.account}）`}
        </span>
        {item.symbol && <span className="rounded bg-(--page-plane) px-1.5 text-xs">{item.symbol}</span>}
        {item.page && <span className="rounded bg-(--page-plane) px-1.5 text-xs">{item.page}</span>}
        <span className={`ml-auto rounded border px-2 py-0.5 text-xs ${b.cls}`}>{b.text}</span>
      </div>

      {item.reason && <p className="mt-2 whitespace-pre-wrap">💬 {item.reason}</p>}
      {(item.question || item.answer) && (
        <button type="button" className="mt-1 text-xs text-(--accent) underline" onClick={() => setOpen((o) => !o)}>
          {open ? "收起問答內容" : "展開問答內容"}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-1 rounded bg-(--page-plane) p-2 text-xs">
          {item.question && <p className="whitespace-pre-wrap">問：{item.question}</p>}
          {item.answer && <p className="whitespace-pre-wrap">答：{item.answer}</p>}
          {item.model && <p className="text-(--text-muted)">模型：{item.model}</p>}
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr_1fr]">
        <select value={status} onChange={(e) => setStatus(e.target.value as FeedbackItem["status"])} className="rounded border border-(--gridline) bg-(--surface-2) px-2 py-1.5 text-sm">
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input placeholder="處理說明（改了什麼）" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} className={inputCls} />
        <input placeholder="管理員備註（例如退回原因）" value={adminNote} onChange={(e) => setAdminNote(e.target.value)} className={inputCls} />
      </div>
      {(item.resolvedAt || item.confirmedAt) && (
        <p className="mt-1 text-xs text-(--text-muted)">
          {item.resolvedAt && `處理時間 ${item.resolvedAt}`}
          {item.confirmedAt && `　${item.confirm === "需重改" ? "退回" : "確認"}：${item.confirmedBy}（${item.confirmedAt}）`}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-(--price-up)">{error}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${btnGhost} text-xs`}
          disabled={!dirty || busy}
          onClick={() =>
            patch({
              ...(status !== item.status ? { status } : {}),
              ...(resolveNote !== item.resolveNote ? { resolveNote } : {}),
              ...(adminNote !== item.adminNote ? { adminNote } : {}),
            })
          }
        >
          💾 儲存修改
        </button>
        {item.status !== "待處理" && item.confirm !== "已確認" && (
          <button type="button" className={`${btnPrimary} !py-1 text-xs`} disabled={busy} onClick={() => patch({ confirm: "confirmed" })}>
            ✅ 確認完成
          </button>
        )}
        {item.status !== "待處理" && (
          <button
            type="button"
            className={`${btnGhost} text-xs`}
            disabled={busy}
            onClick={() => {
              const note = prompt("退回重改的原因（會寫進管理員備註）", adminNote);
              if (note !== null) patch({ confirm: "rework", adminNote: note });
            }}
          >
            ↩️ 退回重改
          </button>
        )}
        {item.confirm === "已確認" && (
          <button type="button" className={`${btnGhost} text-xs`} disabled={busy} onClick={() => patch({ confirm: "reset" })}>
            取消確認
          </button>
        )}
      </div>
    </div>
  );
}
