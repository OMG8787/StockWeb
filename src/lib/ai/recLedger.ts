import { kvEnabled, redis } from "@/lib/data/kv";
import { getQuote, getMultiSignalStocks, searchStocks } from "@/lib/data";
import { dayKeyInZone } from "@/lib/data/liveCandle";
import { taipeiDayKey, taipeiWeekday } from "@/lib/pollingSchedule";
import { diffRecSymbols, needsClose, REC_TRACK_DAYS, type RecEntry, type RecSource } from "./recLedgerMath";

/**
 * 推薦紀錄（歷史回顧）的儲存與每日更新（2026-10-15 使用者：「請記住現在推薦的買點、價格等資料，然後我會定期檢查看是否照建議操作會賺錢」）。
 * 格式與報酬計算見 recLedgerMath.ts。
 *
 * Redis：
 *  - `rec-ledger:v1:day:{日期}`  hash：紀錄 id → RecEntry（每天一個 hash）
 *  - `rec-ledger:v1:days`         set：有紀錄的日期
 *  - `rec-ledger:v1:open:{來源}`  hash：代號 → 目前在名單內那筆紀錄的日期（移出時清成空字串）
 *  - `rec-ledger:v1:last:{來源}`  上一份名單（比對進出用）
 *  - `rec-ledger:v1:bench`        hash：日期 → 0050 收盤（對照用）
 *  - `rec-ledger:v1:view`         整理好的最近紀錄（讀取用快取，寫入時清掉）
 *  - `rec-ledger:v1:done:{日期}`  每日收盤更新做過的標記
 * 成本：AI 名單沒變動時每次重算只多 1 個 GET；每日收盤更新約「最近 100 天的天數」×2 個指令（一天一次）。
 * fail open：沒有 Redis、讀寫失敗都安靜略過，不影響名單本身。
 */

const K = {
  day: (d: string) => `rec-ledger:v1:day:${d}`,
  days: "rec-ledger:v1:days",
  open: (s: RecSource) => `rec-ledger:v1:open:${s}`,
  last: (s: RecSource) => `rec-ledger:v1:last:${s}`,
  bench: "rec-ledger:v1:bench",
  view: "rec-ledger:v1:view",
  done: (d: string) => `rec-ledger:v1:done:${d}`,
};
/** 紀錄保存天數（日曆天） */
export const REC_RETENTION_DAYS = 365;
/** 每日更新只看最近幾個日曆天的紀錄（REC_TRACK_DAYS 個交易日 ≈ 90 個日曆天，留餘裕） */
const TRACK_CALENDAR_DAYS = 100;
const VIEW_TTL_SECONDS = 30 * 60;
const TW_BENCH = "0050";
/** 技術訊號共振股只記前幾名（跟 /api/momentum 顯示的一樣） */
export const REC_MOMENTUM_TOP = 10;

export interface RecItemInput {
  symbol: string;
  name: string;
  price: number;
  rank?: number;
  label?: string;
  plan?: string;
  confidence?: string;
  reason?: string;
  zoneLow?: number | null;
  zoneHigh?: number | null;
  stop?: number | null;
  addAt?: number | null;
  signals?: string[];
}

function taipeiTime(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(11, 16);
}

const parse = (v: unknown): RecEntry | null => {
  try {
    const e = (typeof v === "string" ? JSON.parse(v) : v) as RecEntry;
    return e && e.symbol && e.source ? e : null;
  } catch {
    return null;
  }
};

/**
 * 名單重算後呼叫（輸入完整時）：新進入名單的記一筆（當天已記過且被移出又回來就重新打開那筆），被移出的記下移出日期與價格。
 * exitPriceOf：被移出的股票現在的價格（呼叫端手上的報價／評等價）；拿不到就 null（照建議操作會改用之後的收盤）。
 */
export async function recordRecommendations(args: {
  source: RecSource;
  items: RecItemInput[];
  exitReason: string;
  exitPriceOf?: (symbol: string) => Promise<number | null>;
  now?: Date;
}): Promise<number> {
  if (!kvEnabled || !redis) return 0;
  const now = args.now ?? new Date();
  try {
    const raw = await redis.get<string[] | string>(K.last(args.source));
    const prev = raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as string[]) : null;
    const next = args.items.map((i) => i.symbol.toUpperCase());
    const { added, removed } = diffRecSymbols(prev, next);
    if (added.length === 0 && removed.length === 0) return 0;
    const day = taipeiDayKey(now);
    const time = taipeiTime(now);
    const openKey = K.open(args.source);
    const fields = [...added, ...removed];
    // Upstash 的 hmget 回傳 { 欄位: 值 }，執行期快取版回傳陣列：兩種都接
    const got = (await redis.hmget<string>(openKey, ...fields)) as unknown;
    const openOf = new Map(
      fields.map((s, i) => [s, String((Array.isArray(got) ? got[i] : (got as Record<string, unknown> | null)?.[s]) ?? "")]),
    );
    const writes: Record<string, Record<string, string>> = {};
    const openPatch: Record<string, string> = {};
    let n = 0;

    for (const sym of added) {
      const it = args.items.find((x) => x.symbol.toUpperCase() === sym)!;
      const id = `${day}:${args.source}:${sym}`;
      const existing = parse(await redis.hget(K.day(day), id));
      // 同一天被移出又回來：重新打開原本那筆（不重複記）
      const entry: RecEntry = existing
        ? { ...existing, exitDay: undefined, exitPrice: undefined, exitReason: undefined }
        : {
            id,
            source: args.source,
            symbol: it.symbol,
            name: it.name,
            day,
            time,
            at: now.toISOString(),
            price: it.price,
            rank: it.rank,
            label: it.label,
            plan: it.plan,
            confidence: it.confidence,
            reason: it.reason,
            zoneLow: it.zoneLow ?? null,
            zoneHigh: it.zoneHigh ?? null,
            stop: it.stop ?? null,
            addAt: it.addAt ?? null,
            signals: it.signals,
            path: [],
          };
      // 前一天還開著的同一檔（例如之前沒抓到移出）：先結掉
      const prevOpenDay = openOf.get(sym);
      if (prevOpenDay && prevOpenDay !== day) {
        const old = parse(await redis.hget(K.day(prevOpenDay), `${prevOpenDay}:${args.source}:${sym}`));
        if (old && !old.exitDay) {
          old.exitDay = day;
          old.exitPrice = it.price;
          old.exitReason = "重新進入名單（前一筆結算）";
          (writes[prevOpenDay] ??= {})[old.id] = JSON.stringify(old);
        }
      }
      (writes[day] ??= {})[id] = JSON.stringify(entry);
      openPatch[sym] = day;
      n++;
    }

    for (const sym of removed) {
      const openDay = openOf.get(sym);
      if (!openDay) continue;
      const id = `${openDay}:${args.source}:${sym}`;
      const e = parse(writes[openDay]?.[id] ?? (await redis.hget(K.day(openDay), id)));
      if (!e || e.exitDay) continue;
      e.exitDay = day;
      e.exitPrice = args.exitPriceOf ? await args.exitPriceOf(e.symbol).catch(() => null) : null;
      e.exitReason = args.exitReason;
      (writes[openDay] ??= {})[id] = JSON.stringify(e);
      openPatch[sym] = "";
      n++;
    }

    const p = redis.pipeline();
    for (const [d, fields] of Object.entries(writes)) p.hset(K.day(d), fields);
    if (Object.keys(openPatch).length) p.hset(openKey, openPatch);
    if (Object.keys(writes).length) p.sadd(K.days, ...Object.keys(writes));
    p.set(K.last(args.source), JSON.stringify(next));
    p.del(K.view);
    await p.exec();
    return n;
  } catch (err) {
    console.warn("[rec-ledger] 記錄失敗（略過）:", err);
    return 0;
  }
}

async function readDays(days: string[]): Promise<RecEntry[]> {
  if (!redis || days.length === 0) return [];
  const p = redis.pipeline();
  for (const d of days) p.hgetall(K.day(d));
  const res = (await p.exec()) as Array<Record<string, unknown> | null>;
  const out: RecEntry[] = [];
  for (const h of res) for (const v of Object.values(h ?? {})) {
    const e = parse(v);
    if (e) out.push(e);
  }
  return out;
}

async function allDays(): Promise<string[]> {
  if (!redis) return [];
  return ((await redis.smembers<string[]>(K.days)) ?? []).sort();
}

const daysAgo = (today: string, n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};

export interface RecLedgerView {
  entries: RecEntry[];
  bench: Record<string, number>;
  updatedAt: string;
}

/** 讀取保存期限內的全部紀錄（新到舊）＋ 0050 收盤；30 分鐘快取（有新紀錄時清掉）。 */
export async function readRecLedger(): Promise<RecLedgerView> {
  if (!kvEnabled || !redis) return { entries: [], bench: {}, updatedAt: new Date().toISOString() };
  const cachedView = await redis.get<RecLedgerView | string>(K.view).catch(() => null);
  if (cachedView) return typeof cachedView === "string" ? (JSON.parse(cachedView) as RecLedgerView) : cachedView;
  const today = taipeiDayKey();
  const from = daysAgo(today, REC_RETENTION_DAYS);
  const [entries, bench] = await Promise.all([
    readDays((await allDays()).filter((d) => d >= from)),
    redis.hgetall<Record<string, unknown>>(K.bench),
  ]);
  const view: RecLedgerView = {
    entries: entries.sort((a, b) => b.at.localeCompare(a.at)),
    bench: Object.fromEntries(Object.entries(bench ?? {}).map(([d, v]) => [d, Number(v)]).filter(([, v]) => Number.isFinite(v as number))),
    updatedAt: new Date().toISOString(),
  };
  await redis.set(K.view, JSON.stringify(view), { ex: VIEW_TTL_SECONDS }).catch(() => null);
  return view;
}

/** 收盤後的每日工作要在台北幾點幾分之後才做（盤後定價 14:30 撮合完，收盤價定案） */
const DAILY_AFTER_MIN = 14 * 60 + 40;
const doneMemo = new Set<string>();

/**
 * 每個交易日收盤後做一次（由 /api/cron/warm-cache 每 5 分鐘順帶呼叫，時間未到或做過就立刻略過）：
 *  ① 記 0050 收盤（對照）；② 技術訊號共振股名單進出（收盤後的名單、收盤價）；
 *  ③ 最近的紀錄補上今天收盤價；④ 清掉超過保存期限的日期。
 */
export async function runRecLedgerDaily(now: Date = new Date()): Promise<string> {
  if (!kvEnabled || !redis) return "略過：沒有 Redis";
  const wd = taipeiWeekday(now);
  const minutes = ((now.getUTCHours() + 8) % 24) * 60 + now.getUTCMinutes();
  if (wd === 0 || wd === 6 || minutes < DAILY_AFTER_MIN) return "略過：不是交易日收盤後";
  const today = taipeiDayKey(now);
  if (doneMemo.has(today)) return "略過：今天已更新";
  if (await redis.get(K.done(today))) {
    doneMemo.add(today);
    return "略過：今天已更新";
  }
  // 今天有沒有開盤：0050 最後成交在今天才算交易日（國定假日略過）
  const bench = await getQuote(TW_BENCH, "TW").catch(() => null);
  if (!bench) return "失敗：抓不到 0050 報價（下次再試）";
  if (dayKeyInZone(bench.tradeTime, "Asia/Taipei") !== today) {
    await redis.set(K.done(today), "holiday", { ex: 3 * 86_400 });
    doneMemo.add(today);
    return "略過：今天休市";
  }
  await redis.hset(K.bench, { [today]: String(bench.price) });

  // 全市場報價表（收盤後＝收盤價）：補紀錄的收盤價、技術訊號共振股移出的價格都用它，一次抓完
  const table = await searchStocks({ market: "TW", sortBy: "volume", sortDir: "desc" }).catch(() => []);
  const closeOf = new Map(table.filter((i) => i.price > 0).map((i) => [i.symbol.toUpperCase(), i.price]));

  // ② 技術訊號共振股（收盤後的名單；收盤價當推薦價）
  let momentumNote = "";
  const momentum = await getMultiSignalStocks("TW").catch(() => null);
  if (momentum) {
    const added = await recordRecommendations({
      source: "momentum",
      // 只記使用者看得到的前 REC_MOMENTUM_TOP 名（/api/momentum 也只顯示前 10 名）；整份內部名單上百檔會讓回顧變雜訊
      items: momentum.slice(0, REC_MOMENTUM_TOP).map((m, i) => ({ symbol: m.symbol, name: m.name, price: m.price, rank: i + 1, signals: m.signals.map((s) => s.label) })),
      exitReason: "移出技術訊號共振股名單",
      exitPriceOf: async (s) => closeOf.get(s.toUpperCase()) ?? null,
      now,
    });
    momentumNote = `共振股進出 ${added} 筆`;
  } else momentumNote = "共振股名單抓不到（略過）";

  // ③ 補今天收盤價
  const days = (await allDays()).filter((d) => d >= daysAgo(today, TRACK_CALENDAR_DAYS));
  const entries = await readDays(days);
  const writes: Record<string, Record<string, string>> = {};
  let filled = 0;
  for (const e of entries) {
    if (!needsClose(e, today)) continue;
    const c = closeOf.get(e.symbol.toUpperCase());
    if (!c) continue;
    e.path = [...e.path, [today, c] as [string, number]].sort((a, b) => a[0].localeCompare(b[0])).slice(-(REC_TRACK_DAYS + 1));
    (writes[e.day] ??= {})[e.id] = JSON.stringify(e);
    filled++;
  }
  const p = redis.pipeline();
  for (const [d, fields] of Object.entries(writes)) p.hset(K.day(d), fields);

  // ④ 清掉超過保存期限的日期
  const all = await allDays();
  const expired = all.filter((d) => d < daysAgo(today, REC_RETENTION_DAYS));
  if (expired.length) {
    p.del(...expired.map(K.day));
    p.del(K.days);
    const keep = all.filter((d) => !expired.includes(d));
    if (keep.length) p.sadd(K.days, ...keep);
  }
  p.del(K.view);
  p.set(K.done(today), "1", { ex: 3 * 86_400 });
  await p.exec();
  doneMemo.add(today);
  return `已更新：0050 ${bench.price}、${momentumNote}、補收盤價 ${filled} 筆${expired.length ? `、清掉 ${expired.length} 天舊紀錄` : ""}`;
}
