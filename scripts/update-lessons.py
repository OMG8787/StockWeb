"""教訓清單驗證：用評等紀錄的實際獎勵重新檢查 src/lib/ai/lessons.ts 每條教訓的統計證據。

用法：py scripts/update-lessons.py
- 讀正式站 /api/learning（每日學習工作產生的彙總；驗證邏輯在 src/lib/ai/learning/lessonMatch.ts validateLessons）。
- 列出每條教訓：符合條件、已滿 5 個交易日的紀錄筆數、平均 5 日超額、跑贏比例、判定（樣本不足／證據仍成立／證據已不成立）。
- 「證據已不成立」的教訓只列出來給主 agent 檢查，程式不會自動刪除；確認後手動改 lessons.ts 的 status 或刪除。
- 想立刻重算彙總：curl "https://stock-web-blond.vercel.app/api/cron/learning?force=1"（有設 CRON_SECRET 要帶 Authorization）。
"""
import json, sys, urllib.request

SITE = "https://stock-web-blond.vercel.app"
HEADERS = {"Cookie": "site_unlocked=granted", "User-Agent": "update-lessons"}

sys.stdout.reconfigure(encoding="utf-8")


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    return json.load(urllib.request.urlopen(req, timeout=60))


summary = get(f"{SITE}/api/learning").get("summary")
if not summary:
    print("尚未產生學習彙總（每日台股收盤後自動計算；評等紀錄 2026-10-05 開始累積）。")
    sys.exit(0)

print(f"彙總時間：{summary['generatedAt']}；已算出成績 {summary['evaluated']} 筆，滿5日 {summary['matured'].get('5', 0)} 筆\n")
flagged = []
for v in summary.get("lessons", []):
    ex = "—" if v["avgExcess"] is None else f"{v['avgExcess']:+.2f}%"
    win = "—" if v["winRate"] is None else f"{v['winRate']}%"
    print(f"[{v['status']}] {v['id']}：{v['condition']}\n    符合 {v['n']} 筆、平均5日超額 {ex}、跑贏 {win} → {v['verdict']}")
    if v["verdict"] == "證據已不成立":
        flagged.append(v)

print()
if flagged:
    print("⚠ 以下教訓的證據已不成立，請檢查後修改 src/lib/ai/lessons.ts（改 status 為「已失效」或修正條件／證據）：")
    for v in flagged:
        print(f"  - {v['id']}（{v['condition']}）")
else:
    print("沒有證據已不成立的教訓（樣本不足的不下結論）。")
