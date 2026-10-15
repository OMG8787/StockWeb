"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import WatchlistButton from "@/components/WatchlistButton";
import PctLineChart from "@/components/charts/PctLineChart";
import { useFetchOnce } from "@/lib/useFetchOnce";
import { useTwQuotes } from "@/lib/useTwQuotes";
import { formatPercent, priceDirectionClass } from "@/lib/format";
import type { RecLedgerView } from "@/lib/ai/recLedger";
import {
  followOutcome,
  horizonReturn,
  recStats,
  returnCurve,
  REC_MAX_HOLD_DAYS,
  REC_SOURCE_LABEL,
  type RecEntry,
  type RecSource,
} from "@/lib/ai/recLedgerMath";

/**
 * 推薦回顧（2026-10-15 使用者：「要增加一個歷史回顧圖表，請記住現在推薦的買點、價格等資料，然後我會定期檢查看是否照建議操作會賺錢」）。
 * 資料：/api/rec-ledger（recLedger.ts 記的每一筆推薦＋之後每天的收盤價）；計算全部在 recLedgerMath.ts（前後端同一套）。
 * 持有中的股票用批次報價即時算「至今」。
 */

const PERIODS = [
  { id: 30, label: "近 30 天" },
  { id: 90, label: "近 90 天" },
  { id: 365, label: "全部（一年內）" },
] as const;

const th = "px-2 py-2 text-left text-xs font-medium text-(--text-muted) whitespace-nowrap";
const td = "px-2 py-2 text-sm whitespace-nowrap align-top";
const pctCell = (v: number | null) =>
  v == null ? <span className="text-(--text-muted)">—</span> : <span className={priceDirectionClass(v)}>{formatPercent(v)}</span>;
const fmtNum = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

function daysAgoKey(n: number): string {
  const t = new Date(Date.now() + 8 * 3_600_000);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

export default function ReviewClient() {
  const { data, failed } = useFetchOnce<RecLedgerView>("/api/rec-ledger");
  const [source, setSource] = useState<RecSource | "all">("all");
  const [period, setPeriod] = useState<number>(90);
  const [status, setStatus] = useState<"all" | "open" | "closed">("all");

  const inPeriod = useMemo(() => {
    const from = daysAgoKey(period);
    return (data?.entries ?? []).filter((e) => e.day >= from && (source === "all" || e.source === source));
  }, [data, source, period]);
  // 持有中（還沒照規則出場）的才需要即時價；批次 API 一次最多 100 檔
  const openSymbols = useMemo(
    () => [...new Set(inPeriod.filter((e) => !followOutcome(e).closed).map((e) => e.symbol.toUpperCase()))].slice(0, 100),
    [inPeriod],
  );
  const quotes = useTwQuotes(openSymbols);
  const live = useMemo(() => Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, q.price])), [quotes]);
  const bench = data?.bench ?? {};

  const rows = inPeriod
    .map((e) => ({ e, o: followOutcome(e, live[e.symbol.toUpperCase()]) }))
    .filter(({ o }) => status === "all" || (status === "open" ? !o.closed : o.closed));
  const stats = recStats(inPeriod, bench, live);
  const curves = (["ai", "momentum"] as RecSource[])
    .filter((s) => source === "all" || source === s)
    .map((s) => ({ s, curve: returnCurve(inPeriod.filter((e) => e.source === s), bench) }));
  const benchCurve = returnCurve(inPeriod, bench);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">📈 推薦回顧</h1>
        <p className="mt-1 text-sm text-(--text-secondary)">
          本站每次推薦（股票新進入「AI 建議名單」或「技術訊號共振股」）都會記下推薦當下的價格、買點區間與出場價，之後每個交易日收盤記一次價格，讓你回頭檢查「照建議操作到底賺不賺」。
          紀錄從 2026-10-15 開始累積，保存一年。
        </p>
      </div>

      <details className="rounded-md border border-(--gridline) bg-(--surface-1) px-3 py-2 text-sm text-(--text-secondary)">
        <summary className="cursor-pointer select-none text-(--accent)">「照建議操作」怎麼算？（點開看規則）</summary>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>買進：以推薦當下的價格買進（AI 名單＝評等計算價；共振股＝當天收盤價）。</li>
          <li>出場（依序看每個交易日，先發生的為準）：①收盤跌破建議的出場價（AI 名單才有）；②被移出名單，以移出時的價格賣出；③持有滿 {REC_MAX_HOLD_DAYS} 個交易日。</li>
          <li>都還沒發生＝「持有中」，報酬用現在的價格（盤中即時）。</li>
          <li>「固定持有 1／5／20 日」＝推薦價買進、第 N 個交易日收盤賣出，跟出場規則無關；0050 是同期（推薦當天收盤到第 N 天收盤）的報酬，方便比較。</li>
          <li>未計手續費與證交稅（來回約 0.6%）。過去表現不代表未來。</li>
        </ul>
      </details>

      <div className="flex flex-wrap gap-2 text-sm">
        {(["all", "ai", "momentum"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`rounded-full border px-3 py-1 ${source === s ? "border-(--accent) bg-(--accent)/10 font-semibold text-(--accent)" : "border-(--gridline) text-(--text-secondary)"}`}
          >
            {s === "all" ? "全部來源" : REC_SOURCE_LABEL[s]}
          </button>
        ))}
        <span className="mx-1 self-center text-(--gridline)">|</span>
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPeriod(p.id)}
            className={`rounded-full border px-3 py-1 ${period === p.id ? "border-(--accent) bg-(--accent)/10 font-semibold text-(--accent)" : "border-(--gridline) text-(--text-secondary)"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="text-sm text-(--text-muted)">推薦紀錄暫時無法取得，請稍後再試。</p>
      ) : !data ? (
        <div className="h-40 animate-pulse rounded-lg bg-(--page-plane)" />
      ) : inPeriod.length === 0 ? (
        <p className="rounded-lg border border-(--gridline) bg-(--surface-1) p-5 text-sm text-(--text-muted)">
          這段期間還沒有推薦紀錄（從 2026-10-15 開始累積：AI 建議名單有新股票進入時立即記錄，技術訊號共振股在每個交易日收盤後記錄）。
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card label="推薦筆數" value={`${stats.count} 筆`} sub={`已出場 ${stats.closed} 筆・持有中 ${stats.count - stats.closed} 筆`} />
            <Card
              label="照建議操作（已出場）"
              value={stats.avgClosed == null ? "—" : formatPercent(stats.avgClosed)}
              cls={stats.avgClosed == null ? "" : priceDirectionClass(stats.avgClosed)}
              sub={stats.winRate == null ? "還沒有出場的紀錄" : `勝率 ${stats.winRate.toFixed(0)}%（平均每筆報酬）`}
              tip="依上面的出場規則已經結算的推薦，平均每筆報酬與賺錢的比例"
            />
            <Card
              label="持有中（至今）"
              value={stats.avgOpen == null ? "—" : formatPercent(stats.avgOpen)}
              cls={stats.avgOpen == null ? "" : priceDirectionClass(stats.avgOpen)}
              sub="還沒觸發出場的推薦，以現價計算"
            />
            {stats.horizons.map((h) => (
              <Card
                key={h.h}
                label={`固定持有 ${h.h} 日`}
                value={h.avg == null ? "—" : formatPercent(h.avg)}
                cls={h.avg == null ? "" : priceDirectionClass(h.avg)}
                sub={h.n === 0 ? "樣本還沒滿 " + h.h + " 日" : `${h.n} 筆・勝率 ${h.winRate?.toFixed(0)}%・同期 0050 ${h.bench == null ? "—" : formatPercent(h.bench)}`}
                tip={`推薦價買進、第 ${h.h} 個交易日收盤賣出的平均報酬；同期 0050＝推薦當天收盤到第 ${h.h} 天收盤`}
              />
            ))}
          </div>

          <section className="rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
            <h2 className="font-semibold">推薦後第 N 個交易日的平均報酬</h2>
            <p className="mt-0.5 text-[12px] text-(--text-muted)">
              每條線＝該來源所有推薦在推薦後第 N 天的平均報酬（只算已經走到那天的推薦；滑鼠移到圖上看每一天的數值與樣本數）。灰線是同期 0050。
            </p>
            <div className="mt-2">
              <PctLineChart
                ariaLabel="推薦後平均報酬曲線"
                xLabels={benchCurve.map((c) => (c.day === 0 ? "推薦日" : `第 ${c.day} 日`))}
                series={[
                  ...curves.map(({ s, curve }) => ({
                    key: REC_SOURCE_LABEL[s],
                    color: s === "ai" ? "var(--accent)" : "#c98a1b",
                    values: curve.map((c) => (c.n > 0 ? c.avg : null)),
                    bold: s === "ai",
                  })),
                  { key: "0050（同期）", color: "var(--text-muted)", values: benchCurve.map((c) => (c.day === 0 ? 0 : c.bench)) },
                ]}
                hint={(i) => curves.map(({ s, curve }) => `${REC_SOURCE_LABEL[s]} 樣本 ${curve[i]?.n ?? 0} 筆`).join("、")}
              />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">每一筆推薦（{rows.length}）</h2>
              {(["all", "open", "closed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${status === s ? "border-(--accent) text-(--accent)" : "border-(--gridline) text-(--text-muted)"}`}
                >
                  {s === "all" ? "全部" : s === "open" ? "持有中" : "已出場"}
                </button>
              ))}
            </div>
            <div className="overflow-x-auto rounded-lg border border-(--gridline) bg-(--surface-1)">
              <table className="w-full min-w-[980px]">
                <thead className="border-b border-(--gridline)">
                  <tr>
                    <th className={th} aria-label="加入關注" />
                    <th className={th}>推薦時間</th>
                    <th className={th}>來源</th>
                    <th className={th}>股票</th>
                    <th className={th} title="推薦當下的價格（照建議操作以這個價格買進）">推薦價</th>
                    <th className={th} title="評等的支撐區（買點區間）與跌破出場價">買點區間／出場價</th>
                    <th className={th} title="推薦價買進、第 N 個交易日收盤賣出">1 日</th>
                    <th className={th}>5 日</th>
                    <th className={th}>20 日</th>
                    <th className={th} title="依出場規則：跌破出場價、移出名單或滿 20 個交易日">照建議操作</th>
                    <th className={th}>說明</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ e, o }) => (
                    <Row key={e.id} e={e} o={o} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ label, value, sub, cls = "", tip }: { label: string; value: string; sub: string; cls?: string; tip?: string }) {
  return (
    <div className="rounded-md border border-(--gridline) bg-(--surface-1) px-3 py-2" title={tip}>
      <div className="text-[12px] text-(--text-muted)">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="text-[12px] text-(--text-muted)">{sub}</div>
    </div>
  );
}

function Row({ e, o }: { e: RecEntry; o: ReturnType<typeof followOutcome> }) {
  const zone = e.zoneLow != null && e.zoneHigh != null ? `${fmtNum(e.zoneLow)}～${fmtNum(e.zoneHigh)}` : null;
  return (
    <tr className="border-b border-(--gridline) last:border-0 hover:bg-(--page-plane)">
      <td className="py-2 pl-2 align-top">
        <WatchlistButton symbol={e.symbol} market="TW" name={e.name} />
      </td>
      <td className={td}>
        {e.day}
        <span className="block text-xs text-(--text-muted)">{e.time}</span>
      </td>
      <td className={td}>
        <span className={`rounded px-1.5 py-0.5 text-xs ${e.source === "ai" ? "bg-(--accent)/15 text-(--accent)" : "bg-[#c98a1b]/15 text-[#c98a1b]"}`}>
          {e.source === "ai" ? "🎯 AI 建議" : "📡 共振"}
        </span>
        {e.rank != null && <span className="block text-xs text-(--text-muted)">第 {e.rank} 名</span>}
      </td>
      <td className={td}>
        <Link href={`/stock/${e.symbol}?market=TW`} prefetch={false} className="font-medium hover:text-(--accent)">
          {e.name}
        </Link>
        <span className="block text-xs text-(--text-muted)">{e.symbol}</span>
      </td>
      <td className={`${td} tabular-nums`}>{fmtNum(e.price)}</td>
      <td className={`${td} tabular-nums text-xs`}>
        {zone ? <span title="買點區間（支撐區）">{zone}</span> : <span className="text-(--text-muted)">—</span>}
        {e.stop != null && <span className="block text-(--text-muted)">跌破 {fmtNum(e.stop)} 出場</span>}
        {e.addAt != null && <span className="block text-(--text-muted)">拉回 {fmtNum(e.addAt)} 可加碼</span>}
      </td>
      <td className={`${td} tabular-nums`}>{pctCell(horizonReturn(e, 1))}</td>
      <td className={`${td} tabular-nums`}>{pctCell(horizonReturn(e, 5))}</td>
      <td className={`${td} tabular-nums`}>{pctCell(horizonReturn(e, 20))}</td>
      <td className={`${td} tabular-nums`}>
        {pctCell(o.pct)}
        <span className="block text-xs text-(--text-muted)">
          {o.closed ? `${o.day ?? ""} 出場 @ ${fmtNum(o.price)}` : `持有中・現價 ${fmtNum(o.price)}`}
        </span>
        <span className="block max-w-[180px] whitespace-normal text-xs text-(--text-muted)">{o.reason}</span>
      </td>
      <td className="max-w-[280px] px-2 py-2 align-top text-xs leading-relaxed text-(--text-secondary)">
        {e.label && <span className="block font-medium text-(--text-primary)">{e.label}</span>}
        {e.confidence && <span className="block">{e.confidence}</span>}
        {e.signals?.length ? <span className="block">訊號：{e.signals.join("、")}</span> : null}
      </td>
    </tr>
  );
}
