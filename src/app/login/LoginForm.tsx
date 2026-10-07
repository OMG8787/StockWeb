"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH_CLIENT } from "@/lib/auth/clientConstants";
import { btnPrimary, inputCls, sendJson } from "@/components/auth/ui";

type SetupState = { needsSetup: boolean; codeRequired: boolean } | null;

/** 只允許站內路徑，避免 ?next= 被拿來導向外部網站 */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [setup, setSetup] = useState<SetupState>(null);
  const [setupError, setSetupError] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/setup")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "帳號資料庫連線失敗");
        setSetup(d);
      })
      .catch((e: Error) => setSetupError(e.message));
  }, []);

  const isSetup = setup?.needsSetup === true;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      if (isSetup) {
        await sendJson("/api/auth/setup", { account, password, name, code });
        window.location.href = "/admin";
        return;
      }
      const data = await sendJson<{ mustChangePassword: boolean }>("/api/auth/login", { account, password });
      // 用整頁導向，不用 router.push：Next 的路由快取可能還留著登入前被導回 /login 的結果
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 刻意整頁重載：登入狀態改變後要丟掉路由快取
      window.location.href = data.mustChangePassword ? "/account?force=1" : safeNext(searchParams.get("next"));
    } catch (err) {
      setError((err as Error).message || "網路錯誤，請稍後再試");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-(--gridline) bg-(--surface-1) p-6">
        <div>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-(--accent) text-white font-bold text-sm">SR</span>
          <h1 className="mt-3 text-lg font-semibold">{isSetup ? "建立第一個管理員帳號" : "登入股情雷達"}</h1>
          {isSetup && (
            <p className="mt-1 text-sm text-(--text-muted)">帳號資料庫目前沒有任何帳號。這個帳號會擁有全部權限，之後的帳號由管理員在「帳號與權限」建立。</p>
          )}
          {!isSetup && <p className="mt-1 text-sm text-(--text-muted)">帳號由管理員建立；忘記密碼請聯絡管理員重設。</p>}
        </div>
        {setupError && <p className="text-sm text-(--price-up)">⚠️ {setupError}</p>}

        <label className="block space-y-1 text-sm">
          <span>帳號</span>
          <input value={account} onChange={(e) => setAccount(e.target.value)} autoFocus autoComplete="username" className={inputCls} />
        </label>
        {isSetup && (
          <label className="block space-y-1 text-sm">
            <span>顯示名稱</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span>密碼{isSetup && `（至少 ${MIN_PASSWORD_LENGTH_CLIENT} 字元）`}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSetup ? "new-password" : "current-password"}
            className={inputCls}
          />
        </label>
        {isSetup && setup?.codeRequired && (
          <label className="block space-y-1 text-sm">
            <span>設定碼（伺服器環境變數 ADMIN_SETUP_CODE）</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} />
          </label>
        )}

        {error && <p className="text-sm text-(--price-up)">{error}</p>}
        <button type="submit" disabled={loading || !account || !password} className={`w-full ${btnPrimary}`}>
          {loading ? "處理中…" : isSetup ? "建立並登入" : "登入"}
        </button>
      </form>
    </div>
  );
}
