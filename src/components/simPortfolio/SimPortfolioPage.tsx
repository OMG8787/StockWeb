"use client";

import Link from "next/link";
import MarkdownLite from "../MarkdownLite";
import NavChart from "./NavChart";
import SimPortfolioHoldingsTable from "./SimPortfolioHoldingsTable";
import { fmtTime, ntd, pct, SIM_DISCLAIMER, tone, useSimPortfolio } from "./useSimPortfolio";

const card = "rounded-lg border border-(--gridline) bg-(--surface-1) p-4 sm:p-5";

/** /portfolio 完整頁：成效、淨值走勢、持股表、AI 每日檢討、交易紀錄、規則與成交假設。 */
export default function SimPortfolioPage() {
  const { data, failed } = useSimPortfolio();
  if (failed) return <p className="text-sm text-(--text-muted)">模擬投資組合目前無法取得，請稍後再試。</p>;
  if (!data) return <div className="h-96 animate-pulse rounded-lg border border-(--gridline) bg-(--surface-1)" aria-hidden />;
  const perf = data.perf;
  const r = data.rules;
  const signedPts = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
  return (
    <div className="space-y-5">
      <p className="rounded-md border border-(--gridline) bg-(--page-plane) px-3 py-2 text-[13px] leading-relaxed text-(--text-secondary)">
        ⚠️ {SIM_DISCLAIMER}
      </p>
      {!data.started || !perf ? (
        <section className={card}>
          <p className="text-sm text-(--text-secondary)">
            {data.enabled ? "還沒開始，下一個交易時點自動建倉。" : "這個環境沒有設定資料庫，模擬投資組合未啟用。"}
          </p>
        </section>
      ) : (
        <>
          <section className={card}>
            <h2 className="font-semibold">
              成效（{data.startDay} 起，初始 {ntd(data.initialCapital)} 元）
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="目前淨值" value={`${ntd(perf.nav)} 元`} />
              <Stat label="今日報酬" value={pct(perf.dayReturnPct)} cls={tone(perf.dayReturnPct)} />
              <Stat label="累計報酬" value={pct(perf.totalReturnPct)} cls={tone(perf.totalReturnPct)} />
              <Stat label="vs 0050（百分點）" value={signedPts(perf.vsEtfPct)} cls={tone(perf.vsEtfPct)} />
              <Stat label="同期 0050 買進持有" value={pct(perf.etfReturnPct)} cls={tone(perf.etfReturnPct)} />
              <Stat label="同期加權指數" value={pct(perf.indexReturnPct)} cls={tone(perf.indexReturnPct)} />
              <Stat label="已實現損益" value={`${ntd(perf.realized)} 元`} cls={tone(perf.realized)} />
              <Stat label="未實現損益" value={`${ntd(perf.unrealized)} 元`} cls={tone(perf.unrealized)} />
              <Stat label="最大回撤" value={`${perf.maxDrawdownPct.toFixed(2)}%`} />
              <Stat label="已平倉勝率" value={perf.winRatePct == null ? "—（尚無平倉）" : `${perf.winRatePct}%`} />
              <Stat label="平均獎勵（報酬−大盤）" value={pct(perf.avgRewardPct)} cls={tone(perf.avgRewardPct)} />
              <Stat label="交易次數／現金" value={`${perf.tradeCount} 筆／${ntd(data.cash ?? 0)}`} />
            </div>
            {data.lastRun && (
              <p className="mt-3 text-[12px] text-(--text-muted)">
                最近一次執行：{fmtTime(data.lastRun.at)}｜{data.lastRun.note}
              </p>
            )}
          </section>

          <section className={card}>
            <h2 className="font-semibold">累計報酬走勢</h2>
            <p className="mt-0.5 text-[12px] text-(--text-muted)">每個交易日一點（收盤後 13:35 那次為收盤淨值）；0050 只計價格、未含股利。</p>
            <div className="mt-2">
              <NavChart points={data.nav ?? []} initialCapital={data.initialCapital} base={data.base ?? { etf: null, index: null }} />
            </div>
          </section>

          <section className={card}>
            <h2 className="mb-2 font-semibold">目前持股（{data.holdings?.length ?? 0} 檔）</h2>
            <SimPortfolioHoldingsTable holdings={data.holdings ?? []} />
            <p className="mt-2 text-[12px] text-(--text-muted)">未實現損益已扣假設現在賣出的手續費與證交稅（跟關注清單同一套算法）。</p>
          </section>

          <section className={card}>
            <h2 className="font-semibold">AI 每日檢討</h2>
            {(data.reviews ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-(--text-muted)">每個交易日 13:35 收盤後交易完成時寫一篇。</p>
            ) : (
              <div className="mt-2 space-y-4">
                {(data.reviews ?? []).slice(0, 5).map((rv) => (
                  <article key={rv.day} className="border-l-2 border-(--gridline) pl-3">
                    <div className="text-[12px] text-(--text-muted)">
                      {rv.day}｜{rv.usedAi ? `由 ${rv.model ?? "AI"} 撰寫` : "本站程式版（AI 暫時無法使用）"}
                    </div>
                    <div className="mt-1 text-sm leading-relaxed text-(--text-secondary)">
                      <MarkdownLite text={rv.text} />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={card}>
            <h2 className="mb-2 font-semibold">交易紀錄</h2>
            {(data.trades ?? []).length === 0 ? (
              <p className="text-sm text-(--text-muted)">還沒有交易。</p>
            ) : (
              <ul className="divide-y divide-(--gridline)">
                {(data.trades ?? []).map((t, i) => (
                  <li key={`${t.at}-${t.symbol}-${i}`} className="py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span
                        className={`rounded px-1.5 text-[12px] ${t.side === "buy" ? "bg-(--price-up)/10 text-(--price-up)" : "bg-(--price-down)/10 text-(--price-down)"}`}
                      >
                        {t.side === "buy" ? "買進" : "賣出"}
                      </span>
                      <Link href={`/stock/${t.symbol}?market=TW`} className="font-medium hover:text-(--accent)">
                        {t.name} <span className="text-(--text-muted)">{t.symbol}</span>
                      </Link>
                      <span className="tabular-nums">
                        {t.shares.toLocaleString("en-US")} 股 @ {t.price}（{ntd(t.amount)} 元，費用 {ntd(t.fee)}）
                      </span>
                      {t.side === "sell" && (
                        <span className={`tabular-nums ${tone(t.realized)}`}>
                          已實現 {ntd(t.realized ?? 0)}（{pct(t.realizedPct)}，大盤 {pct(t.indexPct)}，獎勵 {pct(t.reward)}）
                        </span>
                      )}
                      <span className="ml-auto text-[12px] text-(--text-muted) tabular-nums">{fmtTime(t.at)}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] text-(--text-secondary)">
                      評等「{t.ratingLabel}」｜{t.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className={card}>
        <h2 className="font-semibold">規則（程式決定，AI 不參與買賣）</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-(--text-secondary)">
          <li>
            執行時點（台北時間平日）：{r.slots.map((s) => `${s.label}（${s.fill}）`).join("、")}；同一時點一天只執行一次，非交易日不交易。
          </li>
          <li>
            買進：候選＝當時「今日建議」名單中評等為「建議買進」的台股，依名單順序；每檔約淨值 {r.newPositionPct}%，最多 {r.maxPositions} 檔，單筆低於{" "}
            {ntd(r.minTradeAmount)} 元不做；當天漲幅 ≥ {r.limitLockPct}% 視為買不到。
          </li>
          <li>
            持有中：每個時點重讀本站評等並套上成本（停利）——「建議出場」全賣、「建議減碼」先賣一半（只減一次）、「可分批加碼」每次最多加 {r.addPositionPct}%、單檔上限{" "}
            {r.maxPositionPct}%；現價跌破上一個時點記下的「持有中出場價」就全部賣出。當天買的不因評等當天賣（停損除外）、當天賣的不買回；跌幅 ≥ {r.limitLockPct}%
            視為賣不掉。
          </li>
          <li>
            成本：手續費買賣各 {r.buyFeeRate}%、賣出證交稅 {r.sellTaxRate}%，逐項無條件捨去到元；股數以 1 股為單位（整張以外用零股），未計滑價與最低手續費。
          </li>
          <li>
            學習：每筆交易依據的評等記進評等紀錄（來源「AI模擬投資組合」），由每日學習工作算 1／5／20 日獎勵；平倉時另算「扣成本報酬 − 同期加權指數」獎勵；每天收盤後 AI
            依這些數字寫檢討並存進學習紀錄。
          </li>
          <li>對照組：{r.benchmark} 與加權指數從開始那天的價格起算（0050 只計價格、未含股利）。</li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md bg-(--page-plane) px-3 py-2">
      <div className="text-[12px] text-(--text-muted)">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
