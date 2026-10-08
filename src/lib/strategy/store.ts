import { randomUUID } from "node:crypto";
import { getStore, type Row } from "@/lib/auth/store";
import { taipeiNow } from "@/lib/auth/accounts";
import { ensureTwUniverseWarm, findInUniverse } from "@/lib/data/universe";
import { INDICATOR_TYPE_MAP, normalizeParams } from "./indicatorCatalog";
import { normalizeStrategyConfig, type SimPosition, type StrategyConfig, type UserIndicator } from "./engine";

/**
 * 參考指標、策略庫、模擬倉的儲存（Google 試算表 Indicators／Strategies／Sims／SimTrades／SimNav，
 * 本機沒設試算表時是 .cache 檔）。每一列都帶 UserId，所有讀寫都只碰自己帳號的資料。
 */

export class StrategyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Owner {
  userId: string;
  account: string;
}

const newId = (prefix: string) => prefix + randomUUID().replace(/-/g, "").slice(0, 14);
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
function parseJson<T>(s: string | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

type MyTable = "Indicators" | "Strategies" | "Sims";

/** 一次請求讀好幾張表（試算表每次呼叫 2～5 秒，分開讀會慢好幾倍），只留自己帳號的列 */
async function readMineMany(userId: string, ...tables: MyTable[]): Promise<Row[][]> {
  const results = (await getStore().batch(tables.map((table) => ({ op: "read" as const, table })))) as Row[][];
  return results.map((rows) => rows.filter((r) => r.UserId === userId));
}

/** 預先一次讀好策略與指標（runner 接著呼叫 listStrategies／listIndicators 會直接用暫存） */
export async function prefetchStrategyTables(userId: string): Promise<void> {
  await readMineMany(userId, "Strategies", "Indicators");
}

async function readMine(table: MyTable, userId: string): Promise<Row[]> {
  const [rows] = (await getStore().batch([{ op: "read", table }])) as Row[][];
  return rows.filter((r) => r.UserId === userId);
}

const MAX_PER_USER = { Indicators: 100, Strategies: 50, Sims: 20 } as const;

// ============================================================
// 參考指標
// ============================================================

export interface IndicatorView extends UserIndicator {
  summary: string;
  note: string;
  updatedAt: string;
}

function toIndicator(r: Row): IndicatorView | null {
  if (!INDICATOR_TYPE_MAP.has(r.TypeId)) return null;
  const params = normalizeParams(r.TypeId, parseJson(r.Params, {}));
  return {
    id: r.ID,
    name: r.Name ?? "",
    typeId: r.TypeId,
    params,
    summary: INDICATOR_TYPE_MAP.get(r.TypeId)!.describe(params),
    note: r.Note ?? "",
    updatedAt: r.UpdatedAt ?? "",
  };
}

export async function listIndicators(userId: string): Promise<IndicatorView[]> {
  return (await readMine("Indicators", userId)).map(toIndicator).filter((x): x is IndicatorView => x !== null);
}

export async function saveIndicator(
  owner: Owner,
  input: { id?: string; name?: unknown; typeId?: unknown; params?: unknown; note?: unknown },
): Promise<IndicatorView> {
  const typeId = String(input.typeId ?? "");
  const type = INDICATOR_TYPE_MAP.get(typeId);
  if (!type) throw new StrategyError("請選擇指標類型");
  const params = normalizeParams(typeId, (input.params as Record<string, unknown>) ?? {});
  const name = text(input.name, 40) || type.describe(params);
  const note = text(input.note, 200);
  const now = taipeiNow();
  const mine = await readMine("Indicators", owner.userId);
  const row: Row = {
    Account: owner.account, Name: name, TypeId: typeId, Summary: type.describe(params), Params: JSON.stringify(params),
    Note: note, UpdatedAt: now, UserId: owner.userId,
  };
  if (input.id) {
    if (!mine.some((r) => r.ID === input.id)) throw new StrategyError("找不到這個參考指標", 404);
    await getStore().batch([{ op: "update", table: "Indicators", key: input.id, patch: row }]);
    return toIndicator({ ID: input.id, ...row })!;
  }
  if (mine.length >= MAX_PER_USER.Indicators) throw new StrategyError(`參考指標最多 ${MAX_PER_USER.Indicators} 個`);
  const id = newId("IN");
  await getStore().batch([{ op: "append", table: "Indicators", row: { ID: id, ...row, CreatedAt: now } }]);
  return toIndicator({ ID: id, ...row })!;
}

export async function deleteIndicator(owner: Owner, id: string): Promise<void> {
  await prefetchStrategyTables(owner.userId);
  const [inds, strategies] = await Promise.all([readMine("Indicators", owner.userId), listStrategies(owner.userId)]);
  if (!inds.some((r) => r.ID === id)) throw new StrategyError("找不到這個參考指標", 404);
  const usedBy = strategies.filter((s) => strategyIndicatorIds(s.config).includes(id)).map((s) => s.name);
  if (usedBy.length) throw new StrategyError(`這個參考指標還在策略「${usedBy.join("、")}」裡使用，請先從策略移除`, 409);
  await getStore().batch([{ op: "delete", table: "Indicators", key: id }]);
}

// ============================================================
// 策略庫
// ============================================================

export interface StrategyView {
  id: string;
  name: string;
  config: StrategyConfig;
  summary: string;
  note: string;
  updatedAt: string;
}

export function strategyIndicatorIds(cfg: StrategyConfig): string[] {
  return cfg.mode === "score" ? Object.keys(cfg.weights) : [...new Set([...cfg.buy.ids, ...cfg.sell.ids])];
}

function strategySummary(cfg: StrategyConfig): string {
  const risk = [
    cfg.stopLossPct ? `停損 ${cfg.stopLossPct}%` : "",
    cfg.takeProfitPct ? `停利 ${cfg.takeProfitPct}%` : "",
    cfg.maxHoldDays ? `最長持有 ${cfg.maxHoldDays} 天` : "",
    `每檔 ${cfg.positionPct}% 資金、最多 ${cfg.maxPositions} 檔`,
  ].filter(Boolean);
  const head =
    cfg.mode === "score"
      ? `加權計分（${Object.keys(cfg.weights).length} 個指標，≥${cfg.buyScore} 買、≤${cfg.sellScore} 賣）`
      : `條件式（買進 ${cfg.buy.ids.length} 個${cfg.buy.match ? `中 ${cfg.buy.match} 個` : "全部"}符合；賣出 ${cfg.sell.ids.length} 個）`;
  return `${head}；${risk.join("、")}`;
}

function toStrategy(r: Row, validIds: Set<string>): StrategyView {
  const config = normalizeStrategyConfig(parseJson(r.Config, {}), validIds);
  return { id: r.ID, name: r.Name ?? "", config, summary: strategySummary(config), note: r.Note ?? "", updatedAt: r.UpdatedAt ?? "" };
}

export async function listStrategies(userId: string): Promise<StrategyView[]> {
  const [rows, inds] = await readMineMany(userId, "Strategies", "Indicators");
  const valid = new Set(inds.map((r) => r.ID));
  return rows.map((r) => toStrategy(r, valid));
}

export async function saveStrategy(owner: Owner, input: { id?: string; name?: unknown; config?: unknown; note?: unknown }): Promise<StrategyView> {
  const [mine, inds] = await readMineMany(owner.userId, "Strategies", "Indicators");
  const config = normalizeStrategyConfig(input.config, new Set(inds.map((r) => r.ID)));
  const name = text(input.name, 40);
  if (!name) throw new StrategyError("請填寫策略名稱");
  if (strategyIndicatorIds(config).length === 0) throw new StrategyError("策略至少要用到一個參考指標");
  if (config.mode === "rules" && config.buy.ids.length === 0) throw new StrategyError("條件式策略至少要有一個買進條件");
  const now = taipeiNow();
  const row: Row = {
    Account: owner.account, Name: name, Mode: config.mode, Summary: strategySummary(config), Config: JSON.stringify(config),
    Note: text(input.note, 200), UpdatedAt: now, UserId: owner.userId,
  };
  if (input.id) {
    if (!mine.some((r) => r.ID === input.id)) throw new StrategyError("找不到這個策略", 404);
    await getStore().batch([{ op: "update", table: "Strategies", key: input.id, patch: row }]);
    return { id: input.id, name, config, summary: row.Summary, note: row.Note, updatedAt: now };
  }
  if (mine.length >= MAX_PER_USER.Strategies) throw new StrategyError(`策略最多 ${MAX_PER_USER.Strategies} 個`);
  const id = newId("ST");
  await getStore().batch([{ op: "append", table: "Strategies", row: { ID: id, ...row, CreatedAt: now } }]);
  return { id, name, config, summary: row.Summary, note: row.Note, updatedAt: now };
}

export async function deleteStrategy(owner: Owner, id: string): Promise<void> {
  const [mine, sims] = await readMineMany(owner.userId, "Strategies", "Sims");
  if (!mine.some((r) => r.ID === id)) throw new StrategyError("找不到這個策略", 404);
  const usedBy = sims.filter((s) => s.StrategyId === id).map((s) => s.Name);
  if (usedBy.length) throw new StrategyError(`這個策略還在模擬倉「${usedBy.join("、")}」使用，請先換掉或刪除模擬倉`, 409);
  await getStore().batch([{ op: "delete", table: "Strategies", key: id }]);
}

// ============================================================
// 模擬倉
// ============================================================

export interface SimView {
  id: string;
  userId: string;
  account: string;
  name: string;
  strategyId: string;
  universe: "list" | "market";
  symbols: Array<{ symbol: string; market: "TW" | "US"; name: string }>;
  marketTopN: number;
  initialCash: number;
  cash: number;
  equity: number;
  returnPct: number;
  autoTrade: boolean;
  lastRunDay: string;
  lastRunNote: string;
  positions: SimPosition[];
  createdAt: string;
}

export const MAX_LIST_SYMBOLS = 100;
export const MAX_MARKET_TOP_N = 100;

export function toSim(r: Row): SimView {
  const initialCash = Number(r.InitialCash) || 0;
  const cash = Number(r.Cash);
  return {
    id: r.ID,
    userId: r.UserId,
    account: r.Account ?? "",
    name: r.Name ?? "",
    strategyId: r.StrategyId ?? "",
    universe: r.Universe === "market" ? "market" : "list",
    symbols: parseJson(r.Symbols, []),
    marketTopN: Number(r.MarketTopN) || 30,
    initialCash,
    cash: Number.isFinite(cash) ? cash : initialCash,
    equity: Number(r.Equity) || initialCash,
    returnPct: Number(r.ReturnPct) || 0,
    autoTrade: String(r.AutoTrade).toUpperCase() !== "FALSE",
    lastRunDay: r.LastRunDay ?? "",
    lastRunNote: r.LastRunNote ?? "",
    positions: parseJson(r.Positions, []),
    createdAt: r.CreatedAt ?? "",
  };
}

export async function listSims(userId: string): Promise<SimView[]> {
  return (await readMine("Sims", userId)).map(toSim);
}

/** 排程用：所有帳號開著自動交易的模擬倉 */
export async function listAllAutoSims(): Promise<SimView[]> {
  const [rows] = (await getStore().batch([{ op: "read", table: "Sims" }])) as Row[][];
  return rows.map(toSim).filter((s) => s.autoTrade);
}

export async function getSim(userId: string, id: string): Promise<SimView> {
  const s = (await listSims(userId)).find((x) => x.id === id);
  if (!s) throw new StrategyError("找不到這個模擬倉", 404);
  return s;
}

function cleanSymbols(v: unknown): SimView["symbols"] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: SimView["symbols"] = [];
  for (const x of v) {
    const o = (x ?? {}) as Record<string, unknown>;
    const symbol = text(o.symbol, 12).toUpperCase();
    const market = o.market === "US" ? "US" : "TW";
    if (!/^[A-Z0-9.]{1,12}$/.test(symbol) || seen.has(`${market}:${symbol}`)) continue;
    seen.add(`${market}:${symbol}`);
    out.push({ symbol, market, name: text(o.name, 40) || symbol });
    if (out.length >= MAX_LIST_SYMBOLS) break;
  }
  return out;
}

/** 使用者只打代號也行：台股從股票清單補上名稱（補不到就維持代號） */
async function withNames(list: SimView["symbols"]): Promise<SimView["symbols"]> {
  if (!list.some((x) => x.market === "TW" && x.name === x.symbol)) return list;
  // 股票清單冷啟動可能要十幾秒：最多等 3 秒，查不到就先用代號（不影響交易，只是顯示名稱）
  await Promise.race([ensureTwUniverseWarm().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  return list.map((x) => (x.market === "TW" && x.name === x.symbol ? { ...x, name: findInUniverse(x.symbol, "TW")?.name ?? x.symbol } : x));
}

export async function saveSim(
  owner: Owner,
  input: { id?: string; name?: unknown; strategyId?: unknown; universe?: unknown; symbols?: unknown; marketTopN?: unknown; initialCash?: unknown; autoTrade?: unknown },
): Promise<SimView> {
  const [mine, strategies] = await readMineMany(owner.userId, "Sims", "Strategies");
  const name = text(input.name, 40);
  if (!name) throw new StrategyError("請填寫模擬倉名稱");
  const strategyId = String(input.strategyId ?? "");
  if (strategyId && !strategies.some((s) => s.ID === strategyId)) throw new StrategyError("找不到選擇的策略");
  const universe = input.universe === "market" ? "market" : "list";
  const symbols = await withNames(cleanSymbols(input.symbols));
  const topN = Math.round(Math.min(MAX_MARKET_TOP_N, Math.max(10, Number(input.marketTopN) || 30)));
  const autoTrade = input.autoTrade !== false && input.autoTrade !== "false";
  if (autoTrade && !strategyId) throw new StrategyError("開啟自動交易要先選擇策略");
  if (autoTrade && universe === "list" && symbols.length === 0) throw new StrategyError("自選清單模式至少要有一檔股票");
  const now = taipeiNow();
  const patch: Row = {
    Account: owner.account, Name: name, StrategyId: strategyId, Universe: universe, Symbols: JSON.stringify(symbols),
    MarketTopN: String(topN), AutoTrade: autoTrade ? "TRUE" : "FALSE", UpdatedAt: now, UserId: owner.userId,
  };
  if (input.id) {
    const old = mine.find((r) => r.ID === input.id);
    if (!old) throw new StrategyError("找不到這個模擬倉", 404);
    await getStore().batch([{ op: "update", table: "Sims", key: input.id, patch }]);
    return toSim({ ...old, ...patch });
  }
  if (mine.length >= MAX_PER_USER.Sims) throw new StrategyError(`模擬倉最多 ${MAX_PER_USER.Sims} 個`);
  const initialCash = Math.round(Number(input.initialCash) || 0);
  if (initialCash < 10_000 || initialCash > 1_000_000_000) throw new StrategyError("初始資金要在 1 萬～10 億之間");
  const row: Row = {
    ID: newId("SM"), ...patch, InitialCash: String(initialCash), Cash: String(initialCash), Equity: String(initialCash),
    ReturnPct: "0", LastRunDay: "", LastRunNote: "", Positions: "[]", CreatedAt: now,
  };
  await getStore().batch([{ op: "append", table: "Sims", row }]);
  return toSim(row);
}

export async function deleteSim(owner: Owner, id: string): Promise<void> {
  await getSim(owner.userId, id);
  // 交易紀錄與淨值一併刪除（整份換成空的）
  await getStore().batch([
    { op: "delete", table: "Sims", key: id },
    { op: "replaceWhere", table: "SimTrades", col: "SimId", value: id, rows: [] },
    { op: "replaceWhere", table: "SimNav", col: "SimId", value: id, rows: [] },
  ]);
}

export interface SimTradeView {
  id: string;
  day: string;
  at: string;
  side: "buy" | "sell";
  market: "TW" | "US";
  symbol: string;
  name: string;
  shares: number;
  price: number;
  fee: number;
  pnl: number | null;
  source: "auto" | "manual";
  reason: string;
}

export async function listSimHistory(userId: string, simId: string): Promise<{ trades: SimTradeView[]; nav: Array<{ day: string; equity: number; cash: number; indexClose: number | null }> }> {
  const [trades, nav] = (await getStore().batch([
    { op: "read", table: "SimTrades" },
    { op: "read", table: "SimNav" },
  ])) as Row[][];
  return {
    trades: trades
      .filter((r) => r.SimId === simId && r.UserId === userId)
      .map((r) => ({
        id: r.ID, day: r.Day, at: r.At, side: r.Side === "sell" ? "sell" as const : "buy" as const, market: r.Market === "US" ? "US" as const : "TW" as const,
        symbol: r.Symbol, name: r.Name, shares: Number(r.Shares), price: Number(r.Price), fee: Number(r.Fee),
        pnl: r.Pnl === "" || r.Pnl == null ? null : Number(r.Pnl), source: r.Source === "manual" ? "manual" as const : "auto" as const, reason: r.Reason ?? "",
      }))
      .reverse(),
    nav: nav
      .filter((r) => r.SimId === simId && r.UserId === userId)
      .map((r) => ({ day: r.Day, equity: Number(r.Equity), cash: Number(r.Cash), indexClose: r.IndexClose ? Number(r.IndexClose) : null }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** 交易後寫回：模擬倉狀態＋新增交易紀錄＋當天淨值（同一天重跑會覆蓋那天的淨值）。 */
export async function persistSimResult(
  sim: SimView,
  next: { cash: number; positions: SimPosition[]; equity: number },
  trades: Array<Omit<SimTradeView, "id" | "at">>,
  opts: { day: string; runNote?: string; markRun?: boolean; indexClose?: number | null },
): Promise<void> {
  const now = taipeiNow();
  const returnPct = sim.initialCash ? ((next.equity / sim.initialCash - 1) * 100).toFixed(2) : "0";
  const patch: Row = {
    Cash: String(Math.round(next.cash * 100) / 100), Positions: JSON.stringify(next.positions), Equity: String(Math.round(next.equity)),
    ReturnPct: returnPct, UpdatedAt: now,
  };
  if (opts.markRun) {
    patch.LastRunDay = opts.day;
    patch.LastRunNote = opts.runNote ?? "";
  }
  await getStore().batch([
    { op: "update", table: "Sims", key: sim.id, patch },
    ...trades.map((t) => ({
      op: "append" as const,
      table: "SimTrades" as const,
      row: {
        ID: newId("TR"), SimId: sim.id, Account: sim.account, Day: t.day, At: now, Side: t.side, Market: t.market, Symbol: t.symbol, Name: t.name,
        Shares: String(t.shares), Price: String(t.price), Fee: String(t.fee), Pnl: t.pnl == null ? "" : String(t.pnl), Source: t.source,
        Reason: t.reason.slice(0, 300), UserId: sim.userId,
      },
    })),
    ...(opts.markRun
      ? [
          { op: "delete" as const, table: "SimNav" as const, key: `${sim.id}:${opts.day}` },
          {
            op: "append" as const,
            table: "SimNav" as const,
            row: {
              ID: `${sim.id}:${opts.day}`, SimId: sim.id, Day: opts.day, Equity: String(Math.round(next.equity)),
              Cash: String(Math.round(next.cash)), IndexClose: opts.indexClose == null ? "" : String(opts.indexClose), UserId: sim.userId,
            },
          },
        ]
      : []),
  ]);
}

// ============================================================
// 即時提醒設定（每個帳號一列，ID＝UserId）
// ============================================================

export const ALERT_LIMITS = { maxSymbols: 20, maxStrategies: 8, intervals: [10, 15, 20, 30] as const };

export interface AlertConfig {
  symbols: string[];
  strategyIds: string[];
  intervalSec: number;
  enabled: boolean;
}

const DEFAULT_ALERT: AlertConfig = { symbols: [], strategyIds: ["ai"], intervalSec: 30, enabled: false };

export async function getAlertConfig(userId: string): Promise<AlertConfig> {
  const [rows] = (await getStore().batch([{ op: "read", table: "Alerts" }])) as Row[][];
  const r = rows.find((x) => x.ID === userId);
  if (!r) return { ...DEFAULT_ALERT };
  return {
    symbols: parseJson<string[]>(r.Symbols, []),
    strategyIds: parseJson<string[]>(r.StrategyIds, ["ai"]),
    intervalSec: (ALERT_LIMITS.intervals as readonly number[]).includes(Number(r.IntervalSec)) ? Number(r.IntervalSec) : 30,
    enabled: String(r.Enabled).toUpperCase() === "TRUE",
  };
}

export async function saveAlertConfig(owner: Owner, input: Partial<AlertConfig>): Promise<AlertConfig> {
  const symbols = [...new Set((Array.isArray(input.symbols) ? input.symbols : []).map((s) => text(s, 12).toUpperCase()).filter((s) => /^[A-Z0-9.]{1,12}$/.test(s)))].slice(0, ALERT_LIMITS.maxSymbols);
  const strategyIds = [...new Set((Array.isArray(input.strategyIds) ? input.strategyIds : []).map((s) => text(s, 40)).filter(Boolean))].slice(0, ALERT_LIMITS.maxStrategies);
  const intervalSec = (ALERT_LIMITS.intervals as readonly number[]).includes(Number(input.intervalSec)) ? Number(input.intervalSec) : 30;
  const cfg: AlertConfig = { symbols, strategyIds, intervalSec, enabled: input.enabled === true };
  if (cfg.enabled && (symbols.length === 0 || strategyIds.length === 0)) throw new StrategyError("開啟提醒前，請至少設定一檔股票和一個策略");
  await getStore().batch([
    {
      op: "upsert",
      table: "Alerts",
      rows: [
        {
          ID: owner.userId, Account: owner.account, Symbols: JSON.stringify(symbols), StrategyIds: JSON.stringify(strategyIds),
          IntervalSec: String(intervalSec), Enabled: cfg.enabled ? "TRUE" : "FALSE", UpdatedAt: taipeiNow(),
        },
      ],
    },
  ]);
  return cfg;
}

