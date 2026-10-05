"""列出正式站使用者回饋：AI 回答的 👍／👎／📝回報（up/down/report），以及 AI 面板「🛠 回報網站」的整站問題／建議（site）中「比上次檢查更新」的項目。

用法：py scripts/check-feedback.py [上次檢查的 ISO 時間，例如 2026-10-04T14:00:00Z]
不給時間就列最近 50 筆。時間一律另外換算成台北時間，方便對照當時的盤勢
（回饋內容常跟「當下是盤中還是收盤、當天的報價」有關，查證前要先看是哪個時間點）。
CLAUDE.md「AI 回饋自動檢查」規則要求每次對話都跑一次。
"""
import json, sys, urllib.request
from datetime import datetime, timezone, timedelta

URL = "https://stock-web-blond.vercel.app/api/ask-feedback?limit=300"
req = urllib.request.Request(URL, headers={"Cookie": "site_unlocked=granted"})
data = json.load(urllib.request.urlopen(req, timeout=30))
items = data.get("items", [])
since = sys.argv[1] if len(sys.argv) > 1 else None
if since:
    items = [i for i in items if i.get("at", "") > since]
else:
    items = items[:50]
tpe = timezone(timedelta(hours=8))
print(f"Redis 啟用={data.get('enabled', True)}；符合條件 {len(items)} 筆（新到舊）")
for i in items:
    at = i.get("at", "")
    try:
        local = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(tpe).strftime("%Y-%m-%d %a %H:%M")
    except ValueError:
        local = "?"
    sys.stdout.reconfigure(encoding="utf-8")
    print("-" * 60)
    print(f"[{i.get('rating')}] 台北 {local}（UTC {at}） 股票={i.get('symbol', '-')} 頁面={i.get('page', '-')} 模型={i.get('model', '-')}")
    print(f"問：{i.get('question', '')[:200]}")
    print(f"答：{i.get('answer', '')[:300]}")
    if i.get("reason"):
        print(f"使用者說：{i['reason']}")
