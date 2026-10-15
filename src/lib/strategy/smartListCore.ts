import type { IndicatorHit, StrategyConfig } from "./engine";

/**
 * 「我的智能清單」的純邏輯（不碰資料庫；有測試 src/__tests__/smartList.test.ts）。
 *
 * 2026-10-15 使用者：「我的智能清單是依照策略選股，此區是找全市場符合的條件，一天更新 2 次（自訂時間），可以一直增加名單，
 * 但是如果不符合策略條件也先不刪除，但是需要備註指標不在策略中，然後一周內都沒有排回名單中就刪除這檔標的，
 * 這麼鬆散的原因是可以擴大可能的名單資料，然後再用提醒通知來做篩選真正需要的提醒。」
 *
 * 規則：
 *  - 每次更新掃描「全市場成交值前 SMART_UNIVERSE 名＋清單裡已有的股票」，任何一個選定策略的買進條件成立＝符合 → 加入（已在清單就刷新）。
 *  - 清單裡的股票這次不符合：先保留，標示「暫不符合」並寫出哪些條件不成立。
 *  - 最後一次符合超過 SMART_KEEP_DAYS 天、這次也沒符合 → 移除。
 *  - 這次沒檢查到（資料抓不到、時間不夠）→ 維持原狀，不當成不符合。
 */

export const SMART_KEEP_DAYS = 7;
/** 每次掃描成交值前幾名（加上清單裡已有的股票） */
export const SMART_UNIVERSE = 300;
export const SMART_MAX_STRATEGIES = 3;
/** 清單上限（避免無限長；超過時先移除最久沒符合的） */
export const SMART_MAX_ENTRIES = 300;
export const SMART_DEFAULT_TIMES = ["10:00", "13:40"] as const;
/** 錯過排定時間多久之內還補跑（例如那段時間排程沒觸發） */
export const SMART_CATCHUP_MINUTES = 120;
const RUNS_KEEP = 30;

export interface SmartListConfig {
  enabled: boolean;
  /** 用哪些策略選股（任一個符合就算） */
  strategyIds: string[];
  /** 一天更新的時間（台北 HH:MM，兩個） */
  times: string[];
}

export const DEFAULT_SMART_CONFIG: SmartListConfig = { enabled: false, strategyIds: [], times: [...SMART_DEFAULT_TIMES] };

export interface SmartEntry {
  symbol: string;
  name: string;
  /** 第一次加入（ISO）與當時價格 */
  addedAt: string;
  addedPrice: number | null;
  /** 最近一次符合（ISO）；超過 SMART_KEEP_DAYS 天沒再符合就移除 */
  lastQualifiedAt: string;
  /** 最近一次檢查（ISO） */
  lastCheckedAt: string;
  /** 最近一次檢查是否符合 */
  qualified: boolean;
  /** 最近一次符合時，是哪些策略 */
  strategies: string[];
  /** 最近一次檢查不符合時，哪些條件不成立（「策略名：條件」） */
  failing: string[];
  lastPrice: number | null;
}

export interface SmartRunLog {
  at: string;
  /** 排定時間（HH:MM）或 manual */
  slot: string;
  /** `${台北日期}|${slot}`（排程避免同一時點重跑） */
  slotKey: string;
  scanned: number;
  qualified: number;
  added: number;
  removed: number;
  note: string;
}

export interface SmartListData {
  entries: SmartEntry[];
  runs: SmartRunLog[];
}

export const EMPTY_SMART_DATA: SmartListData = { entries: [], runs: [] };

/** 一檔股票這次的檢查結果 */
export interface SmartEval {
  symbol: string;
  name: string;
  price: number | null;
  /** 這次符合的策略名稱（空＝都不符合） */
  passed: string[];
  /** 不符合時哪些條件不成立 */
  failing: string[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSmartConfig(raw: unknown, validStrategyIds?: Set<string>): SmartListConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SmartListConfig>;
  const ids = [...new Set((Array.isArray(r.strategyIds) ? r.strategyIds : []).map(String).filter((id) => !validStrategyIds || validStrategyIds.has(id)))].slice(
    0,
    SMART_MAX_STRATEGIES,
  );
  const times = [...new Set((Array.isArray(r.times) ? r.times : []).map(String).filter((t) => HHMM.test(t)))].sort().slice(0, 2);
  return { enabled: r.enabled === true, strategyIds: ids, times: times.length ? times : [...SMART_DEFAULT_TIMES] };
}

/** 條件式：買進條件裡沒成立的；計分式：正權重沒成立的＋總分差多少 */
export function failingConditions(cfg: StrategyConfig, hits: IndicatorHit[], score: number): string[] {
  const byId = new Map(hits.map((h) => [h.id, h]));
  const label = (h: IndicatorHit) => (h.pass === null ? `${h.name}（資料不足）` : h.name);
  if (cfg.mode === "score") {
    const miss = Object.entries(cfg.weights)
      .filter(([id, w]) => w > 0 && byId.get(id)?.pass !== true)
      .map(([id]) => byId.get(id))
      .filter((h): h is IndicatorHit => !!h)
      .map(label);
    return [`總分 ${Math.round(score * 100) / 100} 未達 ${cfg.buyScore}`, ...miss];
  }
  return cfg.buy.ids
    .map((id) => byId.get(id))
    .filter((h): h is IndicatorHit => !!h && h.pass !== true)
    .map(label);
}

/**
 * 條件式／計分式：只看「便宜」的條件（日K、籌碼、基本面）時，這檔還有沒有可能符合（評等、五檔這種貴的條件當作還不知道）。
 * 不可能就不用再抓評等，省下大部分成本。
 */
export function canStillPass(cfg: StrategyConfig, hits: IndicatorHit[], unknownIds: Set<string>): boolean {
  const byId = new Map(hits.map((h) => [h.id, h]));
  if (cfg.mode === "score") {
    let best = 0;
    for (const [id, w] of Object.entries(cfg.weights)) {
      if (unknownIds.has(id)) best += Math.max(0, w);
      else if (byId.get(id)?.pass === true) best += w;
    }
    return best >= cfg.buyScore;
  }
  if (cfg.buy.ids.length === 0) return false;
  const known = cfg.buy.ids.filter((id) => !unknownIds.has(id) && byId.get(id)?.pass === true).length;
  const unknown = cfg.buy.ids.filter((id) => unknownIds.has(id)).length;
  const need = cfg.buy.match <= 0 ? cfg.buy.ids.length : Math.min(cfg.buy.match, cfg.buy.ids.length);
  return known + unknown >= need;
}

const DAY_MS = 86_400_000;

/** 合併這次的檢查結果：加入新符合的、更新已有的、標示暫不符合、移除超過期限的。 */
export function mergeSmartRun(
  prev: SmartListData,
  evals: SmartEval[],
  run: { now: Date; slot: string; slotKey: string; note?: string },
): { data: SmartListData; added: number; removed: number } {
  const at = run.now.toISOString();
  const bySymbol = new Map(prev.entries.map((e) => [e.symbol.toUpperCase(), { ...e }]));
  let added = 0;
  for (const ev of evals) {
    const k = ev.symbol.toUpperCase();
    const cur = bySymbol.get(k);
    if (ev.passed.length > 0) {
      if (cur) {
        Object.assign(cur, { qualified: true, lastQualifiedAt: at, lastCheckedAt: at, strategies: ev.passed, failing: [], lastPrice: ev.price ?? cur.lastPrice, name: ev.name || cur.name });
      } else {
        bySymbol.set(k, {
          symbol: k,
          name: ev.name,
          addedAt: at,
          addedPrice: ev.price,
          lastQualifiedAt: at,
          lastCheckedAt: at,
          qualified: true,
          strategies: ev.passed,
          failing: [],
          lastPrice: ev.price,
        });
        added++;
      }
    } else if (cur) {
      Object.assign(cur, { qualified: false, lastCheckedAt: at, failing: ev.failing, lastPrice: ev.price ?? cur.lastPrice });
    }
  }
  let entries = [...bySymbol.values()];
  const before = entries.length;
  entries = entries.filter((e) => e.qualified || run.now.getTime() - Date.parse(e.lastQualifiedAt) <= SMART_KEEP_DAYS * DAY_MS);
  entries.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.lastQualifiedAt.localeCompare(a.lastQualifiedAt) || a.symbol.localeCompare(b.symbol));
  entries = entries.slice(0, SMART_MAX_ENTRIES);
  const removed = before - entries.length;
  const log: SmartRunLog = {
    at,
    slot: run.slot,
    slotKey: run.slotKey,
    scanned: evals.length,
    qualified: entries.filter((e) => e.qualified).length,
    added,
    removed,
    note: run.note ?? "",
  };
  return { data: { entries, runs: [log, ...prev.runs].slice(0, RUNS_KEEP) }, added, removed };
}

/** 現在該跑哪一個排定時間（週一～五；排定時間已過、還在補跑期限內、今天這個時間還沒跑過）。沒有就 null。 */
export function dueSmartSlot(times: string[], now: Date, doneSlotKeys: Set<string>): { slot: string; slotKey: string } | null {
  const tpe = new Date(now.getTime() + 8 * 3_600_000);
  const wd = tpe.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  const day = tpe.toISOString().slice(0, 10);
  const minutes = tpe.getUTCHours() * 60 + tpe.getUTCMinutes();
  for (const t of [...times].sort()) {
    const [h, m] = t.split(":").map(Number);
    const start = h * 60 + m;
    const key = `${day}|${t}`;
    if (minutes >= start && minutes - start <= SMART_CATCHUP_MINUTES && !doneSlotKeys.has(key)) return { slot: t, slotKey: key };
  }
  return null;
}

/** 距離移除還剩幾天（符合中＝null） */
export function daysUntilRemoval(e: SmartEntry, now: Date = new Date()): number | null {
  if (e.qualified) return null;
  return Math.max(0, Math.ceil((Date.parse(e.lastQualifiedAt) + SMART_KEEP_DAYS * DAY_MS - now.getTime()) / DAY_MS));
}
