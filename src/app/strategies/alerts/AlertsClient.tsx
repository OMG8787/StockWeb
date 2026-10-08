"use client";

import { useEffect, useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import OrderBookPanel from "@/components/strategy/OrderBookPanel";
import { ALERT_CONFIG_EVENT, ALERT_TEST_EVENT } from "@/components/strategy/AlertWatcher";
import { api, useList, type Strategy } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";
import { getWatchlist } from "@/lib/watchlist";
import { lineLabel, MAX_ALARMS, signalText, type AlarmSetting, type AlertItem, type NamedSymbol } from "@/lib/strategy/alertFormat";
import { ALERT_EVENTS_CHANGED, clearEvents, readEvents, type AlertEvent } from "@/lib/strategy/alertEvents";

interface Config {
  symbols: string[];
  strategyIds: string[];
  intervalSec: number;
  enabled: boolean;
  notifySell: boolean;
  trackWatchlist: boolean;
  trackAiPicks: boolean;
  notifyListChanges: boolean;
  alarms: AlarmSetting[];
}
interface Check {
  at: string;
  marketOpen: boolean;
  truncated?: boolean;
  lists?: { watchlist: NamedSymbol[] | null; ai: NamedSymbol[] | null };
  items: Array<AlertItem & { error?: string }>;
}

const FROM_LABEL = { manual: "✍ 手動", watchlist: "⭐ 關注", ai: "🤖 AI 建議" } as const;
const TONE_DOT = { buy: "var(--price-up)", sell: "var(--price-down)", info: "var(--accent)" } as const;

const AI = { id: "ai", name: "🤖 AI 建議策略（本站綜合評等）" };
const INTERVALS = [5, 10, 15, 20, 30];
/** 常用的鬧鐘時間（台股 09:00 開盤、13:30 收盤） */
const ALARM_PRESETS = [
  { time: "08:45", label: "開盤前" },
  { time: "09:05", label: "開盤後" },
  { time: "13:00", label: "收盤前半小時" },
  { time: "13:35", label: "收盤後" },
];

function chip(l: AlertItem["lines"][number]) {
  const s = l.current;
  const cls = s === "buy" ? "border-(--price-up) text-(--price-up)" : s === "sell" ? "border-(--price-down) text-(--price-down)" : "border-(--gridline) text-(--text-muted)";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${cls}`}>{signalText(l)}</span>;
}

export default function AlertsClient() {
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [cfg, setCfg] = useState<Config | null>(null);
  const [symbolsText, setSymbolsText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [perm, setPerm] = useState<string>("default");
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AlertEvent[]>([]);

  useEffect(() => {
    const load = () => setEvents(readEvents());
    const t = setTimeout(load, 0);
    window.addEventListener(ALERT_EVENTS_CHANGED, load);
    return () => {
      clearTimeout(t);
      window.removeEventListener(ALERT_EVENTS_CHANGED, load);
    };
  }, []);

  useEffect(() => {
    api<{ config: Config }>("/api/strategy/alerts")
      .then((d) => {
        setCfg(d.config);
        setSymbolsText(d.config.symbols.join(", "));
        // 還沒設定過任何提醒時，直接打開設定
        if (!d.config.enabled && d.config.alarms.length === 0) setOpen(true);
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
    const onChecked = (e: Event) => setCheck((e as CustomEvent<Check>).detail);
    window.addEventListener("stockradar:alert-checked", onChecked);
    const t = setTimeout(() => setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("stockradar:alert-checked", onChecked);
    };
  }, []);

  const options = [AI, ...(strategies.items ?? []).map((s) => ({ id: s.id, name: s.name }))];

  async function save(next: Config) {
    setBusy(true);
    setMsg(null);
    try {
      const symbols = symbolsText.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const r = await api<{ config: Config }>("/api/strategy/alerts", { body: { ...next, symbols } });
      setCfg(r.config);
      setSymbolsText(r.config.symbols.join(", "));
      window.dispatchEvent(new Event(ALERT_CONFIG_EVENT));
      const on = r.config.alarms.filter((a) => a.enabled).length;
      setMsg({
        ok: true,
        text: `已儲存：策略訊號提醒${r.config.enabled ? "開啟" : "關閉"}、定時提醒 ${on} 個（任何頁面都會在背景運作）`,
      });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    try {
      setCheck(await api<Check>("/api/strategy/alerts/check", { body: {} }));
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function askPermission() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setPerm(p);
  }

  const setAlarm = (i: number, patch: Partial<AlarmSetting>) => cfg && setCfg({ ...cfg, alarms: cfg.alarms.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const addAlarm = (time: string, label: string) =>
    cfg &&
    cfg.alarms.length < MAX_ALARMS &&
    setCfg({ ...cfg, alarms: [...cfg.alarms, { id: `A${time.replace(":", "")}x${cfg.alarms.length}`, time, label, days: "weekdays", withSignals: true, enabled: true }] });

  const trackedSummary = cfg
    ? [cfg.symbols.length ? `手動 ${cfg.symbols.length} 檔` : "", cfg.trackWatchlist ? "我的關注清單" : "", cfg.trackAiPicks ? "AI 今日建議名單" : ""].filter(Boolean).join("＋") || "未選追蹤名單"
    : "";
  const summary = cfg
    ? `策略訊號提醒：${cfg.enabled ? `開啟（${trackedSummary}，${cfg.strategyIds.length} 個策略，每 ${cfg.intervalSec} 秒）` : "關閉"}・定時提醒：${
        cfg.alarms.filter((a) => a.enabled).map((a) => a.time).join("、") || "無"
      }`
    : "";

  return (
    <div className="space-y-5 pb-24">
      <LabTabs
        active="/strategies/alerts"
        intro="兩種提醒：①定時提醒（像鬧鐘，例如開盤前 08:45 提醒你）；②策略訊號提醒（盤中每 5～30 秒檢查追蹤名單，有策略新出現買點就立刻通知）。沒有訊號的股票不會通知。要有開著網站的分頁才會運作。"
      />
      {msg && <p className={`text-sm ${msg.ok ? "text-(--price-down)" : "text-(--price-up)"}`}>{msg.text}</p>}

      {!cfg ? (
        <p className="text-sm text-(--text-muted)">載入中…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={btnPrimary} onClick={() => setOpen(!open)}>
              🔔 {open ? "收起通知設定" : "設定通知"}
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={checkNow}>
              立即檢查一次訊號
            </button>
            {!open && <span className="text-xs text-(--text-muted)">{summary}</span>}
          </div>

          {open && (
            <section className={`${cardCls} space-y-5`}>
              {/* ① 通知方式 */}
              <div className="space-y-2">
                <h2 className="font-semibold">① 通知方式</h2>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-(--text-secondary)">網站右上角一定會跳通知；</span>
                  {perm === "granted" ? (
                    <span className="text-(--price-down)">✅ 系統通知已開啟（網站分頁在背景也看得到）</span>
                  ) : perm === "unsupported" ? (
                    <span className="text-(--text-muted)">這個瀏覽器不支援系統通知</span>
                  ) : perm === "denied" ? (
                    <span className="text-(--price-up)">系統通知被封鎖了，請到瀏覽器網址列左邊的設定改成「允許通知」</span>
                  ) : (
                    <button type="button" className={`${btnGhost} text-xs`} onClick={askPermission}>
                      🔔 允許系統通知
                    </button>
                  )}
                  <button type="button" className={`${btnGhost} text-xs`} onClick={() => window.dispatchEvent(new Event(ALERT_TEST_EVENT))}>
                    送一則測試通知
                  </button>
                </div>
                <div className="rounded-md bg-(--surface-2) px-3 py-2 text-xs text-(--text-secondary)">
                  通知長這樣（一檔股票一則，每個策略一行，沒有訊號的股票不通知）：
                  <pre className="mt-1 font-sans whitespace-pre-line text-(--text-primary)">{"2330 台積電\nAI 策略：買進（建議買進）\n我的策略：觀察"}</pre>
                </div>
              </div>

              {/* ② 定時提醒 */}
              <div className="space-y-2">
                <h2 className="font-semibold">② ⏰ 定時提醒（鬧鐘）</h2>
                <p className="text-xs text-(--text-muted)">時間到就通知你；勾「附上訊號」會同時列出追蹤名單裡目前有買賣訊號的股票。平日＝週一到週五（國定假日也會響）。</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-(--text-muted)">快速新增：</span>
                  {ALARM_PRESETS.map((p) => (
                    <button key={p.time} type="button" className={`${btnGhost} text-xs`} disabled={cfg.alarms.length >= MAX_ALARMS} onClick={() => addAlarm(p.time, p.label)}>
                      {p.time} {p.label}
                    </button>
                  ))}
                  <button type="button" className={`${btnGhost} text-xs`} disabled={cfg.alarms.length >= MAX_ALARMS} onClick={() => addAlarm("08:50", "")}>
                    ＋ 自訂時間
                  </button>
                </div>
                {cfg.alarms.length === 0 ? (
                  <p className="text-sm text-(--text-muted)">還沒有定時提醒。</p>
                ) : (
                  <div className="space-y-2">
                    {cfg.alarms.map((a, i) => (
                      <div key={`${a.id}-${i}`} className={`flex flex-wrap items-center gap-2 rounded-md border border-(--gridline) p-2 text-sm ${a.enabled ? "" : "opacity-60"}`}>
                        <input type="checkbox" checked={a.enabled} onChange={(e) => setAlarm(i, { enabled: e.target.checked })} aria-label="啟用" />
                        <input type="time" value={a.time} onChange={(e) => setAlarm(i, { time: e.target.value })} className={`${inputCls} !w-auto !py-1`} />
                        <select value={a.days} onChange={(e) => setAlarm(i, { days: e.target.value as AlarmSetting["days"] })} className={`${inputCls} !w-auto !py-1`}>
                          <option value="weekdays">平日</option>
                          <option value="daily">每天</option>
                        </select>
                        <input value={a.label} onChange={(e) => setAlarm(i, { label: e.target.value })} placeholder="提醒內容，例如：看盤前檢查名單" maxLength={40} className={`${inputCls} !w-auto min-w-40 flex-1 !py-1`} />
                        <label className="flex items-center gap-1 text-xs">
                          <input type="checkbox" checked={a.withSignals} onChange={(e) => setAlarm(i, { withSignals: e.target.checked })} />
                          附上訊號
                        </label>
                        <button type="button" className="text-xs text-(--text-muted) hover:text-(--price-up)" onClick={() => setCfg({ ...cfg, alarms: cfg.alarms.filter((_, j) => j !== i) })}>
                          ✕ 刪除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ③ 策略訊號提醒 */}
              <div className="space-y-3">
                <h2 className="font-semibold">③ 📈 策略訊號提醒（有買點立即通知）</h2>
                <div className="space-y-2">
                  <div className="text-sm font-medium">追蹤哪些股票（可複選，合計最多 30 檔）</div>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={cfg.trackWatchlist} onChange={(e) => setCfg({ ...cfg, trackWatchlist: e.target.checked })} />
                    <span>
                      ⭐ 我的關注清單
                      <span className="block text-xs text-(--text-muted)">隨關注清單同步：新增關注就自動開始追蹤、移出關注就停止，並通知你</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={cfg.trackAiPicks} onChange={(e) => setCfg({ ...cfg, trackAiPicks: e.target.checked })} />
                    <span>
                      🤖 AI 今日建議名單
                      <span className="block text-xs text-(--text-muted)">本站每天挑出的建議買進名單：每天第一次通知今天有哪幾檔，之後 AI 新增或移出建議也會通知</span>
                    </span>
                  </label>
                  <div className="space-y-1">
                    <div className="text-sm">✍ 手動輸入（另外加）</div>
                    <div className="flex flex-wrap gap-2">
                      <input value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} placeholder="代號，例如 2330, 2317" className={`${inputCls} !w-auto flex-1`} />
                      <button type="button" className={`${btnGhost} text-xs`} onClick={() => setSymbolsText(getWatchlist().slice(0, 30).map((w) => w.symbol).join(", "))} title="把目前關注清單複製成手動名單（之後不會跟著變；想隨時同步請勾上面的「我的關注清單」）">
                        複製目前關注清單
                      </button>
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">要追蹤的策略（最多 8 個）</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {options.map((o) => (
                      <label key={o.id} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={cfg.strategyIds.includes(o.id)}
                          onChange={(e) => setCfg({ ...cfg, strategyIds: e.target.checked ? [...cfg.strategyIds, o.id] : cfg.strategyIds.filter((x) => x !== o.id) })}
                        />
                        {o.name}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    檢查間隔
                    <select value={cfg.intervalSec} onChange={(e) => setCfg({ ...cfg, intervalSec: Number(e.target.value) })} className={`${inputCls} !w-auto`}>
                      {INTERVALS.map((s) => (
                        <option key={s} value={s}>
                          每 {s} 秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={cfg.notifySell} onChange={(e) => setCfg({ ...cfg, notifySell: e.target.checked })} />
                    賣出訊號也通知
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={cfg.notifyListChanges} onChange={(e) => setCfg({ ...cfg, notifyListChanges: e.target.checked })} />
                    名單異動也通知（新增關注、AI 新增／移出建議）
                  </label>
                  <label className="flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
                    開啟策略訊號提醒
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => save(cfg)}>
                  {busy ? "儲存中…" : "儲存通知設定"}
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {/* 今日事件：通知被關掉或錯過也能回頭看（存在這台裝置的瀏覽器） */}
      {cfg && (
        <section className={`${cardCls} space-y-2`}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">📋 最近事件（{events.length}）</h2>
            {events.length > 0 && (
              <button type="button" className={`${btnGhost} text-xs`} onClick={clearEvents}>
                清除
              </button>
            )}
          </div>
          {events.length === 0 ? (
            <p className="text-xs text-(--text-muted)">還沒有事件。策略出現買賣訊號、關注清單或 AI 建議名單有異動、鬧鐘響起時，都會記在這裡（最近 3 天，只存在這台裝置）。</p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">
              {events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex gap-2 border-b border-(--gridline) pb-1.5 last:border-0">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_DOT[e.tone] }} />
                  <span className="min-w-0">
                    <span className="block font-medium">{e.title}</span>
                    {e.body && <span className="block whitespace-pre-line text-xs text-(--text-secondary)">{e.body}</span>}
                    <span className="block text-xs text-(--text-muted)">{new Date(e.at).toLocaleString("zh-TW", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(check?.items.length ?? cfg?.symbols.length ?? 0) > 0 && (
        <section className={cardCls}>
          <OrderBookPanel symbols={check?.items.length ? check.items.map((i) => i.symbol) : (cfg?.symbols ?? [])} title="📊 追蹤名單的即時五檔" />
        </section>
      )}

      {check && (
        <section className="space-y-2">
          <h2 className="font-semibold">
            目前訊號 <span className="text-xs font-normal text-(--text-muted)">（{new Date(check.at).toLocaleTimeString("zh-TW")} 檢查，{check.marketOpen ? "盤中" : "非交易時段，每 5 分鐘檢查"}）</span>
          </h2>
          {check.items.length === 0 && <p className="text-sm text-(--text-muted)">追蹤名單或策略是空的（沒選策略時只會通知名單異動）。</p>}
          {check.truncated && <p className="text-xs text-(--price-up)">追蹤名單合計超過 30 檔，只檢查前 30 檔（手動輸入優先，其次關注清單、AI 建議）。</p>}
          {check.lists?.ai === null && <p className="text-xs text-(--text-muted)">AI 今日建議名單暫時讀不到，這次略過（不會誤報成全部移出）。</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {check.items.map((it) => (
              <div key={it.symbol} className={`${cardCls} !p-3 text-sm ${it.allBuy ? "!border-(--price-up)" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {it.symbol} {it.name !== it.symbol && it.name}
                    {it.from && it.from.length > 0 && <span className="ml-2 text-[11px] font-normal text-(--text-muted)">{it.from.map((f) => FROM_LABEL[f]).join("・")}</span>}
                  </span>
                  <span>{it.price ?? "—"}</span>
                </div>
                {it.error && <p className="text-xs text-(--price-up)">{it.error}</p>}
                {it.allBuy && <p className="mt-1 text-xs font-semibold text-(--price-up)">✅ 全部策略都是買進</p>}
                <ul className="mt-1 space-y-0.5">
                  {it.lines.map((l) => (
                    <li key={l.id} className="flex items-center gap-2 text-xs">
                      {lineLabel(l)}：{chip(l)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
