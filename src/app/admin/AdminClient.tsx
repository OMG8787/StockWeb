"use client";

import { useCallback, useEffect, useState } from "react";
import { PERM, PERMISSION_LIST, ROLE_TEMPLATES, STRATEGIES, type PermCode } from "@/lib/auth/permissions";
import { useProfile } from "@/lib/auth/useProfile";
import { btnGhost, btnPrimary, cardCls, inputCls, sendJson } from "@/components/auth/ui";

interface UserView {
  userId: string;
  account: string;
  name: string;
  perms: PermCode[];
  strategy: string;
  isActive: boolean;
  mustChangePassword: boolean;
  note: string;
  lastLoginAt: string;
  sessionCount: number;
  online: boolean;
  lastActiveAt: string;
}

interface SessionView {
  sessionId: string;
  userId: string;
  account: string;
  name: string;
  device: string;
  loginAt: string;
  lastActiveAt: string;
  online: boolean;
  isMe: boolean;
}

interface LogView {
  id: string;
  loginAt: string;
  account: string;
  name: string;
  result: string;
  device: string;
  ip: string;
  lastActiveAt: string;
  endAt: string;
  endReason: string;
}

interface Overview {
  users: UserView[];
  sessions: SessionView[];
  loginLog: LogView[];
  onlineMinutes: number;
}

type Tab = "users" | "sessions" | "log";
const REFRESH_MS = 60_000;

const th = "px-2 py-2 text-left text-xs font-medium text-(--text-muted) whitespace-nowrap";
const td = "px-2 py-2 align-top text-sm";

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-(--price-down)" : "bg-(--baseline)"}`}
      title={online ? "線上" : "離線"}
    />
  );
}

export default function AdminClient() {
  const me = useProfile();
  const [tab, setTab] = useState<Tab>("users");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "載入失敗");
      setData(d);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // 第一次載入放進 timer callback（不在 effect 本體同步 setState）
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  async function run(action: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const msg = await action();
      if (msg) setNotice(msg);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isSuper = me?.perms.includes(PERM.SUPER_ADMIN) ?? false;
  const onlineCount = data?.users.filter((u) => u.online).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">帳號與權限</h1>
        {data && (
          <span className="text-sm text-(--text-muted)">
            {data.users.length} 個帳號・{onlineCount} 人線上（{data.onlineMinutes} 分鐘內有活動）
          </span>
        )}
        <button type="button" className={`${btnGhost} ml-auto`} onClick={() => run(async () => {})} disabled={busy}>
          🔄 重新整理
        </button>
      </div>

      <div className="flex gap-1 border-b border-(--gridline)">
        {(
          [
            ["users", "👥 帳號與權限"],
            ["sessions", "🟢 登入狀態"],
            ["log", "🕒 登入紀錄"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-(--accent) font-semibold" : "border-transparent text-(--text-secondary)"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="rounded-md border border-(--price-up) px-3 py-2 text-sm text-(--price-up)">⚠️ {error}</p>}
      {notice && (
        <div className="flex items-start gap-3 rounded-md border border-(--accent) bg-(--accent-soft) px-3 py-2 text-sm">
          <p className="flex-1 whitespace-pre-line">{notice}</p>
          <button type="button" className="text-xs underline" onClick={() => setNotice("")}>
            關閉
          </button>
        </div>
      )}
      {!data && !error && <p className="text-sm text-(--text-muted)">載入中…</p>}

      {data && tab === "users" && (
        <>
          <CreateUserForm isSuper={isSuper} busy={busy} run={run} />
          <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
            <table className="w-full min-w-[900px]">
              <thead className="border-b border-(--gridline)">
                <tr>
                  <th className={th}>帳號</th>
                  {PERMISSION_LIST.map((p) => (
                    <th key={p.code} className={`${th} text-center`} title={p.detail}>
                      {p.label}
                    </th>
                  ))}
                  <th className={th}>策略</th>
                  <th className={th}>狀態</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <UserRow key={`${u.userId}:${u.perms.join(",")}:${u.strategy}:${u.isActive}`} user={u} isSuper={isSuper} busy={busy} run={run} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-(--text-muted)">
            勾選後按「儲存」生效；對方下一次操作（最慢 5 分鐘內）就會套用新權限。停用帳號會立即結束該帳號所有登入。
          </p>
        </>
      )}

      {data && tab === "sessions" && (
        <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
          <table className="w-full min-w-[700px]">
            <thead className="border-b border-(--gridline)">
              <tr>
                <th className={th}>狀態</th>
                <th className={th}>使用者</th>
                <th className={th}>裝置</th>
                <th className={th}>登入時間</th>
                <th className={th}>最後活動</th>
                <th className={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.length === 0 && (
                <tr>
                  <td className={td} colSpan={6}>
                    目前沒有登入中的裝置
                  </td>
                </tr>
              )}
              {data.sessions.map((s) => (
                <tr key={s.sessionId} className="border-b border-(--gridline) last:border-0">
                  <td className={td}>
                    <OnlineDot online={s.online} /> {s.online ? "線上" : "閒置"}
                  </td>
                  <td className={td}>
                    {s.name}
                    <span className="ml-1 text-xs text-(--text-muted)">{s.account}</span>
                  </td>
                  <td className={td}>{s.device}</td>
                  <td className={td}>{s.loginAt}</td>
                  <td className={td}>{s.lastActiveAt}</td>
                  <td className={td}>
                    {s.isMe ? (
                      <span className="text-xs text-(--text-muted)">（目前這台）</span>
                    ) : (
                      <button
                        type="button"
                        className={btnGhost}
                        disabled={busy}
                        onClick={() =>
                          confirm(`確定讓 ${s.name} 的「${s.device}」登出？`) &&
                          run(async () => {
                            await sendJson("/api/admin/kick", { sessionId: s.sessionId });
                            return `已讓 ${s.name} 的「${s.device}」登出`;
                          })
                        }
                      >
                        強制登出
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && tab === "log" && (
        <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
          <table className="w-full min-w-[800px]">
            <thead className="border-b border-(--gridline)">
              <tr>
                <th className={th}>登入時間</th>
                <th className={th}>使用者</th>
                <th className={th}>結果</th>
                <th className={th}>裝置／IP</th>
                <th className={th}>最後活動</th>
                <th className={th}>結束</th>
              </tr>
            </thead>
            <tbody>
              {data.loginLog.map((l) => (
                <tr key={l.id} className="border-b border-(--gridline) last:border-0">
                  <td className={td}>{l.loginAt}</td>
                  <td className={td}>
                    {l.name || "—"}
                    <span className="ml-1 text-xs text-(--text-muted)">{l.account}</span>
                  </td>
                  <td className={`${td} ${l.result === "成功" ? "" : "text-(--price-up)"}`}>{l.result}</td>
                  <td className={td}>
                    {l.device}
                    {l.ip && <span className="block text-xs text-(--text-muted)">{l.ip}</span>}
                  </td>
                  <td className={td}>{l.lastActiveAt}</td>
                  <td className={td}>
                    {l.endAt ? (
                      <>
                        {l.endAt}
                        <span className="block text-xs text-(--text-muted)">{l.endReason}</span>
                      </>
                    ) : l.result === "成功" ? (
                      <span className="text-xs text-(--text-muted)">登入中</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Run = (action: () => Promise<string | void>) => Promise<void>;

/** 權限勾選；最高管理員欄只有最高管理員能勾。 */
function PermChecks({ perms, onChange, isSuper }: { perms: PermCode[]; onChange: (p: PermCode[]) => void; isSuper: boolean }) {
  return (
    <>
      {PERMISSION_LIST.map((p) => (
        <td key={p.code} className={`${td} text-center`}>
          <input
            type="checkbox"
            aria-label={p.label}
            checked={perms.includes(p.code)}
            disabled={p.code === PERM.SUPER_ADMIN && !isSuper}
            onChange={(e) => onChange(e.target.checked ? [...perms, p.code] : perms.filter((c) => c !== p.code))}
          />
        </td>
      ))}
    </>
  );
}

function UserRow({ user, isSuper, busy, run }: { user: UserView; isSuper: boolean; busy: boolean; run: Run }) {
  const [perms, setPerms] = useState<PermCode[]>(user.perms);
  const [strategy, setStrategy] = useState(user.strategy);
  const dirty = perms.slice().sort().join() !== user.perms.slice().sort().join() || strategy !== user.strategy;

  return (
    <tr className={`border-b border-(--gridline) last:border-0 ${user.isActive ? "" : "opacity-60"}`}>
      <td className={td}>
        <div className="flex items-center gap-2">
          <OnlineDot online={user.online} />
          <div>
            <div className="font-medium">{user.name}</div>
            <div className="text-xs text-(--text-muted)">
              {user.account}
              {user.sessionCount > 0 && `・${user.sessionCount} 台裝置`}
            </div>
            <div className="text-xs text-(--text-muted)">
              {user.online ? `線上（${user.lastActiveAt}）` : user.lastLoginAt ? `上次登入 ${user.lastLoginAt}` : "尚未登入"}
            </div>
          </div>
        </div>
      </td>
      <PermChecks perms={perms} onChange={setPerms} isSuper={isSuper} />
      <td className={td}>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded border border-(--gridline) bg-(--surface-2) px-1 py-1 text-xs">
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </td>
      <td className={`${td} whitespace-nowrap text-xs`}>
        {user.isActive ? "啟用" : "停用"}
        {user.mustChangePassword && <span className="block text-(--text-muted)">待改臨時密碼</span>}
      </td>
      <td className={td}>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={btnPrimary + " !py-1 text-xs"}
            disabled={!dirty || busy}
            onClick={() =>
              run(async () => {
                await sendJson("/api/admin/users", { userId: user.userId, perms, strategy }, "PATCH");
                return `已更新 ${user.name} 的權限與策略`;
              })
            }
          >
            儲存
          </button>
          <button
            type="button"
            className={btnGhost + " text-xs"}
            disabled={busy}
            onClick={() =>
              confirm(user.isActive ? `確定停用 ${user.name}？該帳號所有裝置會立即登出。` : `確定重新啟用 ${user.name}？`) &&
              run(async () => {
                await sendJson("/api/admin/users", { userId: user.userId, isActive: !user.isActive }, "PATCH");
                return `${user.name} 已${user.isActive ? "停用" : "啟用"}`;
              })
            }
          >
            {user.isActive ? "停用" : "啟用"}
          </button>
          <button
            type="button"
            className={btnGhost + " text-xs"}
            disabled={busy}
            onClick={() =>
              confirm(`確定重設 ${user.name} 的密碼？對方所有裝置會被登出，需用臨時密碼重新登入。`) &&
              run(async () => {
                const r = await sendJson<{ tempPassword: string }>("/api/admin/reset-password", { userId: user.userId });
                return `${user.name} 的臨時密碼：${r.tempPassword}\n（只顯示這一次，請直接告訴對方；對方登入後必須先改密碼）`;
              })
            }
          >
            重設密碼
          </button>
          {user.sessionCount > 0 && (
            <button
              type="button"
              className={btnGhost + " text-xs"}
              disabled={busy}
              onClick={() =>
                confirm(`確定讓 ${user.name} 的所有裝置登出？`) &&
                run(async () => {
                  const r = await sendJson<{ count: number }>("/api/admin/kick", { userId: user.userId });
                  return `已讓 ${user.name} 的 ${r.count} 台裝置登出`;
                })
              }
            >
              全部登出
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateUserForm({ isSuper, busy, run }: { isSuper: boolean; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [strategy, setStrategy] = useState(STRATEGIES[0].id);
  const [perms, setPerms] = useState<PermCode[]>(ROLE_TEMPLATES.find((r) => r.id === "basic")!.perms);

  if (!open) {
    return (
      <button type="button" className={btnPrimary} onClick={() => setOpen(true)}>
        ＋ 新增帳號
      </button>
    );
  }

  return (
    <form
      className={`${cardCls} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await sendJson<{ tempPassword: string }>("/api/admin/users", { account, name, note, strategy, perms });
          setOpen(false);
          setAccount("");
          setName("");
          setNote("");
          return `已建立帳號「${account}」，臨時密碼：${r.tempPassword}\n（只顯示這一次，請直接告訴對方；對方第一次登入必須先改密碼）`;
        });
      }}
    >
      <h2 className="font-semibold">新增帳號</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <input placeholder="登入帳號（英數字）" value={account} onChange={(e) => setAccount(e.target.value)} className={inputCls} />
        <input placeholder="顯示名稱" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        <input placeholder="備註（選填）" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-(--text-muted)">套用角色：</span>
        {ROLE_TEMPLATES.map((r) => (
          <button key={r.id} type="button" className={btnGhost + " text-xs"} onClick={() => setPerms(r.perms)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {PERMISSION_LIST.map((p) => (
          <label key={p.code} className="flex items-center gap-1" title={p.detail}>
            <input
              type="checkbox"
              checked={perms.includes(p.code)}
              disabled={p.code === PERM.SUPER_ADMIN && !isSuper}
              onChange={(e) => setPerms(e.target.checked ? [...perms, p.code] : perms.filter((c) => c !== p.code))}
            />
            {p.label}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-(--text-muted)">投資策略：</span>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded border border-(--gridline) bg-(--surface-2) px-2 py-1">
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={busy || !account}>
          建立帳號
        </button>
        <button type="button" className={btnGhost} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
      <p className="text-xs text-(--text-muted)">建立後會顯示一組臨時密碼，對方第一次登入必須先改成自己的密碼。</p>
    </form>
  );
}
