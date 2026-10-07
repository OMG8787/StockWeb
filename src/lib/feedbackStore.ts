import { randomUUID } from "node:crypto";
import { getStore, type Row } from "@/lib/auth/store";
import { taipeiNow } from "@/lib/auth/accounts";

/**
 * 使用者回饋（AI 回答 👍／👎／📝回報、🛠 回報網站）的儲存：跟帳號放在同一份
 * Google 試算表的 Feedback 分頁（2026-10-07 使用者要求，原本存 Redis list
 * ask-feedback:v1，舊資料未搬移）。本機沒設試算表時存在 .cache/auth-dev-store.json。
 *
 * 處理流程（2026-10-07 使用者要求）：新回饋＝待處理 → 開發者改完程式標「已完成」並寫處理說明
 * （scripts/resolve-feedback.py）→ 管理員在 /admin「使用者回饋」確認完成，或退回重改
 * （狀態回到待處理）。這幾欄也可以直接在試算表改。
 */

export const FEEDBACK_RATINGS = ["up", "down", "report", "site"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const FEEDBACK_STATUSES = ["待處理", "已完成", "不處理"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_CONFIRMS = ["未確認", "已確認", "需重改"] as const;
export type FeedbackConfirm = (typeof FEEDBACK_CONFIRMS)[number];
/** 試算表只保留最近這麼多筆（超過會從最舊的刪掉） */
export const FEEDBACK_KEEP = 3000;

export function isFeedbackRating(v: unknown): v is FeedbackRating {
  return typeof v === "string" && (FEEDBACK_RATINGS as readonly string[]).includes(v);
}

export class FeedbackError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface FeedbackEntry {
  rating: FeedbackRating;
  question: string;
  answer: string;
  reason?: string;
  symbol?: string;
  /** 那則回答由哪個模型產生（模型 id；備援文字沒有） */
  model?: string;
  /** rating＝site 時：回報當下所在頁面 */
  page?: string;
  /** 回報的帳號（服務金鑰呼叫時沒有） */
  account?: string;
  name?: string;
  /** ISO UTC 時間（伺服器時間） */
  at: string;
}

export interface FeedbackView extends FeedbackEntry {
  id: string;
  /** 台北日期 YYYY-MM-DD */
  date: string;
  /** 台北時間 YYYY-MM-DD HH:mm:ss */
  atTaipei: string;
  status: FeedbackStatus;
  confirm: FeedbackConfirm;
  resolveNote: string;
  resolvedAt: string;
  confirmedBy: string;
  confirmedAt: string;
  adminNote: string;
}

export async function appendFeedback(entry: FeedbackEntry, userId = ""): Promise<string> {
  const atTaipei = taipeiNow(new Date(entry.at));
  const id = "FB" + randomUUID().replace(/-/g, "").slice(0, 16);
  await getStore().batch([
    {
      op: "append",
      table: "Feedback",
      row: {
        ID: id,
        Date: atTaipei.slice(0, 10),
        At: atTaipei,
        Rating: entry.rating,
        Status: "待處理",
        Confirm: "未確認",
        Account: entry.account ?? "",
        Name: entry.name ?? "",
        Reason: entry.reason ?? "",
        Question: entry.question,
        Answer: entry.answer,
        ResolveNote: "",
        ResolvedAt: "",
        ConfirmedBy: "",
        ConfirmedAt: "",
        AdminNote: "",
        Symbol: entry.symbol ?? "",
        Page: entry.page ?? "",
        Model: entry.model ?? "",
        UserId: userId,
        AtUtc: entry.at,
      },
    },
    { op: "trim", table: "Feedback", keep: FEEDBACK_KEEP },
  ]);
  return id;
}

/** 試算表裡手動填的值不在清單內（或空白）就用預設值 */
function pick<T extends string>(list: readonly T[], v: string | undefined, fallback: T): T {
  const t = (v ?? "").trim();
  return (list as readonly string[]).includes(t) ? (t as T) : fallback;
}

function toView(r: Row): FeedbackView | null {
  if (!isFeedbackRating(r.Rating)) return null;
  const opt = (k: string, v: string | undefined) => (v ? { [k]: v } : {});
  return {
    id: r.ID,
    rating: r.Rating,
    question: r.Question ?? "",
    answer: r.Answer ?? "",
    ...opt("reason", r.Reason),
    ...opt("symbol", r.Symbol),
    ...opt("model", r.Model),
    ...opt("page", r.Page),
    ...opt("account", r.Account),
    ...opt("name", r.Name),
    at: r.AtUtc ?? "",
    date: r.Date || (r.At ?? "").slice(0, 10),
    atTaipei: r.At ?? "",
    status: pick(FEEDBACK_STATUSES, r.Status, "待處理"),
    confirm: pick(FEEDBACK_CONFIRMS, r.Confirm, "未確認"),
    resolveNote: r.ResolveNote ?? "",
    resolvedAt: r.ResolvedAt ?? "",
    confirmedBy: r.ConfirmedBy ?? "",
    confirmedAt: r.ConfirmedAt ?? "",
    adminNote: r.AdminNote ?? "",
  };
}

/** open＝待處理（含被退回重改的）、review＝已處理（已完成或不處理）待管理員確認、confirmed＝已確認、all＝全部 */
export const FEEDBACK_VIEWS = ["open", "review", "confirmed", "all"] as const;
export type FeedbackViewFilter = (typeof FEEDBACK_VIEWS)[number];

export function matchesView(f: Pick<FeedbackView, "status" | "confirm">, view: FeedbackViewFilter | undefined): boolean {
  switch (view) {
    case "open":
      return f.status === "待處理";
    case "review":
      return f.status !== "待處理" && f.confirm !== "已確認";
    case "confirmed":
      return f.confirm === "已確認";
    default:
      return true;
  }
}

/** 新到舊。 */
export async function listFeedback(
  limit: number,
  filter: { rating?: FeedbackRating; view?: FeedbackViewFilter } = {},
): Promise<FeedbackView[]> {
  const [rows] = (await getStore().batch([{ op: "read", table: "Feedback" }])) as Row[][];
  return rows
    .map(toView)
    .filter((x): x is FeedbackView => x !== null && (!filter.rating || x.rating === filter.rating) && matchesView(x, filter.view))
    .reverse()
    .slice(0, limit);
}

export interface FeedbackUpdate {
  status?: string;
  resolveNote?: string;
  /** 只有管理員能用：confirmed＝確認完成、rework＝退回重改、reset＝改回未確認 */
  confirm?: string;
  adminNote?: string;
}

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/**
 * 更新處理狀態。actor＝管理員；null＝本機腳本（服務金鑰）——腳本只能標處理狀態與處理說明，
 * 不能代替管理員確認。
 */
export async function updateFeedback(id: string, input: FeedbackUpdate, actor: { name: string } | null): Promise<FeedbackView> {
  const [rows] = (await getStore().batch([{ op: "read", table: "Feedback" }])) as Row[][];
  const row = rows.find((r) => r.ID === id);
  if (!row) throw new FeedbackError("查無這筆回饋", 404);
  const now = taipeiNow();
  const patch: Row = {};

  if (input.status !== undefined) {
    if (!(FEEDBACK_STATUSES as readonly string[]).includes(input.status)) throw new FeedbackError("未知的處理狀態");
    patch.Status = input.status;
    patch.ResolvedAt = input.status === "待處理" ? "" : now;
    // 重新標成已完成／不處理＝新的一輪處理，要再等管理員確認
    if (input.status !== "待處理") Object.assign(patch, { Confirm: "未確認", ConfirmedBy: "", ConfirmedAt: "" });
  }
  if (input.resolveNote !== undefined) patch.ResolveNote = clip(input.resolveNote, 1000);
  if (input.adminNote !== undefined) {
    if (!actor) throw new FeedbackError("管理員備註只能由管理員填寫", 403);
    patch.AdminNote = clip(input.adminNote, 1000);
  }
  if (input.confirm !== undefined) {
    if (!actor) throw new FeedbackError("只有管理員能確認", 403);
    if (input.confirm === "confirmed") {
      Object.assign(patch, { Confirm: "已確認", ConfirmedBy: actor.name, ConfirmedAt: now });
    } else if (input.confirm === "rework") {
      // 退回重改：回到待處理，開發者下次檢查會看到
      Object.assign(patch, { Confirm: "需重改", Status: "待處理", ResolvedAt: "", ConfirmedBy: actor.name, ConfirmedAt: now });
    } else if (input.confirm === "reset") {
      Object.assign(patch, { Confirm: "未確認", ConfirmedBy: "", ConfirmedAt: "" });
    } else {
      throw new FeedbackError("未知的確認動作");
    }
  }
  if (Object.keys(patch).length === 0) throw new FeedbackError("沒有要更新的內容");
  await getStore().batch([{ op: "update", table: "Feedback", key: id, patch }]);
  return toView({ ...row, ...patch })!;
}
