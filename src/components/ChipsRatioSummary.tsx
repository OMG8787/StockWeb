import type { ReactNode } from "react";
import { getChipsRatios } from "@/lib/data";
import type { ChipsRatios } from "@/lib/data";
import { priceDirectionClass } from "@/lib/format";
import { GLOSS_SHORT_MARGIN_RATIO_TITLE } from "@/lib/ai/chipsRatiosWording";

/** "2026-09-30" → "09/30" */
function shortDate(iso: string | undefined): string {
  return iso && iso.length === 10 ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : "";
}

function lots(shares: number): string {
  const n = shares / 1000;
  return n >= 100_000 ? `${(n / 10_000).toFixed(1)} 萬張` : `${Math.round(n).toLocaleString("zh-TW")} 張`;
}

/**
 * 「較前日 ▲ +0.81 個百分點」這種一眼看得出升降的一行：一定同時有▲▼符號＋文字，
 * 不能只靠紅綠顏色（色弱/黑白列印也看得懂）。顏色照全站台股慣例紅漲綠跌。
 */
function Delta({ current, prev, label }: { current: number; prev: number | undefined; label: string }) {
  if (prev == null) return null;
  const diff = Math.round((current - prev) * 100) / 100;
  const text = diff > 0 ? `▲ 上升 ${diff.toFixed(2)}` : diff < 0 ? `▼ 下降 ${Math.abs(diff).toFixed(2)}` : "― 持平";
  return (
    <span className={`text-sm font-medium tabular-nums ${priceDirectionClass(diff)}`}>
      {label} {text}
      {diff !== 0 && " 個百分點"}
    </span>
  );
}

function Item({
  title,
  titleHint,
  percent,
  delta,
  detail,
  footnote,
  missing,
}: {
  title: string;
  /** 標題的滑鼠提示（名詞解釋） */
  titleHint?: string;
  percent?: number;
  delta?: ReactNode;
  detail?: ReactNode;
  footnote?: ReactNode;
  missing?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md bg-(--surface-2) px-3 py-2.5">
      {/* 手機版三格直排：標題與百分比同一行、升降放不下才自動換到下一行，避免整區
          太高被擠出第一屏；md 以上三格並排時標題獨佔一行、百分比與升降同一行。 */}
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-sm text-(--text-muted) md:w-full" title={titleHint}>
          {title}
        </p>
        {percent == null ? (
          <p className="text-base font-medium text-(--text-secondary) md:mt-1">{missing ?? "資料暫缺"}</p>
        ) : (
          <>
            <span className="text-2xl font-bold tabular-nums">{percent.toFixed(2)}%</span>
            {delta}
          </>
        )}
      </div>
      {percent != null && detail && <p className="mt-1 text-sm text-(--text-secondary) tabular-nums">{detail}</p>}
      {footnote && <p className="mt-1 text-xs text-(--text-muted)">{footnote}</p>}
    </div>
  );
}

export function ChipsRatioSummaryView({ ratios, emerging = false }: { ratios: ChipsRatios | null; emerging?: boolean }) {
  const m = ratios?.margin;
  const f = ratios?.foreign;
  const h = ratios?.majorHolders;
  const t = ratios?.short;
  return (
    <div className="mt-5 border-t border-(--gridline) pt-4" aria-label="籌碼比例摘要">
      <h2 className="mb-2 text-base font-semibold">籌碼比例</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {/* 由左到右＝大戶／外資／融資／融券，跟列表四欄（ChipsRatioCells）同一個順序。 */}
        <Item
          title="大戶持股比例"
          percent={h?.holdingPercent}
          delta={h && <Delta current={h.holdingPercent} prev={h.prevHoldingPercent} label="較上週" />}
          detail={
            h && (
              <>
                1000張以上大戶 {h.holders.toLocaleString("zh-TW")} 人
                {h.prevHolders != null && h.prevHolders !== h.holders && (
                  <span className={priceDirectionClass(h.holders - h.prevHolders)}>
                    （{h.holders - h.prevHolders > 0 ? "+" : ""}
                    {h.holders - h.prevHolders} 人）
                  </span>
                )}
                ・共持有 {lots(h.shares)}
              </>
            )
          }
          footnote={
            h
              ? `週資料（集保每週公布一次）：${shortDate(h.date)}${h.prevDate ? `，比較 ${shortDate(h.prevDate)} 那週` : "，上一週資料累積中、暫無前期可比"}`
              : undefined
          }
        />
        <Item
          title="外資持股比例"
          percent={f?.holdingPercent}
          delta={f && <Delta current={f.holdingPercent} prev={f.prevHoldingPercent} label="較前日" />}
          detail={f && <>外資持股 {Math.round(f.heldShares / 1000).toLocaleString("zh-TW")} 張</>}
          footnote={f ? `${shortDate(f.date)} 收盤後資料` : undefined}
          missing={emerging ? "資料暫缺（興櫃沒有公布外資持股）" : undefined}
        />
        <Item
          title="融資使用率"
          percent={m?.utilizationPercent}
          delta={m && <Delta current={m.utilizationPercent} prev={m.prevUtilizationPercent} label="較前日" />}
          detail={
            m && (
              <>
                融資餘額 {m.balance.toLocaleString("zh-TW")} 張
                {m.balanceChange != null && (
                  <span className={priceDirectionClass(m.balanceChange)}>
                    （{m.balanceChange > 0 ? "+" : ""}
                    {m.balanceChange.toLocaleString("zh-TW")} 張）
                  </span>
                )}
              </>
            )
          }
          footnote={m?.date ? `${shortDate(m.date)} 收盤後資料` : undefined}
          missing={emerging ? "資料暫缺（興櫃依規定不能融資）" : undefined}
        />
        <Item
          title="券資比"
          titleHint={GLOSS_SHORT_MARGIN_RATIO_TITLE}
          percent={t?.shortMarginRatioPercent}
          delta={t && <Delta current={t.shortMarginRatioPercent} prev={t.prevShortMarginRatioPercent} label="較前日" />}
          detail={
            t && (
              <>
                融券餘額 {t.balance.toLocaleString("zh-TW")} 張
                {t.balanceChange != null && (
                  <span className={priceDirectionClass(t.balanceChange)}>
                    （{t.balanceChange > 0 ? "+" : ""}
                    {t.balanceChange.toLocaleString("zh-TW")} 張）
                  </span>
                )}
              </>
            )
          }
          footnote={t?.date ? `融券÷融資，${shortDate(t.date)} 收盤後資料` : undefined}
          missing={emerging ? "資料暫缺（興櫃依規定不能融資融券）" : m ? undefined : "資料暫缺（沒有融資餘額無法計算）"}
        />
      </div>
    </div>
  );
}

/** 個股頁最上方的籌碼比例摘要（TW only）；頁面用 <Suspense> 包起來串流，不拖慢報價區。 */
export default async function ChipsRatioSummary({ symbol, emerging = false }: { symbol: string; emerging?: boolean }) {
  const ratios = await getChipsRatios(symbol, "TW").catch(() => null);
  return <ChipsRatioSummaryView ratios={ratios} emerging={emerging} />;
}

export function ChipsRatioSummarySkeleton() {
  return (
    <div className="mt-5 border-t border-(--gridline) pt-4" aria-hidden="true">
      <h2 className="mb-2 text-base font-semibold">籌碼比例</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-md bg-(--surface-2)" />
        ))}
      </div>
    </div>
  );
}
