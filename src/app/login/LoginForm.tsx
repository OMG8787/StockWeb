"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH_CLIENT } from "@/lib/auth/clientConstants";
import { btnPrimary, inputCls, sendJson } from "@/components/auth/ui";

type SetupState = { needsSetup: boolean; codeRequired: boolean } | null;
type Mode = "login" | "register" | "forgot";

/** 登入頁記住上次輸入的帳號（只存帳號，不存密碼） */
const LAST_ACCOUNT_KEY = "sw_last_account";

/** 只允許站內路徑，避免 ?next= 被拿來導向外部網站 */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

function readLastAccount(): string {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY) ?? "";
  } catch {
    return "";
  }
}

const TITLES: Record<Mode, string> = { login: "登入股情雷達", register: "申請帳號", forgot: "忘記密碼" };

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [setup, setSetup] = useState<SetupState>(null);
  const [setupError, setSetupError] = useState("");
  const [mode, setMode] = useState<Mode>("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 上次的帳號立刻填入（放在 timer 回呼裡，不在 effect 本體同步 setState；不等下面的伺服器查詢）
    const fill = setTimeout(() => {
      const last = readLastAccount();
      if (last) setAccount((a) => a || last);
    }, 0);
    fetch("/api/auth/setup")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "帳號資料庫連線失敗");
        setSetup(d);
      })
      .catch((e: Error) => setSetupError(e.message));
    return () => clearTimeout(fill);
  }, []);

  const isSetup = setup?.needsSetup === true;
  const title = isSetup ? "建立第一個管理員帳號" : TITLES[mode];

  function switchMode(m: Mode) {
    setMode(m);
    setError("");
    setDone("");
    setPassword("");
    setPassword2("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    if ((isSetup || mode === "register") && password !== password2) return setError("兩次輸入的密碼不一樣");
    setLoading(true);
    setError("");
    try {
      if (isSetup) {
        await sendJson("/api/auth/setup", { account, password, name, code });
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 刻意整頁重載：登入狀態改變後要丟掉路由快取
        window.location.href = "/admin";
        return;
      }
      if (mode === "register") {
        const r = await sendJson<{ message: string }>("/api/auth/register", { account, password, name, contact });
        setDone(r.message);
        return;
      }
      if (mode === "forgot") {
        const r = await sendJson<{ message: string }>("/api/auth/forgot", { account, contact });
        setDone(r.message);
        return;
      }
      const data = await sendJson<{ mustChangePassword: boolean }>("/api/auth/login", { account, password });
      try {
        localStorage.setItem(LAST_ACCOUNT_KEY, account.trim());
      } catch {
        // 無痕模式等存不了就算了
      }
      // 用整頁導向，不用 router.push：Next 的路由快取可能還留著登入前被導回 /login 的結果
       
      window.location.href = data.mustChangePassword ? "/account?force=1" : safeNext(searchParams.get("next"));
    } catch (err) {
      setError((err as Error).message || "網路錯誤，請稍後再試");
    } finally {
      setLoading(false);
    }
  }

  const needPassword = isSetup || mode !== "forgot";
  const needConfirm = isSetup || mode === "register";
  const needName = isSetup || mode === "register";
  const needContact = !isSetup && mode !== "login";
  const canSubmit =
    account && (!needPassword || password) && (!needConfirm || password2) && (!needName || name) && (!needContact || contact);
  const submitLabel = isSetup ? "建立並登入" : mode === "register" ? "送出申請" : mode === "forgot" ? "送出重設申請" : "登入";

  const linkCls = "text-(--accent) hover:underline";

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-(--gridline) bg-(--surface-1) p-6">
        <div>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-(--accent) text-white font-bold text-sm">SR</span>
          <h1 className="mt-3 text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-(--text-muted)">
            {isSetup
              ? "帳號資料庫目前沒有任何帳號。這個帳號會擁有全部權限。"
              : mode === "register"
                ? "送出後需要管理員核准，核准後就能用這組帳號密碼登入。"
                : mode === "forgot"
                  ? "填寫帳號與申請時留的聯絡方式，管理員確認是本人後會給你臨時密碼。"
                  : "登入後這台裝置會一直記住你，不用每次登入。"}
          </p>
        </div>
        {setupError && <p className="text-sm text-(--price-up)">⚠️ {setupError}</p>}

        {done ? (
          <>
            <p className="rounded-md border border-(--price-down) px-3 py-2 text-sm">✅ {done}</p>
            <button type="button" className={`w-full ${btnPrimary}`} onClick={() => switchMode("login")}>
              回到登入
            </button>
          </>
        ) : (
          <>
            <label className="block space-y-1 text-sm">
              <span>帳號{needConfirm && "（英文、數字，3 字以上）"}</span>
              <input value={account} onChange={(e) => setAccount(e.target.value)} autoFocus autoComplete="username" className={inputCls} />
            </label>
            {needName && (
              <label className="block space-y-1 text-sm">
                <span>{isSetup ? "顯示名稱" : "姓名或暱稱"}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={inputCls} />
              </label>
            )}
            {needContact && (
              <label className="block space-y-1 text-sm">
                <span>聯絡方式（Email、電話或 LINE）</span>
                <input value={contact} onChange={(e) => setContact(e.target.value)} className={inputCls} />
              </label>
            )}
            {needPassword && (
              <label className="block space-y-1 text-sm">
                <span>密碼{needConfirm && `（至少 ${MIN_PASSWORD_LENGTH_CLIENT} 字元）`}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={needConfirm ? "new-password" : "current-password"}
                  className={inputCls}
                />
              </label>
            )}
            {needConfirm && (
              <label className="block space-y-1 text-sm">
                <span>再輸入一次密碼</span>
                <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" className={inputCls} />
              </label>
            )}
            {isSetup && setup?.codeRequired && (
              <label className="block space-y-1 text-sm">
                <span>設定碼（伺服器環境變數 ADMIN_SETUP_CODE）</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} />
              </label>
            )}

            {error && <p className="text-sm text-(--price-up)">{error}</p>}
            <button type="submit" disabled={loading || !canSubmit} className={`w-full ${btnPrimary}`}>
              {loading ? "處理中，約需 5～10 秒…" : submitLabel}
            </button>

            {!isSetup && (
              <div className="flex justify-between text-sm">
                {mode === "login" ? (
                  <>
                    <button type="button" className={linkCls} onClick={() => switchMode("forgot")}>
                      忘記密碼？
                    </button>
                    <button type="button" className={linkCls} onClick={() => switchMode("register")}>
                      申請帳號
                    </button>
                  </>
                ) : (
                  <button type="button" className={linkCls} onClick={() => switchMode("login")}>
                    ← 回到登入
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
}
