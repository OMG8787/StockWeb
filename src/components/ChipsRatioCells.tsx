"use client";

import { priceDirectionClass } from "@/lib/format";
import type { ChipsRatioPick, RatioPair } from "@/lib/chipsRatiosList";
import { GLOSS_SHORT_MARGIN_RATIO_TITLE } from "@/lib/ai/chipsRatiosWording";
import { useChipsRatiosMeta, type ChipsRatioEntry } from "@/lib/useChipsRatios";

/**
 * 股票列表的「籌碼比例」四欄，由左到右＝大戶持股(週)／外資持股／融資使用率／券資比（使用者
 * 2026-10-01 指定前三欄順序、2026-10-04 在融資右邊加融券；個股頁 ChipsRatioSummary 也是同一個順序），StockTable 與
 * WatchlistTable 共用。表頭（ChipsRatioHeaderCells）與儲存格（ChipsRatioCells）的順序
 * 必須一起改，否則會錯位。每格＝「數值%」＋下方小字「▲/▼ 升降」，升降一定同時有符號
 * 與文字（不能只靠紅綠顏色），顏色照台股慣例紅漲綠跌。缺資料一律「—」，不補 0。
 * 資料從 lib/useChipsRatios.ts 漸進載入，載入中顯示骨架。
 */

/** "2026-09-24" → "09/24" */
function shortDate(iso: string | undefined): string {
  return iso && iso.length === 10 ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : "";
}

export function ChipsRatioHeaderCells() {
  const { majorDate, majorPrevDate } = useChipsRatiosMeta();
  const weekNote = majorDate
    ? `目前為 ${shortDate(majorDate)} 那週${majorPrevDate ? `，比較 ${shortDate(majorPrevDate)} 那週` : ""}。`
    : "";
  const th = "py-2 pr-4 font-medium text-right whitespace-nowrap";
  return (
    <>
      <th
        className={th}
        title={`大戶持股＝持股 1000 張以上大戶占集保庫存的比例，集保結算所每週公布一次的「週資料」。${weekNote}下方▲▼為較上一週增減的百分點；本站上一週資料還沒累積到時顯示「累積中」。`}
      >
        大戶持股(週)
      </th>
      <th className={th} title="外資持股＝全體外資及陸資持股比率（證交所／櫃買中心每個交易日收盤後公布）。下方▲▼為較前一交易日增減的百分點。">
        外資持股
      </th>
      <th className={th} title="融資使用率＝融資餘額 ÷ 融資限額（收盤後資料）。下方▲▼為較前一交易日增減的百分點；興櫃不能融資，顯示「—」。">
        融資使用率
      </th>
      <th className={th} title={GLOSS_SHORT_MARGIN_RATIO_TITLE}>
        券資比
      </th>
    </>
  );
}

function Delta({ pair, prevLabel, pendingPrev, missingPrev }: { pair: RatioPair; prevLabel: string; pendingPrev?: boolean; missingPrev: string }) {
  const [current, prev] = pair;
  if (prev == null) {
    return (
      <span className="block text-[12px] text-(--text-muted)" title={pendingPrev ? "正在查詢上一期資料" : `沒有${prevLabel}資料可比較`}>
        {pendingPrev ? "…" : missingPrev}
      </span>
    );
  }
  const diff = Math.round((current - prev) * 100) / 100;
  const text = diff > 0 ? `▲ ${diff.toFixed(2)}` : diff < 0 ? `▼ ${Math.abs(diff).toFixed(2)}` : "― 持平";
  return (
    <span
      className={`block text-[12px] font-medium ${priceDirectionClass(diff)}`}
      title={`${prevLabel} ${prev.toFixed(2)}%，${diff === 0 ? "持平" : `${diff > 0 ? "上升" : "下降"} ${Math.abs(diff).toFixed(2)} 個百分點`}`}
    >
      {text}
    </span>
  );
}

const TD = "py-2.5 pr-4 text-right tabular-nums whitespace-nowrap";

function Cell({
  entry,
  pick,
  prevLabel,
  missingPrev,
}: {
  entry: ChipsRatioEntry;
  pick: ChipsRatioPick;
  prevLabel: string;
  missingPrev: string;
}) {
  if (entry.status === "idle" || entry.status === "loading") {
    return (
      <td className={TD} aria-label="載入中">
        <span className="inline-block h-3.5 w-12 animate-pulse rounded bg-(--surface-2) align-middle" />
      </td>
    );
  }
  const pair = entry.status === "ok" ? entry.data?.[pick] : undefined;
  if (!pair) {
    return (
      <td className={`${TD} text-(--text-muted)`} title={entry.status === "failed" ? "暫時取不到資料，稍後重新整理再試" : "資料暫缺"}>
        —
      </td>
    );
  }
  return (
    <td className={TD}>
      <span className="text-(--text-secondary)">{pair[0].toFixed(2)}%</span>
      <Delta
        pair={pair}
        prevLabel={prevLabel}
        missingPrev={missingPrev}
        pendingPrev={pick === "major" && entry.status === "ok" && entry.majorPrevPending}
      />
    </td>
  );
}

/** 一列的四格；美股列（market !== "TW"）一律「—」。 */
export function ChipsRatioCells({ entry, isTw }: { entry: ChipsRatioEntry; isTw: boolean }) {
  if (!isTw) {
    return (
      <>
        {[0, 1, 2, 3].map((i) => (
          <td key={i} className={`${TD} text-(--text-muted)`} title="美股沒有這項公開資料">
            —
          </td>
        ))}
      </>
    );
  }
  return (
    <>
      <Cell entry={entry} pick="major" prevLabel="上一週" missingPrev="累積中" />
      <Cell entry={entry} pick="foreign" prevLabel="前一交易日" missingPrev="—" />
      <Cell entry={entry} pick="margin" prevLabel="前一交易日" missingPrev="—" />
      <Cell entry={entry} pick="short" prevLabel="前一交易日" missingPrev="—" />
    </>
  );
}
