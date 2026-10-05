"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import type { HoldingItem } from "@/components/WatchlistTable";
import { WATCHLIST_CHANGED_EVENT, getManualUnheldOrderFlags } from "@/lib/watchlist";
import {
  CSV_MAX_BYTES,
  buildWatchlistCsv,
  decodeWatchlistFile,
  encodeUtf16LeWithBom,
  parseWatchlistCsv,
  type ParsedWatchlistCsv,
} from "@/lib/watchlistCsv";
import {
  applyWatchlistImport,
  hasImportBackup,
  restoreLastImportBackup,
  type ImportMode,
} from "@/lib/watchlistImport";

const BTN =
  "rounded-md border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs hover:bg-(--page-plane)";

function exportCsv(items: HoldingItem[]) {
  const text = buildWatchlistCsv(items, getManualUnheldOrderFlags());
  // UTF-16LE＋BOM＋Tab：Excel 全版本雙擊都能正確開啟（舊版 Excel 不認 UTF-8 BOM，會以 Big5 讀成亂碼）。
  const blob = new Blob([encodeUtf16LeWithBom(text) as BlobPart], { type: "text/csv;charset=utf-16le;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Some browsers silently drop a non-ASCII `download` attribute — keep the filename ASCII-only.
  a.download = `stockradar-watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function subscribeChange(cb: () => void) {
  window.addEventListener(WATCHLIST_CHANGED_EVENT, cb);
  return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, cb);
}

type Pending = { fileName: string } & ({ error: string } | { parsed: ParsedWatchlistCsv });

/** 「我的關注」標題列右側的 匯出／匯入 CSV 按鈕、匯入預覽對話框與「復原上一次匯入」。 */
export default function WatchlistCsvControls({ items }: { items: HoldingItem[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mode, setMode] = useState<ImportMode>("replace");
  // 備份增減一定伴隨 replaceWatchlist（會發 WATCHLIST_CHANGED_EVENT），所以訂閱它即可；SSR 一律 false。
  const canUndo = useSyncExternalStore(subscribeChange, hasImportBackup, () => false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同一個檔案可以再選一次
    if (!file) return;
    setNotice(null);
    setMode("replace");
    if (file.size > CSV_MAX_BYTES) {
      setPending({ fileName: file.name, error: `檔案太大（上限 ${Math.round(CSV_MAX_BYTES / 1024)}KB）` });
      return;
    }
    const decoded = decodeWatchlistFile(new Uint8Array(await file.arrayBuffer()));
    if (!decoded.ok) {
      setPending({ fileName: file.name, error: decoded.error });
      return;
    }
    const result = parseWatchlistCsv(decoded.text);
    setPending(result.ok ? { fileName: file.name, parsed: result } : { fileName: file.name, error: result.error });
  }

  function confirm(parsed: ParsedWatchlistCsv) {
    applyWatchlistImport(parsed, mode);
    setPending(null);
    setNotice(`已${mode === "replace" ? "取代" : "合併"}匯入 ${parsed.items.length} 檔`);
  }

  function undo() {
    if (!window.confirm("要復原到上一次匯入前的關注清單嗎？目前的清單會被覆蓋。")) return;
    const ok = restoreLastImportBackup();
    setNotice(ok ? "已復原到匯入前的清單" : "找不到可復原的備份");
  }

  const parsed = pending && "parsed" in pending ? pending.parsed : null;
  const tw = parsed?.items.filter((i) => i.market === "TW").length ?? 0;
  const us = parsed ? parsed.items.length - tw : 0;
  const held = parsed?.items.filter((i) => i.shares != null && i.costBasis != null).length ?? 0;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {notice && <span className="text-xs text-(--text-muted)" role="status">{notice}</span>}
      {canUndo && (
        <button onClick={undo} className={BTN} title="還原到最近一次匯入前的關注清單">
          復原上一次匯入
        </button>
      )}
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPick} data-testid="watchlist-import-input" />
      <button onClick={() => fileRef.current?.click()} className={BTN} title="匯入本網站匯出的 CSV">
        匯入 CSV
      </button>
      {items.length > 0 && (
        <button onClick={() => exportCsv(items)} className={BTN} title="匯出成 CSV">
          匯出 CSV
        </button>
      )}

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPending(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="匯入關注清單"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-(--gridline) bg-(--surface-1) p-4 text-sm text-left"
          >
            <h3 className="mb-1 font-semibold">匯入關注清單</h3>
            <p className="mb-3 break-all text-xs text-(--text-muted)">{pending.fileName}</p>
            {"error" in pending ? (
              <p className="mb-3 text-(--text-primary)" role="alert">{pending.error}</p>
            ) : (
              <>
                <p className="mb-2">
                  將匯入 <b>{pending.parsed.items.length}</b> 檔（台股 {tw}、美股 {us}），其中有持股資料 <b>{held}</b> 檔。
                </p>
                {pending.parsed.invalid.length > 0 && (
                  <div className="mb-2 rounded border border-(--gridline) p-2 text-xs">
                    <p className="mb-1 font-medium">無法辨識的列（{pending.parsed.invalid.length}，不會匯入）</p>
                    <ul className="max-h-24 overflow-y-auto">
                      {pending.parsed.invalid.slice(0, 30).map((r, i) => (
                        <li key={i}>第 {r.line} 列「{r.symbol || "空白"}」：{r.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {pending.parsed.warnings.length > 0 && (
                  <p className="mb-2 text-xs text-(--text-muted)">
                    另有 {pending.parsed.warnings.length} 項提醒：
                    {pending.parsed.warnings.slice(0, 3).map((w) => `第 ${w.line} 列 ${w.reason}`).join("；")}
                    {pending.parsed.warnings.length > 3 ? "…" : ""}
                  </p>
                )}
                <fieldset className="mb-3 space-y-1">
                  <label className="flex items-start gap-2">
                    <input type="radio" name="wl-import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} className="mt-1" />
                    <span>取代目前清單（預設，兩台裝置會一致）</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="radio" name="wl-import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} className="mt-1" />
                    <span>合併（保留目前清單，相同代碼以匯入檔為準）</span>
                  </label>
                </fieldset>
                {mode === "replace" && (
                  <p className="mb-3 text-xs text-(--text-muted)">
                    注意：目前的關注清單會被覆蓋。覆蓋前會自動備份，之後可按「復原上一次匯入」還原。
                  </p>
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setPending(null)} className={BTN}>
                {"error" in pending ? "關閉" : "取消"}
              </button>
              {"parsed" in pending && (
                <button
                  onClick={() => confirm(pending.parsed)}
                  disabled={pending.parsed.items.length === 0}
                  className="rounded-md border border-(--accent) bg-(--surface-2) px-3 py-1 text-xs text-(--accent) hover:bg-(--page-plane) disabled:opacity-50"
                >
                  確認匯入
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
