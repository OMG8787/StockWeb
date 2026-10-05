import type { Metadata } from "next";
import { readLearningSummary } from "@/lib/ai/learning/learningStore";
import { describeBasis } from "@/lib/ai/learning/features";
import { REGIME_LABEL } from "@/lib/ai/learning/regime";
import { SCOREBOARD_MIN_SAMPLES } from "@/lib/ai/learning/summary";
import { WEIGHT_HALF_LIFE_TRADING_DAYS, WEIGHT_PRIOR_STRENGTH } from "@/lib/ai/learning/weights";
import { MISS_EXCESS_THRESHOLD_PCT, REWARD_MDD_PENALTY, TRADE_COST_PCT } from "@/lib/ai/learning/reward";
import { LESSONS } from "@/lib/ai/lessons";
import { RATING_LABEL } from "@/lib/ai/siteRating";
import { AI_ADJUST_AFFECTS_CONCLUSION, AI_ADJUST_PROMOTION } from "@/lib/ai/learning/aiAdjust";

/**
 * 成績看板（AI 學習循環第一階段）：只讀每日學習工作存在 Redis 的彙總（learning/learningStore.ts），
 * 不現場計算。src/proxy.ts 的密碼閘涵蓋這頁。
 */
export const metadata: Metadata = {
  title: "成績看板",
  description: "本站綜合評等的實際成績：各結論的勝率、超額報酬與獎勵，各判斷依據的權重，以及教訓清單。",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

/** 判斷依據表最多列幾列（依筆數排序）。 */
const BASIS_ROWS_MAX = 80;

const card = "rounded-lg border border-(--gridline) bg-(--surface-1) p-4";
const th = "px-2 py-1 text-left font-medium text-(--text-muted) whitespace-nowrap";
const td = "px-2 py-1 whitespace-nowrap tabular-nums";

const fmtPct = (v: number | null | undefined, signed = true) =>
  v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v}%`;
const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-(--price-up)" : v < 0 ? "text-(--price-down)" : "");

function Insufficient({ n, min }: { n: number; min: number }) {
  return n < min ? <span className="ml-1 rounded bg-(--page-plane) px-1 text-[12px] text-(--text-muted)">樣本不足</span> : null;
}

export default async function ScoreboardPage() {
  const s = await readLearningSummary().catch(() => null);
  const cc = s?.championChallenger;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">📊 成績看板</h1>
        <p className="text-sm leading-relaxed text-(--text-secondary)">
          本站綜合評等每一筆都會記錄，滿 1／5／20 個交易日後對照加權指數算成績。獎勵＝超額報酬（減加權指數）
          －交易成本 {TRADE_COST_PCT}%－最大回撤×{REWARD_MDD_PENALTY}；「等回檔／先不要買」之後超額 &gt; {MISS_EXCESS_THRESHOLD_PCT}%
          算錯失（負獎勵）、之後落後大盤算判斷正確（正獎勵）。統計需要約 1～3 個月累積才有意義。
        </p>
        <p className="text-[13px] text-(--text-muted)">
          {s
            ? `最後更新：${new Date(s.generatedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}（台北）；已算出成績 ${s.evaluated} 筆（滿1日 ${s.matured["1"] ?? 0}、滿5日 ${s.matured["5"] ?? 0}、滿20日 ${s.matured["20"] ?? 0}）`
            : "尚未產生彙總（每日台股收盤後自動計算；評等紀錄 2026-10-05 開始累積）。"}
        </p>
      </header>

      <section className={card}>
        <h2 className="font-semibold">各結論成績</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>結論</th>
                <th className={th}>期間</th>
                <th className={th}>筆數</th>
                <th className={th}>判斷正確率</th>
                <th className={th}>上漲比例</th>
                <th className={th}>平均超額</th>
                <th className={th}>平均獎勵</th>
              </tr>
            </thead>
            <tbody>
              {(s?.byCode ?? []).map((r) => (
                <tr key={`${r.code}-${r.h}`} className="border-t border-(--gridline)">
                  <td className={td}>{RATING_LABEL[r.code]}</td>
                  <td className={td}>{r.h}日</td>
                  <td className={td}>
                    {r.n}
                    <Insufficient n={r.n} min={SCOREBOARD_MIN_SAMPLES} />
                  </td>
                  <td className={td}>{fmtPct(r.winRate, false)}</td>
                  <td className={td}>{fmtPct(r.upRate, false)}</td>
                  <td className={`${td} ${tone(r.avgExcess)}`}>{fmtPct(r.avgExcess)}</td>
                  <td className={`${td} ${tone(r.avgReward)}`}>{fmtPct(r.avgReward)}</td>
                </tr>
              ))}
              {!s && (
                <tr>
                  <td className={td} colSpan={7}>
                    尚無資料
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[13px] text-(--text-muted)">判斷正確率＝結論獎勵 &gt; 0 的比例；筆數少於 {SCOREBOARD_MIN_SAMPLES} 標「樣本不足」。</p>
      </section>

      <section className={card}>
        <h2 className="font-semibold">冠軍／挑戰者：程式評等 vs AI 調整後</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-(--text-muted)">
          AI 判斷層會依新聞、產業、大盤情緒、相似案例與教訓，對程式評等「調升一級／維持／調降一級」。只拿有 AI 判斷的同一批紀錄配對比較；
          目前 AI 調整{AI_ADJUST_AFFECTS_CONCLUSION ? "已" : "不"}改變網站上的主結論（只顯示一行「AI 看法」）。
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>期間</th>
                <th className={th}>筆數</th>
                <th className={th}>AI 有調整</th>
                <th className={th}>程式評等 勝率</th>
                <th className={th}>程式評等 平均獎勵</th>
                <th className={th}>AI 調整後 勝率</th>
                <th className={th}>AI 調整後 平均獎勵</th>
              </tr>
            </thead>
            <tbody>
              {(cc?.rows ?? []).map((r) => (
                <tr key={r.h} className="border-t border-(--gridline)">
                  <td className={td}>{r.h}日</td>
                  <td className={td}>
                    {r.n}
                    <Insufficient n={r.n} min={SCOREBOARD_MIN_SAMPLES} />
                  </td>
                  <td className={td}>{r.adjustedN}</td>
                  <td className={td}>{fmtPct(r.program.winRate, false)}</td>
                  <td className={`${td} ${tone(r.program.avgReward)}`}>{fmtPct(r.program.avgReward)}</td>
                  <td className={td}>{fmtPct(r.ai.winRate, false)}</td>
                  <td className={`${td} ${tone(r.ai.avgReward)}`}>{fmtPct(r.ai.avgReward)}</td>
                </tr>
              ))}
              {!cc && (
                <tr>
                  <td className={td} colSpan={7}>
                    尚無資料（AI 判斷 2026-10-05 起寫入評等紀錄，滿 1 個交易日後才有成績）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-[13px] leading-relaxed text-(--text-muted)">
          <div>
            「AI 調整」這個依據的權重：
            {cc && cc.aiBasis.length > 0
              ? cc.aiBasis.map((b) => `${describeBasis(b.basis)}（${REGIME_LABEL[b.regime]}，${b.n} 筆，${b.active ? fmtPct(b.weight) : `中性 ${fmtPct(b.weight)}`}）`).join("、")
              : "尚無已滿 5 日的 AI 調整紀錄（中性）"}
          </div>
          <div className="mt-1">何時可以放寬 AI 調整空間（讓 AI 調整改變主結論）——以下全部成立才考慮，仍由人決定：</div>
          <ul className="list-disc pl-5">
            {(cc?.promotion.checks ?? []).map((c) => (
              <li key={c.label}>
                {c.ok ? "✅" : "⬜"} {c.label}
              </li>
            ))}
            {!cc && (
              <li>
                有 AI 判斷且滿 5 日 ≥ {AI_ADJUST_PROMOTION.minSamples} 筆、其中 AI 實際調整 ≥ {AI_ADJUST_PROMOTION.minAdjusted} 筆、AI 調整後 5 日平均獎勵高於程式評等 ≥{" "}
                {AI_ADJUST_PROMOTION.minEdgePct} 個百分點、逐筆配對差 t 值 ≥ {AI_ADJUST_PROMOTION.minT}
              </li>
            )}
          </ul>
        </div>
      </section>

      <section className={card}>
        <h2 className="font-semibold">判斷依據 × 市況（5 日）</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-(--text-muted)">
          權重＝「出現這個依據時若買進」的平均獎勵，經貝氏收縮（加 {WEIGHT_PRIOR_STRENGTH} 筆中性樣本）與指數衰減（半衰期 {WEIGHT_HALF_LIFE_TRADING_DAYS} 個交易日）；
          筆數未達 {s?.weightMinSamples ?? 30} 筆維持中性、不使用。目前權重{s?.weightsEnabled ? "已" : "未"}套用到評等（只計算與展示，上線前須先用未用過的資料回測）。
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>依據</th>
                <th className={th}>市況</th>
                <th className={th}>筆數</th>
                <th className={th}>若買進勝率</th>
                <th className={th}>平均超額</th>
                <th className={th}>平均獎勵</th>
                <th className={th}>權重</th>
              </tr>
            </thead>
            <tbody>
              {(s?.basisStats ?? []).slice(0, BASIS_ROWS_MAX).map((b) => (
                <tr key={`${b.basis}-${b.regime}`} className="border-t border-(--gridline)">
                  <td className={td}>{describeBasis(b.basis)}</td>
                  <td className={td}>{REGIME_LABEL[b.regime]}</td>
                  <td className={td}>
                    {b.n}
                    <Insufficient n={b.n} min={s?.weightMinSamples ?? 30} />
                  </td>
                  <td className={td}>{fmtPct(b.winRate, false)}</td>
                  <td className={`${td} ${tone(b.avgExcess)}`}>{fmtPct(b.avgExcess)}</td>
                  <td className={`${td} ${tone(b.avgReward)}`}>{fmtPct(b.avgReward)}</td>
                  <td className={`${td} ${b.active ? tone(b.weight) : "text-(--text-muted)"}`}>
                    {b.active ? fmtPct(b.weight) : `中性（${fmtPct(b.weight)}）`}
                  </td>
                </tr>
              ))}
              {(s?.basisStats.length ?? 0) === 0 && (
                <tr>
                  <td className={td} colSpan={7}>
                    尚無已滿 5 個交易日的紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={card}>
        <h2 className="font-semibold">值得檢討的案例（近期，5 日）</h2>
        {(s?.reviewCases.length ?? 0) === 0 ? (
          <p className="mt-2 text-sm text-(--text-muted)">目前沒有（建議買進後 5 日跌超過 5%、或不買卻 5 日超額 &gt; 8% 的案例會列在這裡）。</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {s!.reviewCases.map((c) => (
              <li key={`${c.day}-${c.sym}-${c.code}`}>
                {c.day} {c.name}（{c.sym}）「{RATING_LABEL[c.code]}」→ 5 日 <span className={tone(c.ret)}>{fmtPct(c.ret)}</span>
                （超額 {fmtPct(c.ex)}）{c.kind === "buy-drop" ? "：買進後大跌" : "：不買卻大漲"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className="font-semibold">教訓清單</h2>
        <ul className="mt-2 space-y-2 text-sm leading-relaxed">
          {LESSONS.map((l) => {
            const v = s?.lessons.find((x) => x.id === l.id);
            return (
              <li key={l.id} className="border-t border-(--gridline) pt-2 first:border-t-0 first:pt-0">
                <div>
                  <span className="mr-1 rounded bg-(--page-plane) px-1 text-[12px]">{l.status}</span>
                  <span className="font-medium">{l.condition}</span>
                </div>
                <div className="text-(--text-secondary)">{l.advice}</div>
                <div className="text-[13px] text-(--text-muted)">
                  原始證據：{l.evidence.n != null ? `${l.evidence.n} 筆、` : ""}
                  {l.evidence.excessPct != null ? `5日超額 ${fmtPct(l.evidence.excessPct)}、` : ""}
                  {l.evidence.winRatePct != null ? `跑贏 ${l.evidence.winRatePct}%、` : ""}
                  {l.evidence.source}（{l.created}）
                </div>
                <div className="text-[13px] text-(--text-muted)">
                  評等紀錄驗證：{v ? `${v.verdict}（符合 ${v.n} 筆${v.avgExcess != null ? `、平均超額 ${fmtPct(v.avgExcess)}` : ""}）` : "尚未驗證"}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
