import type { MacroSnapshot } from "@/lib/data";
import { MACRO_SERIES } from "@/lib/data/macroSeries";
import { formatMacroDelta, formatMacroValue, macroDelta } from "@/lib/data/macroFormat";

/**
 * 把 FRED 總經快照轉成餵給 AI 的文字（接在 buildMarketOverviewText 的大盤概況後面，
 * 聊天／每日快報／今日建議三邊都吃得到）。snapshot 為 null（沒設定 FRED_API_KEY）時
 * 回傳空字串，大盤概況文字跟加這功能之前逐字相同。
 *
 * 每一行都帶資料日期與「較前一筆／較約一個月前」已算好的升降，AI 不用自己減、也不會
 * 把幾天前的數字講成「今天」。
 */
export function describeMacroSnapshot(snapshot: MacroSnapshot | null): string {
  if (!snapshot || snapshot.fredDisabled) return "";
  const byKey = new Map(snapshot.indicators.map((i) => [i.key, i]));
  const lines = MACRO_SERIES.map((def) => {
    const ind = byKey.get(def.key);
    if (!ind) return `- ${def.label}：資料暫缺`;
    const prevLabel = def.frequency === "monthly" ? "較上個月" : "較前一筆";
    const parts = [`- ${def.label}：${formatMacroValue(ind.value, def.unit)}（資料日期 ${def.frequency === "monthly" ? `${ind.date.slice(0, 7)}月份` : ind.date}）`];
    const d1 = macroDelta(ind.value, ind.prevValue);
    if (d1 != null) parts.push(`${prevLabel}${d1 === 0 ? "持平" : formatMacroDelta(d1, def.unit)}`);
    const d30 = macroDelta(ind.value, ind.monthAgoValue);
    if (d30 != null && ind.monthAgoDate) {
      parts.push(`較約一個月前（${ind.monthAgoDate}，${formatMacroValue(ind.monthAgoValue!, def.unit)}）${d30 === 0 ? "持平" : formatMacroDelta(d30, def.unit)}`);
    }
    return parts.join("；");
  });
  return [
    "【美國總體經濟（美國聖路易聯準銀行 FRED 官方統計；不是即時資料，日資料通常落後1~幾個交易日、月資料落後約1個月，務必以每項標示的資料日期為準）】",
    ...lines,
  ].join("\n");
}
