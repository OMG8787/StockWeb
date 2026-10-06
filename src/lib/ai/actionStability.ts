/**
 * 今日建議名單的「凍結時段穩定性」（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-06 使用者：「早上說 A，現在又說 B」。評等紀錄證實：10/6 盤前 07:51、08:05、08:35 三次重算名單都不同，
 * 10/5 收盤後（價格完全不變）14:20、18:25、21:00 也每次都有新股進出。盤前／收盤後行情已定，名單卻隨「這一次
 * 剛好抓到哪些上游資料」跳動（07:51 那次聯茂的法人資料是「無資料」、23:40 與 08:05 卻是「支持」＝輸入不完整的一次）。
 *
 * 做法（程式決定、不靠 AI）：在「資料已定」的時段（見 frozenListEpochKey），同一個時段內重算時——
 *  ①上一份名單裡的股票，只有「這次重新評等明確變成不建議買進」才會被換掉；上游抓失敗（這次沒有評等）＝未知，保留；
 *  ②空出來的名額才由這次的候選排序依序補上；
 *  ③最後仍用 selectPickGroups 的同一套排序顯示（成員穩定、順序由評等決定）。
 * 盤中（08:30～14:30 報價即時）與 14:30～22:00（三大法人、融資融券陸續公布，輸入真的在變）不套用，照常隨資料更新。
 */

/** 台北時間 08:30（試撮開始）＝報價開始即時變動，之前視為資料已定。 */
const LIVE_START_MINUTES = 8 * 60 + 30;
/** 台北時間 22:00：當天三大法人（約16:00）、融資融券（約21:00）都已公布，資料完整。 */
const DATA_COMPLETE_MINUTES = 22 * 60;
const DAY_MS = 86_400_000;
/** 上一份名單紀錄的保存時間：夠撐過整個週末（週五 22:00 → 週一 08:30 約 58 小時）。 */
export const LAST_LIST_TTL_MS = 62 * 60 * 60_000;

/**
 * 現在若處在「資料已定」的時段，回傳這個時段的代號（＝資料所屬的最後一個交易日，台北日期）；否則 null。
 *  - 平日 22:00～隔天 08:30：key＝22:00 當天的日期（週一 08:30 前＝上週五）
 *  - 週六、週日整天：key＝上週五
 * 不處理國定假日（本站沒有假日行事曆；假日整天等同週末，但這裡只是少套用穩定，不會算錯資料）。
 */
export function frozenListEpochKey(now: Date): string | null {
  const t = new Date(now.getTime() + 8 * 3_600_000); // UTC 欄位＝台北時間
  const wd = t.getUTCDay();
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  const dayKey = (shiftDays: number) => new Date(t.getTime() + shiftDays * DAY_MS).toISOString().slice(0, 10);
  if (wd === 6) return dayKey(-1);
  if (wd === 0) return dayKey(-2);
  if (minutes < LIVE_START_MINUTES) return wd === 1 ? dayKey(-3) : dayKey(-1);
  if (minutes >= DATA_COMPLETE_MINUTES) return dayKey(0);
  return null;
}

/**
 * 決定名單成員（還沒排序、最後一步交給 selectPickGroups）。
 *  - previous：同一個凍結時段上一份名單（順序＝當時顯示順序）
 *  - ranked：這次所有「建議買進」候選，依程式排序（只含候選名單前段，順序＝補位優先序）
 *  - fresh：這次重新評等後仍是建議買進的所有股票（含 previous 裡不在 ranked 內、但這次有重新評等的），用來更新價位
 *  - rejected：這次重新評等「明確不是建議買進」的代號（大寫）；沒有評等（上游失敗）的不在這裡＝未知＝保留
 */
export function stabilizeBuyPicks<T extends { symbol: string }>(args: {
  previous: readonly T[];
  ranked: readonly T[];
  fresh?: ReadonlyMap<string, T>;
  rejected: ReadonlySet<string>;
  limit: number;
}): T[] {
  const { previous, ranked, fresh, rejected, limit } = args;
  const key = (p: { symbol: string }) => p.symbol.toUpperCase();
  const rankedByKey = new Map(ranked.map((p) => [key(p), p] as const));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of previous) {
    const k = key(p);
    if (out.length >= limit) break;
    if (seen.has(k) || rejected.has(k)) continue;
    seen.add(k);
    out.push(fresh?.get(k) ?? rankedByKey.get(k) ?? p);
  }
  for (const p of ranked) {
    if (out.length >= limit) break;
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
