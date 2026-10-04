import { getFredSnapshot } from "@/lib/data";
import { MACRO_SERIES } from "@/lib/data/macroSeries";
import { formatMacroValue, macroDelta } from "@/lib/data/macroFormat";

/**
 * 首頁「美國總體經濟」精簡卡片（FRED 官方統計）——純伺服器元件，首頁用 <Suspense>
 * 包起來串流，不擋大盤指數等其他區塊的首屏渲染。
 *
 * - 沒設定 FRED_API_KEY：整張卡片不渲染（首頁跟加功能之前一模一樣，不放一整排
 *   「資料暫缺」讓首頁看起來壞掉）；有設定但某項抓不到：該格誠實顯示「資料暫缺」。
 * - ▲▼ 刻意用中性色，不套全站紅漲綠跌：殖利率、VIX、失業率「上升」不代表好消息，
 *   用紅色會讓人誤以為是利多。
 */
function formatDate(date: string, monthly: boolean): string {
  const [y, m, d] = date.split("-");
  return monthly ? `${y}/${m}月` : `${m}/${d}`;
}

export default async function MacroCard() {
  const snapshot = await getFredSnapshot();
  if (!snapshot) return null;
  const byKey = new Map(snapshot.indicators.map((i) => [i.key, i]));

  return (
    <div className="mt-3 rounded-lg border border-(--gridline) bg-(--surface-1) p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">美國總體經濟</h3>
        <p className="text-[12px] text-(--text-muted)">FRED 官方統計・非即時，日期為資料所屬日</p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {MACRO_SERIES.map((def) => {
          const ind = byKey.get(def.key);
          const monthly = def.frequency === "monthly";
          const delta = ind ? macroDelta(ind.value, ind.prevValue) : undefined;
          return (
            <div key={def.key} className="min-w-0">
              <dt className="truncate text-[12px] text-(--text-secondary)" title={def.label}>
                {def.shortLabel}
              </dt>
              {ind ? (
                <>
                  <dd className="mt-0.5 text-base font-semibold tabular-nums">{formatMacroValue(ind.value, def.unit)}</dd>
                  <dd className="text-[12px] tabular-nums text-(--text-muted)">
                    {delta == null ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "持平"}
                    {delta != null && delta !== 0 ? Math.abs(delta).toFixed(2) : ""}
                    {delta != null ? " · " : ""}
                    {formatDate(ind.date, monthly)}
                  </dd>
                </>
              ) : (
                <dd className="mt-0.5 text-sm text-(--text-muted)">資料暫缺</dd>
              )}
            </div>
          );
        })}
      </dl>
      <p className="mt-3 text-[12px] text-(--text-muted)">
        ▲▼ 為較前一筆資料（月資料為較上月）的變化；利率類單位為百分點。CPI 年增率＝物價較去年同月漲幅（通膨率）；美元廣義指數為聯準會編製，與常見的 DXY 不同。
      </p>
    </div>
  );
}
