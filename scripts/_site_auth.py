"""本機腳本呼叫正式站 API 用的驗證標頭。

2026-10-07 起網站改成帳號制（見 src/proxy.ts），原本偽造的 site_unlocked cookie 已失效。
腳本改用服務金鑰：環境變數 SERVICE_API_KEY，或 repo 根目錄 .env.local 裡的 SERVICE_API_KEY=...
（必須跟 Vercel 上設定的同一組）。
"""
import os
from pathlib import Path


def service_key() -> str:
    key = os.environ.get("SERVICE_API_KEY", "").strip()
    if key:
        return key
    env = Path(__file__).resolve().parent.parent / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("SERVICE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("缺少 SERVICE_API_KEY（設環境變數或寫進 .env.local），無法呼叫正式站 API")


def auth_headers(user_agent: str = "stockweb-script") -> dict:
    return {"Authorization": f"Bearer {service_key()}", "User-Agent": user_agent}
