"use client";

import Link from "next/link";
import { useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import PctLineChart from "@/components/charts/PctLineChart";
import { api, money, pct, upDownCls, useList, type Strategy } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";
import { getWatchlist } from "@/lib/watchlist";
import type { BacktestResult } from "@/lib/strategy/backtest";
import type { ActionBrief } from "@/lib/ai/actionBrief";

/**
 * 策略回測頁（2026-10-15 使用者：「開一個模擬，用策略回顧之前的功能，看能回顧多少，拉到 1-3 年前查看是否照策略會賺」）。
 * 計算在伺服器（/api/strategy/backtest → lib/strategy/backtest.ts）；這頁只負責選策略、股票、期間與顯示結果。
 */

interface Resp {
  strategy: { id: string; name: string };
  years: number;
  symbols: string[];
  result: BacktestResult;
}

const MAX = 30;
const parseSymbols = (t: string) => [...new Set(t.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX);
const th = "px-2 py-2 text-left text-xs font-medium text-(--text-muted) whitespace-nowrap";
const td = "px-2 py-2 text-sm whitespace-nowrap";

/** 圖上最多畫幾個點（約每週一點，SVG 才不會太重） */
function sample<T>(arr: T[], max = 160): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => arr[Math.round(i * step)]);
}

export default function BacktestClient() {
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [strategyId, setStrategyId] = useState("");
  const [text, setText] = useState("2330 2317 2454 2308 2382 2881 2412 1301 2603 3711");
  const [years, setYears] = useState(1);
  const [cash, setCash] = useState(1_000_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const chosen = strategyId || strategies.items?.[0]?.id || "";
  const symbols = parseSymbols(text);

  async function fillAiList() {
    try {
      const r = await fetch("/api/action-brief");
      const b = (await r.json()) as { actionBrief?: ActionBrief };
      const list = (b.actionBrief?.listPicks ?? b.actionBrief?.picks ?? []).map((p) => p.symbol);
      if (list.length) setText(list.join(" "));
      else setError("AI 建議名單目前是空的");
    } catch {
      setError("AI 建議名單暫時讀不到");
    }
  }

  async function run() {
    setBusy(true);
    setError("");
    try {
      setData(
        await api<Resp>("/api/strategy/backtest", {
          body: { strategyId: chosen, symbols, years, initialCash: cash },
          busyText: `回測中…（${symbols.length} 檔 × ${years} 年，第一次抓歷史日K約 10～60 秒）`,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const r = data?.result;
  const curve = r ? sample(r.curve) : [];
  return (
    <div className="space-y-4">
      <LabTabs
        active="/strategies/backtest"
        intro="用你的策略回頭跑過去 1～3 年：每天收盤後只用當時看得到的日K判斷，隔天開盤成交，看照策略操作會不會賺，並對照同期買進 0050 持有。"
      />

      <section className={`${cardCls} space-y-3 text-sm`}>
        <label className="block space-y-1">
          <span>策略</span>
          {strategies.items && strategies.items.length === 0 ? (
            <p className="text-(--text-muted)">
              還沒有策略，先到 <Link href="/strategies" className="text-(--accent) underline">🧠 策略庫</Link> 建立（也可以從策略範本一鍵建立）。
            </p>
          ) : (
            <select value={chosen} onChange={(e) => setStrategyId(e.target.value)} className={`${inputCls} !w-auto`}>
              {(strategies.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="block space-y-1">
          <span>股票（代號用空白或逗號分開，最多 {MAX} 檔；目前 {symbols.length} 檔）</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className={inputCls} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={() => setText(getWatchlist().filter((w) => w.market === "TW").map((w) => w.symbol).slice(0, MAX).join(" "))}>
            ⭐ 帶入我的關注清單（台股）
          </button>
          <button type="button" className={btnGhost} onClick={fillAiList}>
            🎯 帶入目前 AI 建議名單
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="block space-y-1">
            <span>回測期間</span>
            <select value={years} onChange={(e) => setYears(Number(e.target.value))} className={`${inputCls} !w-auto`}>
              {[1, 2, 3].map((y) => (
                <option key={y} value={y}>
                  最近 {y} 年
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span>初始資金（元）</span>
            <input type="number" min={10000} step={10000} value={cash} onChange={(e) => setCash(Number(e.target.value))} className={`${inputCls} !w-40`} />
          </label>
          <button type="button" className={btnPrimary} disabled={busy || !chosen || symbols.length === 0} onClick={run}>
            {busy ? "回測中…" : "▶ 開始回測"}
          </button>
        </div>
        {error && <p className="text-(--price-up)">{error}</p>}
        <details className="text-xs text-(--text-muted)">
          <summary className="cursor-pointer select-none text-(--accent)">回測規則與限制（點開看）</summary>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>每個交易日收盤後，只用「截到那天」的日K判斷（不偷看未來）；訂單在下一個交易日以開盤價成交，手續費與證交稅照實扣。</li>
            <li>停損、停利、最長持有天數、每檔投入比例、最多持有檔數都照策略設定（跟模擬倉同一套）。</li>
            <li>籌碼（法人買賣超）、基本面（本益比、殖利率、月營收）、本站綜合評等、即時五檔沒有逐日的歷史資料，回測時這些條件一律當作「不成立」——結果會列出被影響的條件。</li>
            <li>股價只做分割調整、不含股息（0050 對照也一樣）；股票名單是你現在選的，已下市的股票不在裡面（倖存者偏差），結果可能比實際好。</li>
            <li>過去績效不代表未來。</li>
          </ul>
        </details>
      </section>

      {r && data && (
        <>
          {r.unsupported.length > 0 && (
            <p className="rounded-md border border-(--price-up) px-3 py-2 text-sm">
              ⚠️ 這個策略的「{r.unsupported.join("、")}」沒有歷史資料，回測時一律當作不成立；如果它們是買進的必要條件，回測可能幾乎不會買進。
            </p>
          )}
          {r.skipped.length > 0 && <p className="text-xs text-(--text-muted)">略過（抓不到歷史日K或資料太短）：{r.skipped.join("、")}</p>}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={`總報酬（${r.start}～${r.end}）`} value={pct(r.totalReturnPct)} cls={upDownCls(r.totalReturnPct)} sub={`期末淨值 ${money(r.finalEquity)} 元`} />
            <Stat label="同期 0050（買進持有）" value={r.benchReturnPct == null ? "—" : pct(r.benchReturnPct)} cls={r.benchReturnPct == null ? "" : upDownCls(r.benchReturnPct)} sub={r.benchReturnPct == null ? "" : `策略 ${r.totalReturnPct >= r.benchReturnPct ? "贏" : "輸"} ${Math.abs(r.totalReturnPct - r.benchReturnPct).toFixed(2)} 個百分點`} />
            <Stat label="年化報酬" value={pct(r.cagrPct)} cls={upDownCls(r.cagrPct)} sub={`${r.tradingDays} 個交易日`} />
            <Stat label="最大回撤" value={`${r.maxDrawdownPct.toFixed(2)}%`} cls="text-(--price-down)" sub="淨值從高點最多跌掉多少" tip="期間內淨值從最高點往下跌的最大幅度，越接近 0 越穩" />
            <Stat label="交易次數" value={`買 ${r.stats.buys}／賣 ${r.stats.sells}`} sub={r.stats.avgHoldDays == null ? "" : `平均持有 ${r.stats.avgHoldDays.toFixed(1)} 個交易日`} />
            <Stat label="勝率（已賣出）" value={r.stats.winRate == null ? "—" : `${r.stats.winRate.toFixed(0)}%`} sub={`${r.stats.wins}/${r.stats.sells} 筆賺錢`} />
            <Stat label="已實現損益" value={`${money(r.stats.realized)} 元`} cls={upDownCls(r.stats.realized)} sub={`手續費＋證交稅 ${money(r.stats.fees)} 元`} />
            <Stat label="期末持股" value={`${r.openPositions.length} 檔`} sub="以最後收盤計入淨值" />
          </div>

          <section className={cardCls}>
            <h2 className="font-semibold">累計報酬走勢</h2>
            <p className="mt-0.5 text-[12px] text-(--text-muted)">策略淨值相對初始資金的報酬 % 與同期 0050（約每週一點；滑鼠移到圖上看數值）。</p>
            <div className="mt-2">
              <PctLineChart
                ariaLabel="策略回測累計報酬"
                xLabels={curve.map((c) => c.day)}
                series={[
                  { key: `策略「${data.strategy.name}」`, color: "var(--accent)", values: curve.map((c) => c.pct), bold: true },
                  { key: "0050", color: "var(--text-muted)", values: curve.map((c) => c.bench) },
                ]}
              />
            </div>
          </section>

          {r.perStock.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-semibold">各股票已實現損益</h2>
              <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
                <table className="w-full">
                  <thead className="border-b border-(--gridline)">
                    <tr>
                      {["股票", "賣出次數", "已實現損益（元）"].map((h) => (
                        <th key={h} className={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.perStock.map((p) => (
                      <tr key={p.symbol} className="border-b border-(--gridline) last:border-0">
                        <td className={td}>
                          {p.name} <span className="text-(--text-muted)">{p.symbol}</span>
                        </td>
                        <td className={td}>{p.sells}</td>
                        <td className={`${td} ${upDownCls(p.realized)}`}>{money(p.realized)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-semibold">交易明細（最近 {Math.min(300, r.trades.length)} 筆，新到舊）</h2>
            {r.trades.length === 0 ? (
              <p className="text-sm text-(--text-muted)">這段期間策略沒有觸發任何交易。</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
                <table className="w-full min-w-[760px]">
                  <thead className="border-b border-(--gridline)">
                    <tr>
                      {["日期", "買賣", "股票", "股數", "成交價", "費用", "損益", "原因"].map((h) => (
                        <th key={h} className={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...r.trades].reverse().map((t, i) => (
                      <tr key={`${t.day}-${t.symbol}-${i}`} className="border-b border-(--gridline) last:border-0">
                        <td className={td}>{t.day}</td>
                        <td className={`${td} ${t.side === "buy" ? "text-(--price-up)" : "text-(--price-down)"}`}>{t.side === "buy" ? "買" : "賣"}</td>
                        <td className={td}>
                          {t.name} <span className="text-(--text-muted)">{t.symbol}</span>
                        </td>
                        <td className={td}>{t.shares.toLocaleString()}</td>
                        <td className={td}>{t.price}</td>
                        <td className={td}>{money(t.fee)}</td>
                        <td className={`${td} ${t.pnl != null ? upDownCls(t.pnl) : ""}`}>{t.pnl != null ? money(t.pnl) : "—"}</td>
                        <td className="max-w-[320px] px-2 py-2 text-xs text-(--text-secondary)">{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, cls = "", tip }: { label: string; value: string; sub?: string; cls?: string; tip?: string }) {
  return (
    <div className="rounded-md border border-(--gridline) bg-(--surface-1) px-3 py-2" title={tip}>
      <div className="text-[12px] text-(--text-muted)">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[12px] text-(--text-muted)">{sub}</div>}
    </div>
  );
}
