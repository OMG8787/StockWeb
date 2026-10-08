"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 即時提醒（2026-10-08 使用者要求「名單 10～30 秒追蹤一次，碰到策略買賣訊號就跳全站通知」）。
 * 掛在 layout，任何頁面都在跑：照設定的間隔呼叫 /api/strategy/alerts/check，
 * 跟上一次的訊號比較，有「變成買進／變成賣出」或「全部策略都買進」就跳右上角通知，
 * 有開瀏覽器通知權限時也送系統通知（分頁在背景也看得到）。
 *
 * 限制：要有開著網站的分頁才會檢查（沒有另外的推播伺服器）；非交易時段改成 5 分鐘檢查一次。
 * 上一次的訊號記在 localStorage，重新整理不會重複通知。
 */

export const ALERT_CONFIG_EVENT = "stockradar:alert-config-changed";
const STATE_KEY = "sw_alert_state";
const CLOSED_INTERVAL_SEC = 300;

type Signal = "buy" | "sell" | null;
interface CheckItem {
  symbol: string;
  name: string;
  price: number | null;
  allBuy: boolean;
  lines: Array<{ id: string; name: string; current: Signal; summary: string }>;
}
interface CheckResult {
  at: string;
  marketOpen: boolean;
  items: CheckItem[];
}
interface Toast {
  id: string;
  title: string;
  body: string;
  tone: "buy" | "sell";
}

function readState(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeState(s: Record<string, string>) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    // 存不了就算了（無痕模式），最多重新整理後重複通知一次
  }
}

/** 比對新舊訊號，回傳要通知的內容（純函式，方便測試） */
export function diffAlerts(prev: Record<string, string>, items: CheckItem[]): { next: Record<string, string>; toasts: Omit<Toast, "id">[] } {
  const next: Record<string, string> = {};
  const toasts: Omit<Toast, "id">[] = [];
  for (const it of items) {
    const label = `${it.name}（${it.symbol}）${it.price != null ? ` ${it.price}` : ""}`;
    for (const l of it.lines) {
      const key = `${it.symbol}|${l.id}`;
      const cur = l.current ?? "";
      next[key] = cur;
      if (key in prev && prev[key] !== cur && (l.current === "buy" || l.current === "sell")) {
        toasts.push({ title: label, body: `${l.name}：出現${l.current === "buy" ? "買進" : "賣出"}訊號（${l.summary}）`, tone: l.current });
      }
    }
    const allKey = `${it.symbol}|__all__`;
    next[allKey] = it.allBuy ? "1" : "";
    if (it.allBuy && prev[allKey] !== "1" && it.lines.length > 1) {
      toasts.push({ title: label, body: `✅ 全部 ${it.lines.length} 個策略都是買進訊號`, tone: "buy" });
    }
  }
  return { next, toasts };
}

export default function AlertWatcher() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;
    let cfg: { enabled: boolean; intervalSec: number; symbols: string[]; strategyIds: string[] } | null = null;

    async function loadConfig() {
      try {
        const r = await fetch("/api/strategy/alerts", { cache: "no-store" });
        cfg = r.ok ? (await r.json()).config : null;
      } catch {
        cfg = null;
      }
    }

    function notify(list: Omit<Toast, "id">[]) {
      if (list.length === 0) return;
      const withId = list.map((t, i) => ({ ...t, id: `${Date.now()}-${i}` }));
      setToasts((prev) => [...withId, ...prev].slice(0, 6));
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const t of list) {
          try {
            new Notification(`股情雷達：${t.title}`, { body: t.body, tag: `${t.title}-${t.body}` });
          } catch {
            // 部分手機瀏覽器不支援 new Notification，畫面上的通知還是會出現
          }
        }
      }
    }

    async function tick() {
      if (stopped) return;
      let wait = 60;
      if (cfg?.enabled && cfg.symbols.length && cfg.strategyIds.length) {
        try {
          const r = await fetch("/api/strategy/alerts/check", { method: "POST", cache: "no-store" });
          if (r.ok) {
            const data = (await r.json()) as CheckResult;
            const { next, toasts: list } = diffAlerts(readState(), data.items);
            writeState(next);
            notify(list);
            window.dispatchEvent(new CustomEvent("stockradar:alert-checked", { detail: data }));
            wait = data.marketOpen ? cfg.intervalSec : CLOSED_INTERVAL_SEC;
          } else {
            wait = 60;
          }
        } catch {
          wait = 60;
        }
      }
      if (!stopped) timer.current = setTimeout(tick, wait * 1000);
    }

    async function restart() {
      if (timer.current) clearTimeout(timer.current);
      await loadConfig();
      void tick();
    }

    void restart();
    window.addEventListener(ALERT_CONFIG_EVENT, restart);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener(ALERT_CONFIG_EVENT, restart);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-4 top-20 z-[60] w-80 max-w-[calc(100vw-2rem)] space-y-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border-l-4 bg-(--surface-1) px-4 py-3 shadow-xl ${t.tone === "buy" ? "border-(--price-up)" : "border-(--price-down)"}`}
        >
          <div className="flex items-start gap-2">
            <span className="text-lg">🔔</span>
            <div className="flex-1 text-sm">
              <div className="font-semibold">{t.title}</div>
              <div className="text-(--text-secondary)">{t.body}</div>
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
