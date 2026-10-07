// 登入／帳號／管理頁共用的樣式字串（跟原本解鎖頁同一套設計 token）
export const inputCls =
  "w-full rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-(--accent)";
export const btnPrimary =
  "rounded-md bg-(--accent) px-3 py-2 text-sm font-medium text-white disabled:opacity-50";
export const btnGhost =
  "rounded-md border border-(--gridline) bg-(--surface-2) px-3 py-1.5 text-sm hover:bg-(--page-plane) disabled:opacity-50";
export const cardCls = "rounded-lg border border-(--gridline) bg-(--surface-1) p-5";

/** POST/PATCH JSON，失敗時丟出伺服器回傳的中文錯誤訊息。 */
export async function sendJson<T = unknown>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `操作失敗（${res.status}）`);
  return data as T;
}
