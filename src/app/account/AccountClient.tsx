"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { PERMISSION_LIST, hasPerm, routeAccess, strategyLabel } from "@/lib/auth/permissions";
import { MIN_PASSWORD_LENGTH_CLIENT } from "@/lib/auth/clientConstants";
import { useProfile } from "@/lib/auth/useProfile";
import { btnPrimary, cardCls, inputCls, sendJson } from "@/components/auth/ui";

export default function AccountClient() {
  const params = useSearchParams();
  const profile = useProfile();
  const force = params.get("force") === "1" || profile?.mustChangePassword;
  const denied = params.get("denied");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const deniedNeed = denied ? routeAccess(denied) : null;
  const deniedLabels =
    deniedNeed?.kind === "user" ? deniedNeed.need.map((c) => PERMISSION_LIST.find((p) => p.code === c)?.label).filter(Boolean).join("、") : "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== newPw2) return setMsg({ ok: false, text: "兩次輸入的新密碼不一樣" });
    setLoading(true);
    setMsg(null);
    try {
      await sendJson("/api/auth/password", { oldPassword: oldPw, newPassword: newPw });
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      if (force) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 刻意整頁重載：登入狀態改變後要丟掉路由快取
        window.location.href = "/";
        return;
      }
      setMsg({ ok: true, text: "密碼已更新，其他裝置的登入已全部登出" });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="text-xl font-semibold">帳號設定</h1>

      {force && (
        <p className="rounded-md border border-(--price-up) px-3 py-2 text-sm">🔑 你正在使用臨時密碼，請先設定新密碼才能使用其他功能。</p>
      )}
      {denied && !force && (
        <p className="rounded-md border border-(--price-up) px-3 py-2 text-sm">
          ⛔ 這個帳號沒有使用「{denied}」的權限{deniedLabels && `（需要：${deniedLabels}）`}，如需開通請聯絡管理員。
        </p>
      )}

      {profile && (
        <section className={cardCls}>
          <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-(--text-muted)">名稱</dt>
            <dd>{profile.name}</dd>
            <dt className="text-(--text-muted)">帳號</dt>
            <dd>{profile.account}</dd>
            <dt className="text-(--text-muted)">投資策略</dt>
            <dd>{strategyLabel(profile.strategy)}</dd>
            <dt className="text-(--text-muted)">可用功能</dt>
            <dd className="flex flex-wrap gap-1">
              {PERMISSION_LIST.filter((p) => hasPerm(profile.perms, [p.code])).map((p) => (
                <span key={p.code} className="rounded bg-(--page-plane) px-2 py-0.5 text-xs" title={p.detail}>
                  {p.label}
                </span>
              ))}
            </dd>
          </dl>
        </section>
      )}

      <form onSubmit={handleSubmit} className={`${cardCls} space-y-3`}>
        <h2 className="font-semibold">變更密碼</h2>
        <input type="password" placeholder={force ? "臨時密碼" : "目前的密碼"} value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" className={inputCls} />
        <input type="password" placeholder={`新密碼（至少 ${MIN_PASSWORD_LENGTH_CLIENT} 字元）`} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" className={inputCls} />
        <input type="password" placeholder="再輸入一次新密碼" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" className={inputCls} />
        {msg && <p className={`text-sm ${msg.ok ? "text-(--price-down)" : "text-(--price-up)"}`}>{msg.text}</p>}
        <button type="submit" disabled={loading || !oldPw || !newPw || !newPw2} className={btnPrimary}>
          {loading ? "儲存中…" : "更新密碼"}
        </button>
      </form>
    </div>
  );
}
