import type { MarketHistory } from "@/lib/data/marketHistory";
import {
  signedStreak,
  VIX_CALM_LEVEL,
  VIX_CALM_PERCENTILE,
  VIX_FEAR_LEVEL,
  VIX_FEAR_PERCENTILE,
  VIX_FEAR_WEEK_JUMP,
  type IndexTrend,
  type VixMood,
} from "@/lib/data/marketHistoryStats";

/**
 * 「【市場歷史與情緒走勢】」區塊——askSystemPrompt.ts 的 RULE_USE_HISTORICAL_CONTEXT
 * 指名用這個標題，改標題要一起改規則。接在 buildMarketOverviewText 的總經段後面，
 * 每日快報／今日建議／AI問答三邊共用。
 *
 * 刻意精簡（目標 ≤700 字）：Groq 的 TPM 很小，提示詞本來就很長。利率、美元、油價
 * 「較約一個月前」的變化上面的美國總體經濟段已經有，這裡不重複，只補 VIX 的相對位置。
 * 任何一段沒資料就整段省略，不放佔位字；全部沒資料回傳空字串。
 */
export const MARKET_HISTORY_TITLE = "【市場歷史與情緒走勢】";

const VIX_MOOD_LABEL: Record<VixMood, string> = {
  fear: "偏恐慌",
  calm: "偏樂觀（安逸）",
  neutral: "中性",
};

function signed(n: number, digits = 1): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}

function md(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

function describeIndex(t: IndexTrend): string {
  const rets = [
    t.ret1w != null ? `近1週${signed(t.ret1w)}%` : null,
    t.ret1m != null ? `1個月${signed(t.ret1m)}%` : null,
    t.ret3m != null ? `3個月${signed(t.ret3m)}%` : null,
  ].filter(Boolean);
  const parts = [`- ${t.name} ${t.close.toLocaleString("en-US")}（${md(t.date)}）：${rets.join("、")}`];
  if (t.fromHigh52 != null) {
    const label = t.highWindowDays >= 240 ? "52週高點" : `近${t.highWindowDays}個交易日高點`;
    parts.push(t.fromHigh52 >= -0.05 ? `位於${label}` : `距${label}${signed(t.fromHigh52)}%`);
  }
  const side = (above: boolean) => (above ? "站上" : "跌破");
  if (t.aboveMa20 != null && t.aboveMa60 != null && t.aboveMa20 === t.aboveMa60) {
    parts.push(`${side(t.aboveMa20)}20/60日線`);
  } else {
    const ma = [
      t.aboveMa20 != null ? `${side(t.aboveMa20)}20日線` : null,
      t.aboveMa60 != null ? `${side(t.aboveMa60)}60日線` : null,
    ].filter(Boolean);
    if (ma.length) parts.push(ma.join("、"));
  }
  if (t.recentNewHigh52) parts.push("近5日創52週新高");
  if (t.recentNewLow3m) parts.push("近5日跌破近3個月低點");
  return parts.join("；");
}

function streakText(series: number[], buy = "買", sell = "賣"): string {
  const s = signedStreak(series);
  if (s === 0) return "";
  return `連${s > 0 ? buy : sell}${Math.abs(s)}日`;
}

function sumFirst(values: number[], n: number): number {
  return values.slice(0, n).reduce((a, b) => a + b, 0);
}

function describeInstitutional(h: MarketHistory): string | null {
  const days = h.institutional;
  if (days.length < 3) return null;
  const n5 = Math.min(5, days.length);
  const nAll = days.length;
  const who = [
    ["外資", days.map((d) => d.foreign)],
    ["投信", days.map((d) => d.trust)],
    ["自營商", days.map((d) => d.dealer)],
  ] as const;
  // 中間有缺日時，連續天數只算到缺口為止（不然會把缺口兩側硬接成「連續」）
  const gap = h.institutionalMissing.filter((d) => d < days[0].date).sort().pop();
  const contiguous = gap ? days.filter((d) => d.date > gap).length : days.length;
  const perWho = who
    .map(([name, series]) => {
      const streak = streakText(series.slice(0, contiguous));
      return `${name}${signed(sumFirst([...series], n5))}億${streak ? `（${streak}）` : ""}`;
    })
    .join("、");
  const totals = days.map((d) => d.total);
  const missing = h.institutionalMissing.length > 0 ? `；缺${h.institutionalMissing.map(md).join("、")}` : "";
  return `- 三大法人（上市，買賣超金額，資料到${md(days[0].date)}${missing}）：合計近${n5}日${signed(sumFirst(totals, n5))}億${nAll > n5 ? `、近${nAll}日${signed(sumFirst(totals, nAll))}億` : ""}；近${n5}日${perWho}`;
}

function describeMargin(h: MarketHistory): string | null {
  const m = h.margin;
  if (m.length < 2) return null;
  const latest = m[0];
  const oldest = m[m.length - 1];
  const change = latest.balance - oldest.balance;
  const changePct = (change / oldest.balance) * 100;
  const daily = m.slice(0, -1).map((d, i) => d.balance - m[i + 1].balance);
  const streak = streakText(daily, "增", "減");
  return `- 上市融資餘額 ${Math.round(latest.balance).toLocaleString("en-US")}億（${md(latest.date)}）：近${m.length - 1}日${signed(change)}億（${signed(changePct, 2)}%）${streak ? `，${streak}` : ""}`;
}

function describeVix(h: MarketHistory): string | null {
  const v = h.vix;
  if (!v) return null;
  const changes = [
    v.weekAgoValue != null ? `較一週前${signed(v.value - v.weekAgoValue)}` : null,
    v.monthAgoValue != null ? `較一個月前${signed(v.value - v.monthAgoValue)}` : null,
  ].filter(Boolean);
  return `- VIX ${v.value.toFixed(1)}（${md(v.date)}）：位於近3個月第${v.percentile3m}百分位${changes.length ? `，${changes.join("、")}` : ""}；本站規則判定情緒「${VIX_MOOD_LABEL[v.mood]}」（≥${VIX_FEAR_LEVEL}或百分位≥${VIX_FEAR_PERCENTILE}且週增≥${VIX_FEAR_WEEK_JUMP}為偏恐慌，<${VIX_CALM_LEVEL}且百分位≤${VIX_CALM_PERCENTILE}為偏樂觀）`;
}

export function describeMarketHistory(h: MarketHistory | null | undefined): string {
  if (!h) return "";
  const tw = [
    ...h.indices.filter((t) => t.market === "TW").map(describeIndex),
    describeInstitutional(h),
    describeMargin(h),
  ].filter((l): l is string => !!l);
  const us = [...h.indices.filter((t) => t.market === "US").map(describeIndex), describeVix(h)].filter(
    (l): l is string => !!l
  );
  if (tw.length === 0 && us.length === 0) return "";
  return [
    `${MARKET_HISTORY_TITLE}（程式依歷史收盤算好，直接引用；報酬為收盤對收盤，1週/1個月/3個月≈5/21/63個交易日；括號＝資料日）`,
    ...(tw.length ? ["台股：", ...tw] : []),
    ...(us.length ? ["美股：", ...us] : []),
  ].join("\n");
}
