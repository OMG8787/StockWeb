"""列出正式站使用者回饋：AI 回答的 👍／👎／📝回報（up/down/report），以及 AI 面板「🛠 回報網站」（site）。

用法：py scripts/check-feedback.py [上次檢查的 ISO 時間，例如 2026-10-04T14:00:00Z]
- 第一段：比上次檢查更新的回饋（不給時間就列最近 50 筆）。
- 第二段：所有「待處理」的回饋（含管理員退回重改的），不管多舊都會列出，直到處理完。
時間另外換算成台北時間，方便對照當時的盤勢（回饋內容常跟盤中／收盤、當天報價有關）。
資料存在 Google 試算表 Feedback 分頁；處理完用 scripts/resolve-feedback.py 標「已完成」，再由管理員確認。
CLAUDE.md「AI 回饋自動檢查」規則要求每次對話都跑一次。
"""
import json, sys, urllib.request
from _site_auth import auth_headers, site_url
from datetime import datetime, timezone, timedelta

sys.stdout.reconfigure(encoding="utf-8")
TPE = timezone(timedelta(hours=8))


def fetch(query: str) -> list:
    req = urllib.request.Request(f"{site_url()}/api/ask-feedback?{query}", headers=auth_headers("check-feedback"))
    return json.load(urllib.request.urlopen(req, timeout=30)).get("items", [])


def show(i: dict) -> None:
    at = i.get("at", "")
    try:
        local = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(TPE).strftime("%Y-%m-%d %a %H:%M")
    except ValueError:
        local = i.get("atTaipei", "?")
    print("-" * 60)
    print(f"[{i.get('rating')}] {i.get('id')} 狀態={i.get('status')}／{i.get('confirm')} 台北 {local}（UTC {at}）")
    print(f"帳號={i.get('name', '-')}({i.get('account', '-')}) 股票={i.get('symbol', '-')} 頁面={i.get('page', '-')} 模型={i.get('model', '-')}")
    print(f"問：{i.get('question', '')[:200]}")
    print(f"答：{i.get('answer', '')[:300]}")
    if i.get("reason"):
        print(f"使用者說：{i['reason']}")
    if i.get("resolveNote"):
        print(f"處理說明：{i['resolveNote']}")
    if i.get("adminNote"):
        print(f"管理員備註：{i['adminNote']}")


since = sys.argv[1] if len(sys.argv) > 1 else None
recent = fetch("limit=3000&view=all")
recent = [i for i in recent if i.get("at", "") > since] if since else recent[:50]
print(f"=== 新回饋 {len(recent)} 筆（新到舊）===")
for i in recent:
    show(i)

pending = [i for i in fetch("limit=3000&view=open") if i.get("rating") != "up"]
rework = [i for i in pending if i.get("confirm") == "需重改"]
print(f"\n=== 待處理 {len(pending)} 筆（其中管理員退回重改 {len(rework)} 筆；👍 不列）===")
for i in rework + [i for i in pending if i not in rework]:
    show(i)
