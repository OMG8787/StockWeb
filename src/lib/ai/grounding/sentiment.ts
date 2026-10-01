import {
  buzzLabel,
  formatSentimentTime,
  LEAN_LABEL,
  SENTIMENT_SOURCE_LABEL,
  SENTIMENT_SOURCES,
  sentimentLean,
  SMALL_SAMPLE_MENTIONS,
  TREND_LABEL,
  type StockSentiment,
} from "@/lib/data/sentiment";

/**
 * 美股個股 AI grounding 的「社群情緒」區塊（搭配 RULE_SOCIAL_SENTIMENT）。
 * 每個數字都帶角色標籤（討論熱度／看多比例／看空比例／提及次數），並把來源、統計區間、
 * 資料時間、樣本大小講清楚，讓 AI 不會把它講成事實或財報數據。沒有任何快照時回傳空字串。
 */
export function describeSocialSentiment(s: StockSentiment | null): string {
  if (!s) return "";
  const lines: string[] = [];
  for (const src of SENTIMENT_SOURCES) {
    const entry = s.sources[src];
    if (!entry) continue;
    const label = SENTIMENT_SOURCE_LABEL[src];
    const when = `資料時間 ${formatSentimentTime(entry.fetchedAt)}（台北時間），統計 ${entry.from} 起近7日`;
    const row = entry.row;
    if (!row) {
      lines.push(`- ${label}：不在該來源近7日討論最熱的 ${entry.listSize} 檔名單內（代表討論很少，不是沒有資料錯誤）；${when}`);
      continue;
    }
    const parts = [
      row.mentions < SMALL_SAMPLE_MENTIONS ? "整體傾向 樣本太少、無法判斷（下列比例僅供參考）" : `整體傾向 ${LEAN_LABEL[sentimentLean(row)]}`,
      row.bullishPct != null ? `看多比例 ${row.bullishPct}%` : "",
      row.bearishPct != null ? `看空比例 ${row.bearishPct}%` : "",
      `討論熱度 ${row.buzz}/100（${buzzLabel(row.buzz)}，熱門榜第 ${row.rank} 名）`,
      row.trend ? `討論熱度趨勢 ${TREND_LABEL[row.trend]}（近3日比前3日，指討論量不是股價）` : "",
      `提及次數 ${row.mentions} 次${row.mentions < SMALL_SAMPLE_MENTIONS ? "（樣本很小，參考價值低）" : ""}`,
    ].filter(Boolean);
    lines.push(`- ${label}：${parts.join("；")}；${when}`);
  }
  if (lines.length === 0) return "";
  return `社群情緒（Adanos 彙整的 Reddit／X／財經新聞討論，是網路社群的看法、不是事實或財報數據，僅涵蓋美股，僅供參考）：\n${lines.join("\n")}`;
}
