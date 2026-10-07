"""把一筆使用者回饋標成「已完成」（程式已修改）或「不處理」，並寫處理說明；之後由管理員在網站確認。

用法：
  py scripts/resolve-feedback.py <回饋ID> "處理說明（改了什麼、commit）"
  py scripts/resolve-feedback.py <回饋ID> "不需修改的理由" --status 不處理
回饋 ID 從 scripts/check-feedback.py 的輸出取得（FB 開頭）。
"""
import json, sys, urllib.request, urllib.error
from _site_auth import auth_headers, site_url

sys.stdout.reconfigure(encoding="utf-8")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
status = "已完成"
if "--status" in sys.argv:
    status = sys.argv[sys.argv.index("--status") + 1]
    args = [a for a in args if a != status]
if len(args) < 2:
    raise SystemExit(__doc__)
fid, note = args[0], args[1]
body = json.dumps({"id": fid, "status": status, "resolveNote": note}).encode("utf-8")
headers = {**auth_headers("resolve-feedback"), "Content-Type": "application/json"}
req = urllib.request.Request(f"{site_url()}/api/ask-feedback", data=body, headers=headers, method="PATCH")
try:
    item = json.load(urllib.request.urlopen(req, timeout=30))["item"]
    print(f"已更新 {item['id']}：{item['status']}／{item['confirm']}，處理說明：{item['resolveNote']}")
except urllib.error.HTTPError as e:
    raise SystemExit(f"更新失敗（{e.code}）：{e.read().decode('utf-8', 'replace')}")
