import { getChart } from "@/lib/data";
import type { Candle, ChipsRatios, Quote } from "@/lib/data";
import { getTwChipsHistory, RATIO_DAYS, type TwChipsDay } from "@/lib/data/chipsHistory";
import { getTwFundamentalsHistory, getUsFundamentalsHistory, type FundamentalsHistory } from "@/lib/data/fundamentalsHistory";
import { ensureTwUniverseWarm } from "@/lib/data/universe";
import { resolveTwExchange } from "@/lib/data/symbols";
import { HISTORY_PERIOD_MAX_DAYS, type HistoryPeriod } from "../intent";
import { pointDelta } from "./chipsRatios";

/**
 * 個股【歷史脈絡】區塊（併入 buildStockGrounding；模型怎麼用它見 askSystemPrompt.ts 的
 * RULE_USE_HISTORICAL_CONTEXT）。所有數字都在這裡由程式算好，不丟原始K線給 AI：
 * 1. 價格：近1週/1月/3月/6月/1年報酬、52週區間位置、近3個月最大回檔、量能比、相對大盤
 * 2. 台股籌碼：三大法人近5/10/20日累計與連續買賣超天數、融資使用率與外資持股比例近幾日走勢、
 *    大戶（週資料）累積了幾週
 * 3. 基本面：月營收年增率、季EPS多期走勢
 * 4. 使用者明確問過去某天/某段期間時（intent.ts detectHistoryPeriod）：該期間逐日明細
 * 每一段各自 fail open：缺資料就整段省略。整個區塊目標 ≤600 字（多檔比較時更短）。
 */

/** 整個區塊等外部資料最多等多久；逾時的那段省略（背後的依日期快取照樣會寫入，下次就快了）。 */
const HISTORY_FETCH_BUDGET_MS = 9000;
/** 籌碼逐日回補先回傳部分結果的時間點（比整體上限早一點，見 getTwChipsHistory） */
const CHIPS_PARTIAL_DEADLINE_MS = 8000;

const TRADING_DAYS = { week: 5, month: 21, quarter: 63, half: 126 } as const;
const DRAWDOWN_WINDOW = 63;
const VOLUME_SHORT = 20;
const VOLUME_LONG = 60;
const RELATIVE_WINDOWS = [5, 20] as const;
const INSTI_WINDOWS = [5, 10, 20] as const;
const REVENUE_SHOWN_MONTHS = 6;
const REVENUE_SHOWN_MONTHS_COMPACT = 3;
const EPS_SHOWN_QUARTERS = 4;

export const HISTORY_SECTION_TITLE = "【歷史脈絡】";

function withBudget<T>(promise: Promise<T>, fallback: T, ms = HISTORY_FETCH_BUDGET_MS): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function pct(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function mmdd(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** 跨年的日期才帶年份 */
function shortDate(iso: string, refIso: string): string {
  return iso.slice(0, 4) === refIso.slice(0, 4) ? mmdd(iso) : `${iso.slice(0, 4)}/${mmdd(iso)}`;
}

function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function lots(shares: number): number {
  return Math.round(shares / 1000);
}

function signedLots(shares: number): string {
  const l = lots(shares);
  return `${l > 0 ? "+" : ""}${l.toLocaleString("en-US")}`;
}

function fmtVolume(volume: number, isTw: boolean): string {
  if (isTw) return `${lots(volume).toLocaleString("en-US")}張`;
  return volume >= 1e6 ? `${(volume / 1e6).toFixed(1)}M股` : `${volume.toLocaleString("en-US")}股`;
}

function returnOver(candles: Candle[], n: number): number | undefined {
  if (candles.length <= n) return undefined;
  const base = candles[candles.length - 1 - n].close;
  return base > 0 ? (candles[candles.length - 1].close / base - 1) * 100 : undefined;
}

function avgVolume(candles: Candle[], n: number): number | undefined {
  if (candles.length < n) return undefined;
  const slice = candles.slice(-n);
  return slice.reduce((s, c) => s + c.volume, 0) / n;
}

/** 收盤價的最大回檔（峰→谷），回傳負的百分比與峰谷日期 */
function maxDrawdown(candles: Candle[]): { percent: number; peak: string; trough: string } | undefined {
  let peak = candles[0];
  let worst: { percent: number; peak: string; trough: string } | undefined;
  for (const c of candles) {
    if (c.close > peak.close) peak = c;
    const dd = (c.close / peak.close - 1) * 100;
    if (!worst || dd < worst.percent) worst = { percent: dd, peak: peak.time, trough: c.time };
  }
  return worst && worst.percent < 0 ? worst : undefined;
}

/** 同一段期間（用個股日K的起訖日期對齊）的大盤報酬 */
function indexReturnBetween(index: Candle[], fromIso: string, toIso: string): number | undefined {
  const at = (iso: string) => [...index].reverse().find((c) => c.time <= iso);
  const a = at(fromIso);
  const b = at(toIso);
  if (!a || !b || a.time === b.time || a.close <= 0) return undefined;
  return (b.close / a.close - 1) * 100;
}

export function describePriceHistory(
  candles: Candle[],
  opts: { isTw: boolean; compact: boolean; index?: { name: string; candles: Candle[] } }
): string | undefined {
  if (candles.length < TRADING_DAYS.week + 1) return undefined;
  const last = candles[candles.length - 1];
  const ret: string[] = [];
  const periods: Array<[string, number | undefined]> = opts.compact
    ? [["1個月", TRADING_DAYS.month], ["3個月", TRADING_DAYS.quarter], ["1年", candles.length - 1]]
    : [["1週", TRADING_DAYS.week], ["1個月", TRADING_DAYS.month], ["3個月", TRADING_DAYS.quarter], ["6個月", TRADING_DAYS.half], ["1年", candles.length - 1]];
  for (const [label, n] of periods) {
    if (n == null) continue;
    const r = returnOver(candles, n);
    if (r != null) ret.push(`${label}${pct(r)}`);
  }
  const parts = [`以${mmdd(last.time)}收盤${fmtPrice(last.close)}計，近${ret.join("／")}`];

  let hi = candles[0];
  let lo = candles[0];
  for (const c of candles) {
    if (c.high > hi.high) hi = c;
    if (c.low < lo.low) lo = c;
  }
  if (hi.high > lo.low) {
    const position = ((last.close - lo.low) / (hi.high - lo.low)) * 100;
    const span = candles.length >= 240 ? "52週" : `近${candles.length}日`;
    parts.push(
      opts.compact
        ? `${span}高${fmtPrice(hi.high)}／低${fmtPrice(lo.low)}，距高點${pct((last.close / hi.high - 1) * 100)}`
        : `${span}高${fmtPrice(hi.high)}（${shortDate(hi.time, last.time)}）低${fmtPrice(lo.low)}，距高點${pct((last.close / hi.high - 1) * 100)}、位在區間${position.toFixed(0)}%`
    );
  }
  if (!opts.compact) {
    const dd = maxDrawdown(candles.slice(-DRAWDOWN_WINDOW));
    if (dd) parts.push(`近3個月最大回檔${pct(dd.percent)}（${mmdd(dd.peak)}→${mmdd(dd.trough)}）`);
    const vShort = avgVolume(candles, VOLUME_SHORT);
    const vLong = avgVolume(candles, VOLUME_LONG);
    if (vShort != null && vLong) parts.push(`20日均量為60日的${(vShort / vLong).toFixed(2)}倍`);
  }
  if (opts.index && opts.index.candles.length > 0) {
    const rel: string[] = [];
    for (const n of opts.compact ? [RELATIVE_WINDOWS[1]] : RELATIVE_WINDOWS) {
      if (candles.length <= n) continue;
      const mine = returnOver(candles, n);
      const idx = indexReturnBetween(opts.index.candles, candles[candles.length - 1 - n].time, last.time);
      if (mine == null || idx == null) continue;
      const diff = mine - idx;
      rel.push(`${n}日${pct(idx)}（個股${pct(mine)}，${diff >= 0 ? "強" : "弱"}${Math.abs(diff).toFixed(1)}個百分點）`);
    }
    if (rel.length > 0) parts.push(`${opts.index.name}同期${rel.join("、")}`);
  }
  return `- 價格：${parts.join("；")}`;
}

/** 從最新一天往回數同方向（買超/賣超）連續幾天；遇到缺資料或 0 就停。數到資料開頭還沒斷就是「至少」。 */
function streak(values: Array<number | undefined>): string | undefined {
  const latest = values[values.length - 1];
  if (latest == null || latest === 0) return undefined;
  let n = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v == null || v === 0 || Math.sign(v) !== Math.sign(latest)) break;
    n++;
  }
  return `連${latest > 0 ? "買" : "賣"}${n === values.length ? "至少" : ""}${n}天`;
}

export function describeChipsHistory(days: TwChipsDay[], ratios: ChipsRatios | null, compact: boolean): string[] {
  const lines: string[] = [];
  // 從最後一個有資料的日子（最新幾天可能是「還沒公布」）往回取「連續都有資料」的那一段；
  // 更早的天數沒抓到（冷快取逾時、限流）就不顯示那個累計區間，不拿缺資料的天數硬加。
  let end = days.length - 1;
  while (end >= 0 && days[end].foreignNet == null) end--;
  let start = end;
  while (start > 0 && days[start - 1].foreignNet != null) start--;
  const upto = end >= 0 ? days.slice(start, end + 1) : [];
  const windows = (compact ? [INSTI_WINDOWS[0], INSTI_WINDOWS[2]] : [...INSTI_WINDOWS]).filter((n) => n <= upto.length);
  if (windows.length > 0) {
    const lastDate = upto[upto.length - 1].date;
    const who: Array<[string, keyof TwChipsDay]> = compact
      ? [["外資", "foreignNet"], ["投信", "trustNet"]]
      : [["外資", "foreignNet"], ["投信", "trustNet"], ["自營商", "dealerNet"]];
    const segs = who.map(([name, key]) => {
      const series = upto.map((d) => d[key] as number | undefined);
      const sums = windows.map((n) => signedLots(series.slice(-n).reduce<number>((s, v) => s + (v ?? 0), 0)));
      const st = streak(series);
      return `${name}${sums.join("／")}${st ? `（${st}）` : ""}`;
    });
    const wanted = compact ? INSTI_WINDOWS[2] : INSTI_WINDOWS[INSTI_WINDOWS.length - 1];
    const partialNote = windows[windows.length - 1] < wanted ? "（更早的天數這次沒取得）" : "";
    lines.push(`- 法人近${windows.join("／")}日買賣超（張，至${mmdd(lastDate)}）${partialNote}：${segs.join("；")}`);
  }

  const recent = days.slice(-RATIO_DAYS);
  const util = recent.flatMap((d) =>
    d.marginBalance != null && d.marginQuota ? [{ date: d.date, value: Math.round((d.marginBalance / d.marginQuota) * 10000) / 100, balance: d.marginBalance }] : []
  );
  if (util.length >= 2) {
    const first = util[0];
    const last = util[util.length - 1];
    const trend = compact ? `${first.value.toFixed(2)}%→${last.value.toFixed(2)}%` : util.map((u) => u.value.toFixed(2)).join("→") + "%";
    lines.push(
      `- 融資使用率（${mmdd(first.date)}～${mmdd(last.date)}逐日）：${trend}，${pointDelta(last.value, first.value, mmdd(first.date))}；餘額${first.balance.toLocaleString("en-US")}→${last.balance.toLocaleString("en-US")}張`
    );
  }
  const fh = recent.flatMap((d) => (d.foreignHoldingPercent != null ? [{ date: d.date, value: d.foreignHoldingPercent }] : []));
  if (fh.length >= 2) {
    const first = fh[0];
    const last = fh[fh.length - 1];
    const trend = compact ? `${first.value.toFixed(2)}%→${last.value.toFixed(2)}%` : fh.map((u) => u.value.toFixed(2)).join("→") + "%";
    lines.push(`- 外資持股比例（${mmdd(first.date)}～${mmdd(last.date)}逐日）：${trend}，${pointDelta(last.value, first.value, mmdd(first.date))}`);
  }
  const major = ratios?.majorHolders;
  if (major && !compact) {
    const weeks = major.prevDate ? [major.prevDate, major.date] : [major.date];
    lines.push(
      `- 大戶持股（集保週資料）：本站只累積了${weeks.length}週（${weeks.map(mmdd).join("、")}那週），沒有更長的週趨勢`
    );
  }
  return lines;
}

export function describeFundamentalsHistory(h: FundamentalsHistory | null, isTw: boolean, compact: boolean): string[] {
  if (!h) return [];
  const lines: string[] = [];
  const yoy = h.revenue.filter((r): r is typeof r & { yoyPercent: number } => r.yoyPercent != null);
  if (yoy.length >= 3) {
    const shown = yoy.slice(-(compact ? REVENUE_SHOWN_MONTHS_COMPACT : REVENUE_SHOWN_MONTHS));
    let positiveRun = 0;
    for (let i = yoy.length - 1; i >= 0 && yoy[i].yoyPercent > 0; i--) positiveRun++;
    let negativeRun = 0;
    for (let i = yoy.length - 1; i >= 0 && yoy[i].yoyPercent < 0; i--) negativeRun++;
    const run = positiveRun > 0 ? `最近連續${positiveRun}個月年增` : negativeRun > 0 ? `最近連續${negativeRun}個月年減` : "";
    const positives = yoy.filter((r) => r.yoyPercent > 0).length;
    const extra = compact || positiveRun === yoy.length ? run : `近${yoy.length}月中${positives}個月年增${run ? `、${run}` : ""}`;
    lines.push(
      `- 月營收年增率（${shown[0].period}～${shown[shown.length - 1].period.slice(5)}月）：${shown.map((r) => pct(r.yoyPercent)).join("、")}${extra ? `；${extra}` : ""}`
    );
  }
  if (h.eps.length >= 2) {
    const shown = h.eps.slice(-EPS_SHOWN_QUARTERS);
    const unit = isTw ? "元" : "美元";
    let sumNote = "";
    if (!compact && h.eps.length >= 8) {
      const recent4 = h.eps.slice(-4).reduce((s, e) => s + e.eps, 0);
      const prior4 = h.eps.slice(-8, -4).reduce((s, e) => s + e.eps, 0);
      sumNote = `；近4季合計${recent4.toFixed(2)}，前4季${prior4.toFixed(2)}`;
    }
    lines.push(`- 單季EPS（${unit}）：${shown.map((e) => `${e.period.replace(/\s+/g, "")} ${e.eps}`).join("、")}${sumNote}`);
  }
  if (lines.length > 0) {
    // 台股官方季報 EPS 是年度累計（見 stock.ts 財報那行），這裡是單季，口徑不同要講清楚。
    lines.push(
      isTw
        ? `（營收/EPS多期取自${h.source}；這裡的季EPS是單季，上方財報那行官方EPS是年度累計，不要直接比）`
        : `（EPS多期取自${h.source}）`
    );
  }
  return lines;
}

/** 使用者問到的期間逐日明細（最多 HISTORY_PERIOD_MAX_DAYS 天）。期間內沒有交易日時給最接近的前一個交易日。 */
export function describePeriodDetail(
  period: HistoryPeriod,
  candles: Candle[],
  chipsDays: TwChipsDay[],
  isTw: boolean
): string | undefined {
  if (candles.length < 2) return undefined;
  let idxs: number[];
  let note = "";
  if ("lastTradingDays" in period) {
    const n = Math.min(period.lastTradingDays, HISTORY_PERIOD_MAX_DAYS);
    idxs = Array.from({ length: Math.min(n, candles.length - 1) }, (_, i) => candles.length - Math.min(n, candles.length - 1) + i);
  } else {
    if (period.to < candles[0].time) return `- 使用者問的期間（${period.label}）早於本站這次取得的日K範圍（${candles[0].time}起），沒有逐日資料`;
    idxs = candles.flatMap((c, i) => (i > 0 && c.time >= period.from && c.time <= period.to ? [i] : []));
    if (idxs.length === 0) {
      const prev = candles.reduce<number>((found, c, i) => (c.time <= period.to && i > 0 ? i : found), -1);
      if (prev === -1) return undefined;
      idxs = [prev];
      note = "（該期間沒有交易，列最接近的前一個交易日）";
    } else if (idxs.length > HISTORY_PERIOD_MAX_DAYS) {
      idxs = idxs.slice(-HISTORY_PERIOD_MAX_DAYS);
      note = `（只列最後${HISTORY_PERIOD_MAX_DAYS}個交易日）`;
    }
  }
  const chipsByDate = new Map(chipsDays.map((d) => [d.date, d]));
  const rows = idxs.map((i) => {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const chg = prevClose > 0 ? (c.close / prevClose - 1) * 100 : 0;
    const chips = chipsByDate.get(c.time);
    const chipsText =
      chips?.foreignNet != null ? ` 外資${signedLots(chips.foreignNet)}張 投信${signedLots(chips.trustNet ?? 0)}張` : "";
    return `${mmdd(c.time)} 收${fmtPrice(c.close)}(${pct(chg, 2)}) 量${fmtVolume(c.volume, isTw)}${chipsText}`;
  });
  return `- 使用者問的期間（${period.label}）逐日，回答這段期間要用這幾天的數字${note}：${rows.join("；")}`;
}

export interface HistoryContextInput {
  quote: Pick<Quote, "symbol" | "market" | "board">;
  /** 1年日K（舊到新） */
  candles: Candle[] | undefined;
  chipsRatios: ChipsRatios | null;
  period?: HistoryPeriod;
  /** 多檔比較：每檔更短 */
  compact: boolean;
}

/** 整個【歷史脈絡】區塊；什麼都算不出來回 undefined。不會丟錯。 */
export async function buildHistoryContext(input: HistoryContextInput): Promise<string | undefined> {
  const { quote, chipsRatios, period, compact } = input;
  const candles = (input.candles ?? []).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.time));
  const isTw = quote.market === "TW";
  const indexSymbol = isTw ? "^TWII" : "^GSPC";
  const indexName = isTw ? "加權指數" : "S&P500";

  const twExchange = isTw ? await withBudget(ensureTwUniverseWarm().then(() => resolveTwExchange(quote.symbol)), undefined, 3000) : undefined;
  const chipsExchange = twExchange === "TWSE" ? "TWSE" : twExchange === "TPEx" ? "TPEX" : undefined;
  const tradingDates = candles.map((c) => c.time);

  const [indexChart, chipsDays, fundamentals] = await Promise.all([
    withBudget(getChart(indexSymbol, "3m", "US"), null),
    chipsExchange && quote.board !== "emerging" && tradingDates.length > 0
      ? withBudget(getTwChipsHistory(quote.symbol, chipsExchange, tradingDates, CHIPS_PARTIAL_DEADLINE_MS), [] as TwChipsDay[])
      : Promise.resolve([] as TwChipsDay[]),
    withBudget(isTw ? getTwFundamentalsHistory(quote.symbol, twExchange) : getUsFundamentalsHistory(quote.symbol), null),
  ]);

  const lines: string[] = [];
  const price = describePriceHistory(candles, {
    isTw,
    compact,
    index: indexChart?.candles.length ? { name: indexName, candles: indexChart.candles } : undefined,
  });
  if (price) lines.push(price);
  if (isTw) lines.push(...describeChipsHistory(chipsDays, chipsRatios, compact));
  lines.push(...describeFundamentalsHistory(fundamentals, isTw, compact));
  if (period) {
    const detail = describePeriodDetail(period, candles, chipsDays, isTw);
    if (detail) lines.push(detail);
  }
  if (lines.length === 0) return undefined;
  return `${HISTORY_SECTION_TITLE}（程式算好，直接引用勿重算；回答買不買／強不強時必須拿這裡的過去走勢跟今天對照著講；未列出的期間/項目＝沒有資料）\n${lines.join("\n")}`;
}
