/** AI 建議名單檔數設定（帳號自己選，依本站評分排名取前 N 檔）。客戶端與伺服器共用，不要放進 server-only 檔。 */
export const AI_PICK_LIMIT_OPTIONS = [5, 10, 15, 20] as const;
export const AI_PICK_LIMIT_DEFAULT = 5;

export function normalizePickLimit(v: unknown): number {
  const n = Number(v);
  return (AI_PICK_LIMIT_OPTIONS as readonly number[]).includes(n) ? n : AI_PICK_LIMIT_DEFAULT;
}
