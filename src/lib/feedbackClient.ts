/**
 * 前端送出回饋（👍／👎／📝回報／🛠回報網站）的唯一入口。
 *
 * 2026-10-04 使用者以為送了回報、資料庫卻沒有：原本送出失敗一律吞掉、畫面照樣顯示「已收到」，
 * 使用者完全不知道沒送到。改成回傳成功與否，失敗時由畫面提示「送出失敗，請再試一次」並保留內容。
 */
export async function postFeedback(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/ask-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, at: new Date().toISOString() }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return data?.ok === true;
  } catch {
    return false;
  }
}

export const FEEDBACK_SEND_FAILED_TEXT = "送出失敗，請再試一次（內容已保留）";
