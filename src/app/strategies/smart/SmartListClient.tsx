"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import WatchlistButton from "@/components/WatchlistButton";
import { api, useList, type Strategy } from "@/components/strategy/api";
import { ALERT_CONFIG_EVENT } from "@/components/strategy/AlertWatcher";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";
import { useTwQuotes } from "@/lib/useTwQuotes";
import { formatPercent, priceDirectionClass } from "@/lib/format";
import {
  daysUntilRemoval,
  SMART_KEEP_DAYS,
  SMART_MAX_STRATEGIES,
  SMART_UNIVERSE,
  type SmartListConfig,
  type SmartListData,
} from "@/lib/strategy/smartListCore";

/**
 * 我的智能清單（2026-10-15 使用者要求，規則見 lib/strategy/smartListCore.ts）：
 * 選策略與兩個更新時間 → 排程每天依策略掃描全市場（成交值前 SMART_UNIVERSE 名）累積候選股；不符合先保留並註明、
 * SMART_KEEP_DAYS 天沒再符合才移除；即時提醒可以追蹤這份清單，用策略訊號篩出真正要通知的。
 * 設定跟即時提醒存在同一份（/api/strategy/alerts），這頁讀寫其中 smartList／trackSmartList 兩個欄位。
 */

type AlertCfg = Record<string, unknown> & { smartList: SmartListConfig; trackSmartList: boolean };

const fmtTime = (iso: string) => {
  const t = new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString();
  return `${t.slice(5, 10).replace("-", "/")} ${t.slice(11, 16)}`;
};
const fmtNum = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export default function SmartListClient() {
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [alertCfg, setAlertCfg] = useState<AlertCfg | null>(null);
  const [draft, setDraft] = useState<SmartListConfig | null>(null);
  const [data, setData] = useState<SmartListData | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "ok" | "no">("all");

  useEffect(() => {
    Promise.all([api<{ config: AlertCfg }>("/api/strategy/alerts"), api<{ data: SmartListData }>("/api/strategy/smart-list")])
      .then(([a, s]) => {
        setAlertCfg(a.config);
        setDraft(a.config.smartList);
        setData(s.data);
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const shown = entries.filter((e) => (filter === "all" ? true : filter === "ok" ? e.qualified : !e.qualified));
  const symbols = useMemo(() => entries.map((e) => e.symbol).slice(0, 100), [entries]);
  const quotes = useTwQuotes(symbols);

  async function save(next: SmartListConfig, trackSmartList = alertCfg?.trackSmartList ?? false) {
    if (!alertCfg) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ config: AlertCfg }>("/api/strategy/alerts", { body: { ...alertCfg, smartList: next, trackSmartList } });
      setAlertCfg(r.config);
      setDraft(r.config.smartList);
      window.dispatchEvent(new Event(ALERT_CONFIG_EVENT));
      setMsg({
        ok: true,
        text: `已儲存：智能清單${r.config.smartList.enabled ? `開啟，每個交易日 ${r.config.smartList.times.join("、")} 更新` : "關閉"}${r.config.trackSmartList ? "；即時提醒會追蹤這份清單" : ""}`,
      });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ data: SmartListData; note: string }>("/api/strategy/smart-list", {
        body: { action: "run" },
        busyText: `更新智能清單中…（掃描約 ${SMART_UNIVERSE} 檔，第一次約 30～90 秒）`,
      });
      setData(r.data);
      setMsg({ ok: true, text: `更新完成：${r.note}` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const toggleStrategy = (id: string) => {
    if (!draft) return;
    const has = draft.strategyIds.includes(id);
    if (!has && draft.strategyIds.length >= SMART_MAX_STRATEGIES) return setMsg({ ok: false, text: `最多選 ${SMART_MAX_STRATEGIES} 個策略` });
    setDraft({ ...draft, strategyIds: has ? draft.strategyIds.filter((x) => x !== id) : [...draft.strategyIds, id] });
  };
  const okCount = entries.filter((e) => e.qualified).length;

  return (
    <div className="space-y-4 pb-16">
      <LabTabs
        active="/strategies/smart"
        intro={`依你選的策略，每個交易日在你設定的兩個時間掃描全市場（成交值前 ${SMART_UNIVERSE} 名），把符合的股票加進清單；之後不符合也先保留並註明哪些條件不成立，${SMART_KEEP_DAYS} 天內沒有再符合才移除。清單刻意放寬，再交給「即時提醒」用策略訊號篩出真正要通知的。`}
      />
      {msg && <p className={`text-sm ${msg.ok ? "text-(--price-down)" : "text-(--price-up)"}`}>{msg.text}</p>}

      <section className={`${cardCls} space-y-3 text-sm`}>
        <h2 className="font-semibold">⚙️ 設定</h2>
        {!draft ? (
          <div className="h-24 animate-pulse rounded bg-(--page-plane)" />
        ) : (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              開啟智能清單（每個交易日自動更新）
            </label>
            <div className="space-y-1">
              <div>用哪些策略選股（最多 {SMART_MAX_STRATEGIES} 個，任一個的買進條件成立就加入）</div>
              {strategies.items && strategies.items.length === 0 ? (
                <p className="text-(--text-muted)">
                  還沒有策略：到 <Link href="/strategies" className="text-(--accent) underline">🧠 策略庫</Link> 建立，或用「🤖 AI 策略」「📚 策略範本」一鍵建立。
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(strategies.items ?? []).map((s) => (
                    <label
                      key={s.id}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${draft.strategyIds.includes(s.id) ? "border-(--accent) bg-(--accent)/10" : "border-(--gridline)"}`}
                      title={s.summary}
                    >
                      <input type="checkbox" checked={draft.strategyIds.includes(s.id)} onChange={() => toggleStrategy(s.id)} />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {[0, 1].map((i) => (
                <label key={i} className="block space-y-1">
                  <span>更新時間 {i + 1}</span>
                  <input
                    type="time"
                    step={300}
                    value={draft.times[i] ?? ""}
                    onChange={(e) => {
                      const times = [...draft.times];
                      times[i] = e.target.value;
                      setDraft({ ...draft, times });
                    }}
                    className={`${inputCls} !w-32`}
                  />
                </label>
              ))}
              <p className="basis-full text-xs text-(--text-muted)">
                台北時間、週一～五。盤中（09:00～13:30）用即時價判斷，收盤後用收盤價；排程每 5 分鐘檢查一次，時間到後幾分鐘內會跑。
              </p>
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={alertCfg?.trackSmartList ?? false} onChange={(e) => alertCfg && setAlertCfg({ ...alertCfg, trackSmartList: e.target.checked })} />
              <span>
                即時提醒也追蹤這份清單
                <span className="block text-xs text-(--text-muted)">
                  符合中的排前面；要通知哪些策略訊號、檢查間隔在 <Link href="/strategies/alerts" className="text-(--accent) underline">🔔 即時提醒</Link> 設定（要開啟策略訊號提醒才會通知）
                </span>
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => save({ ...draft, times: draft.times.filter(Boolean) })}>
                儲存設定
              </button>
              <button type="button" className={btnGhost} disabled={busy || (alertCfg?.smartList.strategyIds.length ?? 0) === 0} onClick={runNow} title="用已儲存的策略立即掃描一次">
                ▶ 立即更新一次
              </button>
            </div>
          </>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">🧠 我的智能清單（{entries.length}）</h2>
          {(["all", "ok", "no"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === f ? "border-(--accent) text-(--accent)" : "border-(--gridline) text-(--text-muted)"}`}
            >
              {f === "all" ? `全部 ${entries.length}` : f === "ok" ? `✅ 符合 ${okCount}` : `⚠️ 暫不符合 ${entries.length - okCount}`}
            </button>
          ))}
        </div>
        {!data ? (
          <div className="h-32 animate-pulse rounded-lg bg-(--page-plane)" />
        ) : shown.length === 0 ? (
          <p className={`${cardCls} text-sm text-(--text-muted)`}>
            {entries.length === 0 ? "清單還是空的：選好策略、儲存後按「立即更新一次」，或等排定時間自動更新。" : "這個分類沒有股票。"}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-(--gridline)">
                <tr className="text-left text-xs text-(--text-muted)">
                  <th className="px-2 py-2" aria-label="加入關注" />
                  <th className="px-2 py-2 font-medium">股票</th>
                  <th className="px-2 py-2 font-medium">狀態</th>
                  <th className="px-2 py-2 text-right font-medium" title="加入清單時的價格 → 現在">加入價 → 現價</th>
                  <th className="px-2 py-2 font-medium">符合的策略／不成立的條件</th>
                  <th className="px-2 py-2 font-medium" title="第一次加入、最近一次符合的時間">加入／最近符合</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const q = quotes[e.symbol.toUpperCase()];
                  const now = q?.price ?? e.lastPrice;
                  const since = e.addedPrice && now ? (now / e.addedPrice - 1) * 100 : null;
                  const left = daysUntilRemoval(e);
                  return (
                    <tr key={e.symbol} className="border-b border-(--gridline) align-top last:border-0 hover:bg-(--page-plane)">
                      <td className="py-2 pl-2">
                        <WatchlistButton symbol={e.symbol} market="TW" name={e.name} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <Link href={`/stock/${e.symbol}?market=TW`} prefetch={false} className="font-medium hover:text-(--accent)">
                          {e.name}
                        </Link>
                        <span className="block text-xs text-(--text-muted)">{e.symbol}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {e.qualified ? (
                          <span className="rounded bg-(--price-down)/12 px-1.5 py-0.5 text-xs font-medium text-(--price-down)">✅ 符合</span>
                        ) : (
                          <span className="rounded bg-(--page-plane) px-1.5 py-0.5 text-xs font-medium text-(--text-secondary)" title={`最近一次符合超過 ${SMART_KEEP_DAYS} 天就移除`}>
                            ⚠️ 暫不符合
                            {left != null && <span className="ml-1 text-(--text-muted)">（{left} 天後移除）</span>}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {fmtNum(e.addedPrice)} → {fmtNum(now)}
                        <span className={`block text-xs ${since == null ? "text-(--text-muted)" : priceDirectionClass(since)}`}>{since == null ? "—" : formatPercent(since)}</span>
                      </td>
                      <td className="max-w-[340px] px-2 py-2 text-xs leading-relaxed text-(--text-secondary)">
                        {e.qualified ? (
                          <span>符合：{e.strategies.join("、")}</span>
                        ) : (
                          e.failing.map((f) => (
                            <span key={f} className="block">
                              不成立：{f}
                            </span>
                          ))
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs text-(--text-muted)">
                        加入 {fmtTime(e.addedAt)}
                        <span className="block">符合 {fmtTime(e.lastQualifiedAt)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && data.runs.length > 0 && (
        <details className={`${cardCls} text-sm`}>
          <summary className="cursor-pointer select-none font-semibold">📜 更新紀錄（最近 {Math.min(10, data.runs.length)} 次）</summary>
          <ul className="mt-2 space-y-1 text-xs text-(--text-secondary)">
            {data.runs.slice(0, 10).map((r) => (
              <li key={r.slotKey + r.at}>
                <span className="text-(--text-muted)">
                  {fmtTime(r.at)}（{r.slot === "manual" ? "手動" : `排定 ${r.slot}`}）
                </span>{" "}
                {r.note || `掃描 ${r.scanned} 檔`}；新加入 {r.added}、移除 {r.removed}、目前符合 {r.qualified}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
