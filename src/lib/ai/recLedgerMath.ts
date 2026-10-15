/**
 * 推薦紀錄（歷史回顧）的資料格式與純計算（前後端共用，不碰資料庫；有測試 src/__tests__/recLedger.test.ts）。
 *
 * 2026-10-15 使用者：「要增加一個歷史回顧圖表，請記住現在推薦的買點、價格等資料，然後我會定期檢查看是否照建議操作會賺錢」。
 * 每一筆＝某檔股票某天「新進入」某個推薦名單（AI 建議名單、技術訊號共振股）時的快照：推薦價、買點區間、出場價、評等字樣；
 * 之後每個交易日收盤記一次收盤價（path），最多追蹤 REC_TRACK_DAYS 個交易日，所以不用再抓歷史K線就能算報酬。
 */

export type RecSource = "ai" | "momentum";

export const REC_SOURCE_LABEL: Record<RecSource, string> = {
  ai: "AI 建議名單",
  momentum: "技術訊號共振股",
};

/** 推薦後最多追蹤幾個交易日的收盤價 */
export const REC_TRACK_DAYS = 60;
/** 「照建議操作」沒有其他出場條件時，最多持有幾個交易日就結算（技術訊號共振股沒有出場價，用這個上限） */
export const REC_MAX_HOLD_DAYS = 20;
/** 統計用的固定持有天數（交易日） */
export const REC_HORIZONS = [1, 5, 20] as const;

export interface RecEntry {
  /** `${day}:${source}:${symbol}` */
  id: string;
  source: RecSource;
  symbol: string;
  name: string;
  /** 進入名單的台北日期／時間 */
  day: string;
  time: string;
  at: string;
  /** 推薦當下價格（AI＝評等計算價；共振股＝收盤後的收盤價） */
  price: number;
  /** 進入名單時的排名（1＝第一名） */
  rank?: number;
  /** 本站評等字樣、操作計畫、把握程度、理由（AI 名單才有） */
  label?: string;
  plan?: string;
  confidence?: string;
  reason?: string;
  /** 買點區間（評等的支撐區）、出場價、拉回加碼價（AI 名單才有；沒有是 null） */
  zoneLow?: number | null;
  zoneHigh?: number | null;
  stop?: number | null;
  addAt?: number | null;
  /** 技術訊號（共振股才有） */
  signals?: string[];
  /** 推薦後每個交易日的收盤價 [日期, 收盤]（含推薦當天若在收盤前推薦），依日期排序 */
  path: Array<[string, number]>;
  /** 被移出名單的日期／價格／原因（還在名單內就沒有） */
  exitDay?: string;
  exitPrice?: number | null;
  exitReason?: string;
}

/** 推薦日之後（不含當天）的第 h 個交易日收盤；還沒到就 null */
export function closeAfter(e: Pick<RecEntry, "day" | "path">, h: number): number | null {
  const after = e.path.filter(([d]) => d > e.day);
  return after.length >= h ? after[h - 1][1] : null;
}

const pctOf = (from: number, to: number | null | undefined) => (to != null && from > 0 ? (to / from - 1) * 100 : null);

/** 固定持有 h 個交易日（以推薦價買、第 h 個交易日收盤賣）的報酬 %；還沒滿 h 天是 null */
export function horizonReturn(e: RecEntry, h: number): number | null {
  return pctOf(e.price, closeAfter(e, h));
}

export interface FollowOutcome {
  /** 報酬 %（以推薦價買進） */
  pct: number | null;
  /** 已結算（出場）或還持有中 */
  closed: boolean;
  /** 出場（或目前）日期與價格 */
  day: string | null;
  price: number | null;
  reason: string;
  /** 持有了幾個交易日 */
  heldDays: number;
}

/**
 * 「照建議操作」的結果：以推薦價買進，之後依序看每個交易日——
 *  ① 收盤跌破建議的出場價（AI 名單才有）→ 以該日收盤賣出；
 *  ② 被移出名單 → 以移出時的價格賣出；
 *  ③ 持有滿 REC_MAX_HOLD_DAYS 個交易日 → 以那天收盤賣出；
 * 都沒發生就是「持有中」，報酬用最新收盤（或呼叫端給的即時價 livePrice）。
 */
export function followOutcome(e: RecEntry, livePrice?: number | null): FollowOutcome {
  const after = e.path.filter(([d]) => d > e.day);
  for (let i = 0; i < after.length; i++) {
    const [d, c] = after[i];
    if (e.exitDay && d >= e.exitDay && e.exitPrice != null && e.exitPrice > 0) {
      return { pct: pctOf(e.price, e.exitPrice), closed: true, day: e.exitDay, price: e.exitPrice, reason: e.exitReason || "移出名單", heldDays: i + 1 };
    }
    if (e.stop != null && e.stop > 0 && c <= e.stop) {
      return { pct: pctOf(e.price, c), closed: true, day: d, price: c, reason: `收盤 ${c} 跌破出場價 ${e.stop}`, heldDays: i + 1 };
    }
    if (i + 1 >= REC_MAX_HOLD_DAYS) {
      return { pct: pctOf(e.price, c), closed: true, day: d, price: c, reason: `持有滿 ${REC_MAX_HOLD_DAYS} 個交易日`, heldDays: i + 1 };
    }
  }
  // 推薦當天就被移出（還沒有之後的收盤）
  if (e.exitDay && e.exitPrice != null && e.exitPrice > 0 && after.length === 0) {
    return { pct: pctOf(e.price, e.exitPrice), closed: true, day: e.exitDay, price: e.exitPrice, reason: e.exitReason || "移出名單", heldDays: 0 };
  }
  const lastClose = e.path.length ? e.path[e.path.length - 1] : null;
  const price = livePrice != null && livePrice > 0 ? livePrice : (lastClose?.[1] ?? null);
  return { pct: pctOf(e.price, price), closed: false, day: lastClose?.[0] ?? null, price, reason: "持有中", heldDays: after.length };
}

/** 同期 0050：推薦日收盤 → 第 h 個交易日收盤的報酬 %（bench＝日期→0050 收盤） */
export function benchReturn(bench: Record<string, number>, e: Pick<RecEntry, "day" | "path">, h: number): number | null {
  const base = bench[e.day];
  const after = e.path.filter(([d]) => d > e.day);
  if (!base || after.length < h) return null;
  return pctOf(base, bench[after[h - 1][0]] ?? null);
}

export interface RecStats {
  count: number;
  closed: number;
  /** 照建議操作：已結算的勝率 %、平均報酬 %（已結算＋持有中分開） */
  winRate: number | null;
  avgClosed: number | null;
  avgOpen: number | null;
  /** 固定持有 1／5／20 日的平均報酬、樣本數、同期 0050 平均 */
  horizons: Array<{ h: number; n: number; avg: number | null; bench: number | null; winRate: number | null }>;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function recStats(entries: RecEntry[], bench: Record<string, number>, live: Record<string, number> = {}): RecStats {
  const outcomes = entries.map((e) => followOutcome(e, live[e.symbol.toUpperCase()]));
  const closed = outcomes.filter((o) => o.closed && o.pct != null).map((o) => o.pct!);
  const open = outcomes.filter((o) => !o.closed && o.pct != null).map((o) => o.pct!);
  return {
    count: entries.length,
    closed: closed.length,
    winRate: closed.length ? (closed.filter((x) => x > 0).length / closed.length) * 100 : null,
    avgClosed: avg(closed),
    avgOpen: avg(open),
    horizons: REC_HORIZONS.map((h) => {
      const rs = entries.map((e) => horizonReturn(e, h)).filter((x): x is number => x != null);
      const bs = entries.map((e) => benchReturn(bench, e, h)).filter((x): x is number => x != null);
      return { h, n: rs.length, avg: avg(rs), bench: avg(bs), winRate: rs.length ? (rs.filter((x) => x > 0).length / rs.length) * 100 : null };
    }),
  };
}

/** 平均報酬曲線：推薦後第 0..maxDay 個交易日的平均報酬 %（只算已經走到那天的推薦），以及同期 0050 平均 */
export function returnCurve(entries: RecEntry[], bench: Record<string, number>, maxDay = REC_MAX_HOLD_DAYS): Array<{ day: number; n: number; avg: number | null; bench: number | null }> {
  const out: Array<{ day: number; n: number; avg: number | null; bench: number | null }> = [{ day: 0, n: entries.length, avg: 0, bench: 0 }];
  for (let h = 1; h <= maxDay; h++) {
    const rs = entries.map((e) => horizonReturn(e, h)).filter((x): x is number => x != null);
    const bs = entries.map((e) => benchReturn(bench, e, h)).filter((x): x is number => x != null);
    out.push({ day: h, n: rs.length, avg: avg(rs), bench: avg(bs) });
  }
  return out;
}

/** 名單比對（代號大寫）：prev＝null 代表從來沒有紀錄（全部算新進入） */
export function diffRecSymbols(prev: readonly string[] | null, next: readonly string[]): { added: string[]; removed: string[] } {
  const p = new Set((prev ?? []).map((s) => s.toUpperCase()));
  const n = new Set(next.map((s) => s.toUpperCase()));
  return { added: [...n].filter((s) => !p.has(s)), removed: [...p].filter((s) => !n.has(s)) };
}

/** 收盤後要補今天收盤價的紀錄：推薦日 ≤ 今天、今天還沒記、推薦後追蹤天數未滿 */
export function needsClose(e: RecEntry, today: string): boolean {
  if (e.day > today) return false;
  if (e.path.some(([d]) => d === today)) return false;
  return e.path.filter(([d]) => d > e.day).length < REC_TRACK_DAYS;
}
