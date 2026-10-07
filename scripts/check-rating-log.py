"""本站綜合評等紀錄檢查：列出新紀錄，並追蹤之前每筆評等之後 1／5／20 個交易日的報酬。

用法：py scripts/check-rating-log.py [上次檢查的 ISO 時間，例如 2026-10-05T06:00:00Z] [--days 60]
- 第一段：列出「比上次檢查更新」的紀錄（不給時間就列今天的）。
- 第二段：近 --days 天（預設 60）的所有紀錄，對已滿 1／5／20 個交易日的計算之後報酬
  （基準＝評等當下價格；N 日後＝評等當天那根日K往後第 N 根的收盤，日K來自正式站 /api/chart），
  標出「建議買進後跌超過 5%」與「建議不買／等回檔卻漲超過 8%」的案例，最後印各結論的勝率與平均報酬。
- 剛上線、還沒有滿 1 個交易日的紀錄屬正常（會顯示「尚無已滿 N 日的紀錄」）。
寫入端：src/lib/ai/ratingLog.ts；讀取 API：/api/rating-log。CLAUDE.md 規定主 agent 每則使用者訊息都要跑。
"""
import json, sys, time, urllib.request
from _site_auth import auth_headers
from datetime import datetime, timezone, timedelta

SITE = "https://stock-web-rho.vercel.app"
HEADERS = auth_headers("check-rating-log")
TPE = timezone(timedelta(hours=8))
HORIZONS = (1, 5, 20)
BUY_DROP_PCT = -5.0
MISS_RISE_PCT = 8.0
CODE_LABEL = {"buy": "建議買進", "buy-on-pullback": "等回檔", "avoid": "先不要買"}

sys.stdout.reconfigure(encoding="utf-8")


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    return json.load(urllib.request.urlopen(req, timeout=60))


def to_tpe(at):
    try:
        return datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(TPE).strftime("%m-%d %a %H:%M")
    except ValueError:
        return "?"


args = [a for a in sys.argv[1:]]
days = 60
if "--days" in args:
    i = args.index("--days")
    days = int(args[i + 1])
    del args[i : i + 2]
since = args[0] if args else None

today = datetime.now(TPE).date()
frm = (today - timedelta(days=days)).isoformat()
data = get(f"{SITE}/api/rating-log?from={frm}&to={today.isoformat()}")
items = data.get("items", [])
print(f"Redis 啟用={data.get('enabled')}；{frm}～{today} 共 {len(items)} 筆紀錄")

# ── 第一段：新紀錄 ──
new = [i for i in items if (i["at"] > since if since else i["day"] == today.isoformat())]
print(f"\n【新紀錄】{'自 ' + since if since else '今天'}以來 {len(new)} 筆")
for e in new:
    hits = f" 追高防護={','.join(e['chaseHits'])}" if e.get("chaseHits") else ""
    print(f"- 台北 {to_tpe(e['at'])}［{e['session']}／{e['source']}］{e['name']}({e['symbol']}) 價 {e['price']}：{e['label']}{hits}")

# ── 第二段：之後報酬 ──
charts = {}


def candles_for(sym, market):
    key = (sym, market)
    if key not in charts:
        try:
            charts[key] = get(f"{SITE}/api/chart/{sym}?range=3m&market={market}").get("candles", [])
        except Exception as ex:  # noqa: BLE001
            print(f"  （{sym} 日K抓取失敗：{ex}）")
            charts[key] = []
        time.sleep(1.5)  # 對正式站／證交所節制
    return charts[key]


rows = []
for e in items:
    cs = candles_for(e["symbol"], e.get("market", "TW"))
    idx = None
    for k, c in enumerate(cs):
        if c["time"][:10] <= e["day"]:
            idx = k
    if idx is None:
        continue
    rets = {}
    for n in HORIZONS:
        if idx + n < len(cs) and e["price"]:
            rets[n] = (cs[idx + n]["close"] / e["price"] - 1) * 100
    rows.append((e, rets))

print("\n【值得檢討的案例】")
flagged = 0
for e, rets in rows:
    for n, r in rets.items():
        bad_buy = e["code"] == "buy" and r <= BUY_DROP_PCT
        missed = e["code"] in ("avoid", "buy-on-pullback") and r >= MISS_RISE_PCT
        if bad_buy or missed:
            flagged += 1
            tag = "建議買進後跌" if bad_buy else "說不買／等回檔卻漲"
            print(f"- {tag}：{e['day']} {e['name']}({e['symbol']}) {e['label']}，{n} 日後 {r:+.2f}%｜理由：{e['reason'][:80]}")
            break
if flagged == 0:
    print("（無）")

print("\n【各結論之後報酬】（勝率＝之後報酬 > 0 的比例）")
for code, label in CODE_LABEL.items():
    parts = []
    for n in HORIZONS:
        v = [rets[n] for e, rets in rows if e["code"] == code and n in rets]
        if v:
            parts.append(f"{n}日 n={len(v)} 勝率{sum(1 for x in v if x > 0) / len(v) * 100:.0f}% 平均{sum(v) / len(v):+.2f}%")
        else:
            parts.append(f"{n}日 尚無已滿 {n} 日的紀錄")
    print(f"- {label}：" + "；".join(parts))
