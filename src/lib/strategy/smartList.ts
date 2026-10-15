import { kvEnabled, redis } from "@/lib/data/kv";
import { searchStocks } from "@/lib/data";
import { getMarketQuoteMap } from "@/lib/data/marketQuoteMap";
import { overlayLiveCandle } from "@/lib/data/liveCandle";
import { mapWithConcurrency } from "@/lib/data/cache";
import { getMarketStatus } from "@/lib/marketStatus";
import { getStore, type Row } from "@/lib/auth/store";
import { INDICATOR_TYPE_MAP, type EvalContext, type IndicatorNeed } from "./indicatorCatalog";
import { evaluateStrategy, type UserIndicator } from "./engine";
import { getBacktestCandles } from "./backtestData";
import { listIndicators, listStrategies, prefetchStrategyTables, strategyIndicatorIds, type StrategyView } from "./store";
import { loadContextExtras, needsOf, type Target } from "./runner";
import {
  canStillPass,
  dueSmartSlot,
  EMPTY_SMART_DATA,
  failingConditions,
  mergeSmartRun,
  normalizeSmartConfig,
  SMART_UNIVERSE,
  type SmartEval,
  type SmartListConfig,
  type SmartListData,
} from "./smartListCore";

/**
 * 「我的智能清單」的執行與儲存（規則與合併邏輯見 smartListCore.ts）。
 *
 * 資料：日K用回測同一份 Yahoo 5 年日K（一檔一天抓一次、共用快取，不打證交所逐月 API——300 檔逐月抓會被限流），
 * 今天這根用全市場報價表（盤中＝即時、收盤後＝收盤）補上；籌碼、基本面跟模擬倉同一個載入函式（runner.loadContextExtras）。
 * 本站評等、即時五檔很貴：先用其他條件判斷，還有可能符合的才去算（每次最多 PHASE2_MAX 檔）。
 * 儲存：Redis `smart-list:v1:{userId}`（一個 JSON）；設定存在即時提醒設定（Alerts 列的 SmartList 欄）。
 */

const KEY = (userId: string) => `smart-list:v1:${userId}`;
const memory = new Map<string, SmartListData>();
/** 每次最多幾檔去算本站評等／五檔（第二階段） */
const PHASE2_MAX = 60;
/** 日K只取最近幾根（指標最長 240 日均線，留暖機） */
const CANDLES_KEEP = 300;
const EXPENSIVE: IndicatorNeed[] = ["rating", "orderbook"];

export async function getSmartList(userId: string): Promise<SmartListData> {
  if (!kvEnabled || !redis) return memory.get(userId) ?? EMPTY_SMART_DATA;
  const raw = await redis.get<SmartListData | string>(KEY(userId)).catch(() => null);
  if (!raw) return EMPTY_SMART_DATA;
  return typeof raw === "string" ? (JSON.parse(raw) as SmartListData) : raw;
}

async function saveSmartList(userId: string, data: SmartListData): Promise<void> {
  if (!kvEnabled || !redis) {
    memory.set(userId, data);
    return;
  }
  await redis.set(KEY(userId), JSON.stringify(data));
}

function expensiveIds(cfgIds: string[], indicators: UserIndicator[]): Set<string> {
  const ids = new Set(cfgIds);
  return new Set(indicators.filter((i) => ids.has(i.id) && (INDICATOR_TYPE_MAP.get(i.typeId)?.needs ?? []).some((n) => EXPENSIVE.includes(n))).map((i) => i.id));
}

/** 跑一次：回傳這次的摘要（也寫進清單的執行紀錄） */
export async function runSmartList(
  userId: string,
  config: SmartListConfig,
  opts: { slot: string; slotKey: string; now?: Date; deadline?: number },
): Promise<{ data: SmartListData; note: string }> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 100_000;
  await prefetchStrategyTables(userId);
  const [strategies, indicators] = await Promise.all([listStrategies(userId), listIndicators(userId)]);
  const picked = config.strategyIds.map((id) => strategies.find((s) => s.id === id)).filter((s): s is StrategyView => !!s);
  const prev = await getSmartList(userId);
  if (picked.length === 0) {
    const note = "沒有選策略（或選的策略已刪除），這次沒有更新";
    const merged = mergeSmartRun(prev, [], { now, slot: opts.slot, slotKey: opts.slotKey, note });
    await saveSmartList(userId, merged.data);
    return { data: merged.data, note };
  }

  const live = getMarketStatus("TW") === "open";
  const [table, quoteMap] = await Promise.all([
    searchStocks({ market: "TW", sortBy: "turnover", sortDir: "desc" }).catch(() => []),
    getMarketQuoteMap("TW").catch(() => new Map()),
  ]);
  const top = table.filter((i) => i.volume > 0).slice(0, SMART_UNIVERSE);
  const universe = new Map<string, Target>();
  for (const i of top) universe.set(i.symbol.toUpperCase(), { symbol: i.symbol, market: "TW", name: i.name });
  for (const e of prev.entries) if (!universe.has(e.symbol.toUpperCase())) universe.set(e.symbol.toUpperCase(), { symbol: e.symbol, market: "TW", name: e.name });

  const allNeeds = new Set<IndicatorNeed>();
  for (const s of picked) needsOf(s.config, indicators).forEach((n) => allNeeds.add(n));
  const cheapNeeds = new Set([...allNeeds].filter((n) => !EXPENSIVE.includes(n)));
  const expensiveNeeds = new Set([...allNeeds].filter((n) => EXPENSIVE.includes(n)));
  const unknownByStrategy = new Map(picked.map((s) => [s.id, expensiveIds(strategyIndicatorIds(s.config), indicators)]));

  let unfinished = 0;
  // 第一階段先記下已經有答案的策略；需要本站評等／五檔才判斷得了的策略留到第二階段（不影響其他策略的結果）
  type Pending = { t: Target; ctx: EvalContext; price: number | null; passed: string[]; failing: string[]; pending: StrategyView[] };
  const phase2: Pending[] = [];
  const evals: SmartEval[] = [];
  await mapWithConcurrency([...universe.values()], 6, async (t) => {
    if (Date.now() > deadline) {
      unfinished++;
      return;
    }
    const hist = await getBacktestCandles(t.symbol, "TW").catch(() => null);
    if (!hist || hist.length < 30) return;
    const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    const quote = quoteMap.get(t.symbol) ?? null;
    const candles = overlayLiveCandle(hist.filter((c) => c.time < today).slice(-CANDLES_KEEP), quote, { marketOpen: live, now });
    const ctx: EvalContext = { symbol: t.symbol, market: "TW", candles };
    if (cheapNeeds.size > 1) await loadContextExtras(ctx, t, cheapNeeds, live);
    const price = candles.at(-1)?.close ?? null;
    const passed: string[] = [];
    const failing: string[] = [];
    const pending: StrategyView[] = [];
    for (const s of picked) {
      const d = evaluateStrategy(s.config, indicators, ctx);
      const unknown = unknownByStrategy.get(s.id)!;
      if (unknown.size > 0 && canStillPass(s.config, d.hits, unknown)) {
        pending.push(s);
        continue;
      }
      if (d.buy) passed.push(s.name);
      else failing.push(`${s.name}：${failingConditions(s.config, d.hits, d.score).join("、") || "條件未成立"}`);
    }
    if (pending.length) phase2.push({ t, ctx, price, passed, failing, pending });
    else evals.push({ symbol: t.symbol, name: t.name, price, passed, failing });
  });

  // 第二階段：需要本站評等或五檔的，每次最多 PHASE2_MAX 檔。清單裡已有的先算，其餘依成交值排名、從上次停下的位置接著輪（不會每次都只算同一批）
  const inList = new Set(prev.entries.map((e) => e.symbol.toUpperCase()));
  const order = [...universe.keys()];
  const listed = phase2.filter((x) => inList.has(x.t.symbol.toUpperCase()));
  const rest = phase2.filter((x) => !inList.has(x.t.symbol.toUpperCase())).sort((a, b) => order.indexOf(a.t.symbol.toUpperCase()) - order.indexOf(b.t.symbol.toUpperCase()));
  const cursor = rest.length ? (prev.cursor ?? 0) % rest.length : 0;
  const queue = [...listed, ...rest.slice(cursor), ...rest.slice(0, cursor)];
  const take = queue.slice(0, PHASE2_MAX);
  const left = queue.slice(PHASE2_MAX);
  let phase2Done = 0;
  await mapWithConcurrency(take, 3, async (x) => {
    if (Date.now() > deadline) {
      left.push(x);
      return;
    }
    phase2Done++;
    await loadContextExtras(x.ctx, x.t, expensiveNeeds, live);
    for (const s of x.pending) {
      const d = evaluateStrategy(s.config, indicators, x.ctx);
      if (d.buy) x.passed.push(s.name);
      else x.failing.push(`${s.name}：${failingConditions(s.config, d.hits, d.score).join("、") || "條件未成立"}`);
    }
    evals.push({ symbol: x.t.symbol, name: x.t.name, price: x.price, passed: x.passed, failing: x.failing });
  });
  // 沒輪到的：已經有策略符合的照樣加入／更新；都還不知道的當作這次沒檢查（不改狀態）
  for (const x of left) if (x.passed.length) evals.push({ symbol: x.t.symbol, name: x.t.name, price: x.price, passed: x.passed, failing: [] });
  const nextCursor = rest.length ? (cursor + Math.max(0, take.length - listed.length)) % rest.length : 0;

  const qualifiedNow = evals.filter((e) => e.passed.length > 0).length;
  const note = [
    `${live ? "盤中即時" : "收盤後"}掃描 ${evals.length} 檔（成交值前 ${top.length} 名＋清單內 ${prev.entries.length} 檔）`,
    `符合 ${qualifiedNow} 檔`,
    phase2.length ? `需本站評等的有 ${phase2.length} 檔、這次算 ${phase2Done} 檔${left.length ? `、其餘 ${left.length} 檔下次輪到再算` : ""}` : "",
    unfinished ? `${unfinished} 檔時間不夠先略過` : "",
  ]
    .filter(Boolean)
    .join("，");
  const merged = mergeSmartRun(prev, evals, { now, slot: opts.slot, slotKey: opts.slotKey, note });
  const data = { ...merged.data, cursor: nextCursor };
  await saveSmartList(userId, data);
  return { data, note: `${note}；新加入 ${merged.added}、移除 ${merged.removed}` };
}

const doneMemo = new Set<string>();

/**
 * 排程（/api/cron/warm-cache 每 5 分鐘順帶呼叫）：所有開啟智能清單的帳號，到了自己設定的時間就更新一次。
 * 同一時間只跑一次（以清單的執行紀錄為準）；週末不跑；一次觸發最多跑 budgetMs，沒輪到的下一次觸發再跑。
 */
export async function runSmartListsDue(now: Date = new Date(), budgetMs = 100_000): Promise<string> {
  const tpe = new Date(now.getTime() + 8 * 3_600_000);
  if (tpe.getUTCDay() === 0 || tpe.getUTCDay() === 6) return "略過：週末";
  const started = Date.now();
  let rows: Row[];
  try {
    [rows] = (await getStore().batch([{ op: "read", table: "Alerts" }])) as Row[][];
  } catch {
    return "略過：讀不到提醒設定";
  }
  const out: string[] = [];
  for (const r of rows) {
    if (!r.SmartList) continue;
    const cfg = normalizeSmartConfig(JSON.parse(r.SmartList || "{}"));
    if (!cfg.enabled || cfg.strategyIds.length === 0) continue;
    const day = tpe.toISOString().slice(0, 10);
    const pending = cfg.times.filter((t) => !doneMemo.has(`${r.ID}|${day}|${t}`));
    if (pending.length === 0) continue;
    const data = await getSmartList(r.ID);
    const done = new Set(data.runs.map((x) => x.slotKey));
    for (const t of cfg.times) if (done.has(`${day}|${t}`)) doneMemo.add(`${r.ID}|${day}|${t}`);
    const due = dueSmartSlot(cfg.times, now, done);
    if (!due) continue;
    if (Date.now() - started > budgetMs) {
      out.push(`${r.Account}：時間不夠，下次再跑`);
      continue;
    }
    try {
      const res = await runSmartList(r.ID, cfg, { ...due, now, deadline: started + budgetMs });
      doneMemo.add(`${r.ID}|${due.slotKey}`);
      out.push(`${r.Account} ${due.slot}：${res.note}`);
    } catch (err) {
      out.push(`${r.Account}：失敗 ${(err as Error).message}`);
    }
  }
  return out.length ? out.join("｜") : "略過：沒有到時間的智能清單";
}
