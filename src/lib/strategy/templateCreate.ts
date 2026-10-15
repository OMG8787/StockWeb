import { normalizeParams } from "./indicatorCatalog";
import { listIndicators, listStrategies, prefetchStrategyTables, saveIndicator, saveStrategy, StrategyError, type Owner } from "./store";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./engine";
import { TEMPLATE_MAP } from "./templates";

/**
 * 依範本在使用者帳號裡建立策略（範本資料見 templates.ts）：
 *  - 需要的參考指標：帳號裡已經有「同類型、同參數」的就直接用，沒有才新建（不會越建越多重複的）；
 *  - 策略名稱跟現有的重複時加上（2）（3）…。
 */
export async function createFromTemplate(owner: Owner, templateId: string): Promise<{ strategyId: string; name: string; createdIndicators: number }> {
  const t = TEMPLATE_MAP.get(templateId);
  if (!t) throw new StrategyError("找不到這個範本", 404);
  await prefetchStrategyTables(owner.userId);
  const [existing, strategies] = await Promise.all([listIndicators(owner.userId), listStrategies(owner.userId)]);
  const sig = (typeId: string, params: Record<string, unknown>) => `${typeId}|${JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
  const bySig = new Map(existing.map((i) => [sig(i.typeId, i.params), i.id]));
  const idOf = new Map<string, string>();
  let created = 0;
  for (const ind of t.indicators) {
    const params = normalizeParams(ind.typeId, ind.params);
    const s = sig(ind.typeId, params);
    let id = bySig.get(s);
    if (!id) {
      id = (await saveIndicator(owner, { typeId: ind.typeId, params, note: `由策略範本「${t.name}」建立` })).id;
      bySig.set(s, id);
      created++;
    }
    idOf.set(ind.key, id);
  }
  const names = new Set(strategies.map((s) => s.name));
  let name = t.name;
  for (let n = 2; names.has(name); n++) name = `${t.name}（${n}）`;
  const config: StrategyConfig = {
    ...DEFAULT_STRATEGY_CONFIG,
    mode: t.mode,
    buy: { ids: t.buy.keys.map((k) => idOf.get(k)!), match: t.buy.match },
    sell: { ids: t.sell.keys.map((k) => idOf.get(k)!), match: t.sell.match },
    stopLossPct: t.stopLossPct,
    takeProfitPct: t.takeProfitPct,
    maxHoldDays: t.maxHoldDays,
    positionPct: t.positionPct,
    maxPositions: t.maxPositions,
  };
  const st = await saveStrategy(owner, { name, config, note: `${t.style}範本：${t.desc}`.slice(0, 200) });
  return { strategyId: st.id, name: st.name, createdIndicators: created };
}
