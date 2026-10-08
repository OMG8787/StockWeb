"use client";

import { useEffect, useRef, useState } from "react";
import { diffAlerts, diffLists, dueAlarms, formatAlert, hasSignal, taipeiClock, type AlarmSetting, type AlertItem, type AlertNotice, type ListState, type NamedSymbol } from "@/lib/strategy/alertFormat";
import { recordEvents } from "@/lib/strategy/alertEvents";

/**
 * 即時提醒（2026-10-08 使用者要求「名單 10～30 秒追蹤一次，碰到策略買賣訊號就跳全站通知」，
 * 同日追加「定時提醒像鬧鐘」與通知格式「代號／每個策略一行」）。
 * 掛在 layout，任何頁面都在跑：
 * - 策略訊號：照設定的間隔呼叫 /api/strategy/alerts/check，有策略新出現買進（或賣出）就通知，沒訊號不通知。
 * - 鬧鐘：每 20 秒看一次台北時間，到了設定時間就響（可附上追蹤名單目前有訊號的股票）。
 * 有開瀏覽器通知權限時也送系統通知（分頁在背景也看得到）。
 *
 * 限制：要有開著網站的分頁才會檢查與響鈴（沒有另外的推播伺服器）；非交易時段訊號改成 5 分鐘檢查一次。
 * 上一次的訊號與今天響過的鬧鐘記在 localStorage，重新整理不會重複通知。
 */

/** 提醒頁「立即檢查一次」：叫全站的監看器馬上用同一套比對跑一次（訊號與名單異動都會通知、記進最近事件） */
export const ALERT_CHECK_NOW_EVENT = "stockradar:alert-check-now";
export const ALERT_CONFIG_EVENT = "stockradar:alert-config-changed";
/** 提醒頁「送一則測試通知」用 */
export const ALERT_TEST_EVENT = "stockradar:alert-test";
const STATE_KEY = "sw_alert_state";
const FIRED_KEY = "sw_alarm_fired";
const LISTS_KEY = "sw_alert_lists";
const CLOSED_INTERVAL_SEC = 300;
const ALARM_TICK_MS = 20_000;
const TOAST_MS = 20_000;

interface CheckResult {
  at: string;
  marketOpen: boolean;
  items: AlertItem[];
  lists?: { watchlist: NamedSymbol[] | null; ai: NamedSymbol[] | null };
}
interface Toast extends AlertNotice {
  id: string;
}
interface Config {
  enabled: boolean;
  intervalSec: number;
  symbols: string[];
  strategyIds: string[];
  notifySell: boolean;
  trackWatchlist: boolean;
  trackAiPicks: boolean;
  notifyListChanges: boolean;
  alarms: AlarmSetting[];
}

/** 有沒有任何要追蹤的股票來源（手動輸入、關注清單、AI 建議名單） */
const hasTargets = (c: Config) => c.symbols.length > 0 || c.trackWatchlist || c.trackAiPicks;

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 存不了就算了（無痕模式），最多重新整理後重複通知一次
  }
}

async function fetchCheck(): Promise<CheckResult | null> {
  try {
    const r = await fetch("/api/strategy/alerts/check", { method: "POST", cache: "no-store" });
    return r.ok ? ((await r.json()) as CheckResult) : null;
  } catch {
    return null;
  }
}

export default function AlertWatcher() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;
    let cfg: Config | null = null;

    async function loadConfig() {
      try {
        const r = await fetch("/api/strategy/alerts", { cache: "no-store" });
        cfg = r.ok ? (await r.json()).config : null;
      } catch {
        cfg = null;
      }
    }

    function notify(list: AlertNotice[]) {
      if (list.length === 0) return;
      recordEvents(list);
      const withId = list.map((t, i) => ({ ...t, id: `${Date.now()}-${i}-${Math.random()}` }));
      setToasts((prev) => [...withId, ...prev].slice(0, 6));
      // 通知卡片 20 秒後自動收起（不然會一直蓋在畫面右側擋住按鈕）；事件仍留在提醒頁的「最近事件」，系統通知也已送出
      setTimeout(() => setToasts((prev) => prev.filter((t) => !withId.some((w) => w.id === t.id))), TOAST_MS);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const t of list) {
          try {
            new Notification(t.title, { body: t.body, tag: `${t.title}-${t.body}` });
          } catch {
            // 部分手機瀏覽器不支援 new Notification，畫面上的通知還是會出現
          }
        }
      }
    }

    /** 檢查一次並比對、通知（排程輪詢與「立即檢查」共用同一套） */
    async function runCheck(c: Config): Promise<CheckResult | null> {
      const data = await fetchCheck();
      if (!data) return null;
      const { next, notices } = diffAlerts(readJson(STATE_KEY, {}), data.items, c.notifySell);
      writeJson(STATE_KEY, next);
      // 名單異動（新增／移出關注、AI 新增／移出建議）
      if (c.notifyListChanges && data.lists) {
        const r = diffLists(readJson<ListState>(LISTS_KEY, {}), data.lists, taipeiClock().day);
        writeJson(LISTS_KEY, r.next);
        notices.unshift(...r.notices);
      }
      notify(notices);
      window.dispatchEvent(new CustomEvent("stockradar:alert-checked", { detail: data }));
      return data;
    }

    async function tick() {
      if (stopped) return;
      let wait = 60;
      if (cfg?.enabled && hasTargets(cfg) && (cfg.strategyIds.length || cfg.notifyListChanges)) {
        const data = await runCheck(cfg);
        if (data) wait = data.marketOpen ? cfg.intervalSec : CLOSED_INTERVAL_SEC;
      }
      if (!stopped) timer.current = setTimeout(tick, wait * 1000);
    }

    async function checkNow() {
      await loadConfig();
      if (cfg && hasTargets(cfg)) await runCheck(cfg);
      else window.dispatchEvent(new CustomEvent("stockradar:alert-checked", { detail: null }));
    }

    /** 鬧鐘：時間到就響；勾了「附上訊號」時列出追蹤名單裡目前有訊號的股票 */
    async function alarmTick() {
      const alarms = cfg?.alarms ?? [];
      const fired = new Set(readJson<string[]>(FIRED_KEY, []));
      const due = dueAlarms(alarms, fired);
      if (due.length) {
        const day = taipeiClock().day;
        // 先記下「今天響過」再去抓訊號，避免抓資料期間下一輪又響一次；只留今天的紀錄
        writeJson(FIRED_KEY, [...[...fired].filter((k) => k.endsWith(day)), ...due.map((a) => `${a.id}|${day}`)]);
        const needSignals = due.some((a) => a.withSignals) && cfg && hasTargets(cfg) && cfg.strategyIds.length;
        const data = needSignals ? await fetchCheck() : null;
        for (const a of due) {
          const list: AlertNotice[] = [{ title: `⏰ ${a.time} ${a.label || "定時提醒"}`, body: "", tone: "info" }];
          if (a.withSignals && data) {
            const withSig = data.items.filter((it) => hasSignal(it, cfg?.notifySell ?? true));
            list[0].body = withSig.length ? `追蹤名單有 ${withSig.length} 檔出現訊號：` : `追蹤名單 ${data.items.length} 檔目前都沒有訊號`;
            list.push(...withSig.map((it) => ({ ...formatAlert(it), tone: it.lines.some((l) => l.current === "buy") ? ("buy" as const) : ("sell" as const) })));
          } else if (a.withSignals) {
            list[0].body = "（訊號暫時抓不到，或還沒設定追蹤名單與策略）";
          }
          notify(list);
        }
      }
      if (!stopped) alarmTimer.current = setTimeout(alarmTick, ALARM_TICK_MS);
    }

    async function restart() {
      if (timer.current) clearTimeout(timer.current);
      if (alarmTimer.current) clearTimeout(alarmTimer.current);
      await loadConfig();
      void tick();
      void alarmTick();
    }

    const onTest = () =>
      notify([
        { title: "2330 台積電（測試通知）", body: ["AI 策略：買進（建議買進）", "我的策略：觀察"].join("\n"), tone: "buy" },
      ]);

    void restart();
    window.addEventListener(ALERT_CONFIG_EVENT, restart);
    window.addEventListener(ALERT_CHECK_NOW_EVENT, checkNow);
    window.addEventListener(ALERT_TEST_EVENT, onTest);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      if (alarmTimer.current) clearTimeout(alarmTimer.current);
      window.removeEventListener(ALERT_CONFIG_EVENT, restart);
      window.removeEventListener(ALERT_CHECK_NOW_EVENT, checkNow);
      window.removeEventListener(ALERT_TEST_EVENT, onTest);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-4 top-20 z-[60] w-80 max-w-[calc(100vw-2rem)] space-y-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border-l-4 bg-(--surface-1) px-4 py-3 shadow-xl ${t.tone === "buy" ? "border-(--price-up)" : t.tone === "sell" ? "border-(--price-down)" : "border-(--accent)"}`}
        >
          <div className="flex items-start gap-2">
            <span className="text-lg">{t.tone === "info" ? "⏰" : "🔔"}</span>
            <div className="flex-1 text-sm">
              <div className="font-semibold">{t.title}</div>
              {t.body && <div className="whitespace-pre-line text-(--text-secondary)">{t.body}</div>}
            </div>
            <button type="button" aria-label="關閉通知" className="text-(--text-muted)" onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}>
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
