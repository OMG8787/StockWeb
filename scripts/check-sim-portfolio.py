"""AI 模擬投資組合檢查：列出指定期間的交易、決策、已實現損益與未成交原因統計（每週檢討與學習用）。

用法：py scripts/check-sim-portfolio.py [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--decisions]
- 不給 --from 就看最近 7 天；--decisions 另外逐筆印每個時點的決策（候選選或不選、持股動或不動的原因）。
- 讀正式站 /api/sim-portfolio（目前成效）與 /api/sim-portfolio/archive（永久封存，按月）。
寫入端：src/lib/simPortfolio/run.ts、archive.ts。
"""
import json, sys, urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

SITE = "https://stock-web-blond.vercel.app"
HEADERS = {"Cookie": "site_unlocked=granted", "User-Agent": "check-sim-portfolio"}
TPE = timezone(timedelta(hours=8))

sys.stdout.reconfigure(encoding="utf-8")


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    return json.load(urllib.request.urlopen(req, timeout=60))


def to_tpe(at):
    try:
        return datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(TPE).strftime("%m-%d %a %H:%M")
    except ValueError:
        return "?"


def months_between(frm, to):
    y, m = int(frm[:4]), int(frm[5:7])
    out = []
    while (y, m) <= (int(to[:4]), int(to[5:7])):
        out.append(f"{y}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def pct(v):
    return "—" if v is None else f"{v:+.2f}%"


args = sys.argv[1:]
today = datetime.now(TPE).date().isoformat()
frm = args[args.index("--from") + 1] if "--from" in args else (datetime.now(TPE).date() - timedelta(days=7)).isoformat()
to = args[args.index("--to") + 1] if "--to" in args else today
show_decisions = "--decisions" in args

view = get(f"{SITE}/api/sim-portfolio?trades=1")
p = view.get("perf") or {}
print(f"【目前成效】{view.get('startDay')} 起：淨值 {p.get('nav'):,} 元，累計 {pct(p.get('totalReturnPct'))}、今日 {pct(p.get('dayReturnPct'))}；"
      f"0050 {pct(p.get('etfReturnPct'))}、加權 {pct(p.get('indexReturnPct'))}；最大回撤 {p.get('maxDrawdownPct')}%；"
      f"勝率 {p.get('winRatePct') if p.get('winRatePct') is not None else '—'}；平均獎勵 {pct(p.get('avgRewardPct'))}" if p else "【目前成效】尚未開始")
if view.get("pending"):
    print(f"盤後定價委託中 {len(view['pending'])} 筆")

trades, decisions = [], []
for m in months_between(frm, to):
    trades += [t for t in get(f"{SITE}/api/sim-portfolio/archive?kind=trades&month={m}")["items"] if frm <= t["day"] <= to]
    decisions += [d for d in get(f"{SITE}/api/sim-portfolio/archive?kind=decisions&month={m}")["items"] if frm <= d["day"] <= to]

filled = [t for t in trades if t.get("status") != "rejected"]
rejected = [t for t in trades if t.get("status") == "rejected"]
print(f"\n【交易】{frm}～{to}：共 {len(trades)} 筆（成交 {len(filled)}、未成交 {len(rejected)}）")
for t in trades:
    side = ("未買到" if t["side"] == "buy" else "未賣出") if t.get("status") == "rejected" else ("買進" if t["side"] == "buy" else "賣出")
    extra = t.get("rejectReason") if t.get("status") == "rejected" else (t.get("basis") or "")
    if t["side"] == "sell" and t.get("status") != "rejected":
        extra += f"｜已實現 {t.get('realized'):,} 元（{pct(t.get('realizedPct'))}，大盤 {pct(t.get('indexPct'))}，獎勵 {pct(t.get('reward'))}）"
    r = t.get("rating") or {}
    rat = f"｜評等「{r.get('label')}」支持{r.get('supportCount')}/不支持{r.get('againstCount')}" if r else ""
    print(f"- 台北 {to_tpe(t['at'])} {side} {t['name']}({t['symbol']}) {t['shares']:,} 股 @ {t['price']}｜{extra}{rat}")

sells = [t for t in filled if t["side"] == "sell"]
if sells:
    wins = sum(1 for t in sells if (t.get("realized") or 0) > 0)
    rewards = [t["reward"] for t in sells if t.get("reward") is not None]
    print(f"\n【已實現】{len(sells)} 筆賣出：合計 {sum(t.get('realized') or 0 for t in sells):,} 元，勝率 {wins / len(sells) * 100:.0f}%，"
          f"平均獎勵 {pct(sum(rewards) / len(rewards) if rewards else None)}")
    worst = sorted(sells, key=lambda t: t.get("reward") if t.get("reward") is not None else 0)[:5]
    print("獎勵最差（要檢討）：" + "；".join(f"{t['name']} {pct(t.get('reward'))}（{t['reason'][:40]}）" for t in worst))
else:
    print("\n【已實現】期間內沒有賣出")

if rejected:
    print("\n【未成交原因】")
    for reason, n in Counter((t.get("rejectReason") or "").split("（")[0] for t in rejected).most_common():
        print(f"- {reason}：{n} 筆")

why = Counter()
for d in decisions:
    for c in d.get("candidates", []):
        if c["action"] == "—":
            why[c["why"].split("（")[0].split("，")[0]] += 1
print(f"\n【決策】{len(decisions)} 個時點；候選沒選的原因統計：")
for k, n in why.most_common(10):
    print(f"- {k}：{n} 次")
if show_decisions:
    for d in decisions:
        print(f"\n台北 {to_tpe(d['at'])}｜{d['note']}")
        for h in d.get("holdings", []):
            print(f"  持股 {h['name']}({h['symbol']})「{h['label']}」→ {h['action']}｜{h['why']}")
        for c in d.get("candidates", []):
            print(f"  候選 {c['name']}({c['symbol']})「{c['label']}」→ {c['action']}｜{c['why']}")
