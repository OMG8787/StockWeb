"use client";

import { useEffect, useMemo, useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import { api, useList, type Indicator, type IndicatorTypeInfo } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";

type Draft = { id?: string; typeId: string; name: string; note: string; params: Record<string, number | string> };

function defaults(t: IndicatorTypeInfo): Record<string, number | string> {
  return Object.fromEntries(t.params.map((p) => [p.key, p.default]));
}

export default function IndicatorsClient() {
  const [types, setTypes] = useState<IndicatorTypeInfo[]>([]);
  const { items, error, reload } = useList<Indicator>("/api/strategy/indicators");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api<{ types: IndicatorTypeInfo[] }>("/api/strategy/catalog")
      .then((d) => setTypes(d.types))
      .catch((e: Error) => setMsg(e.message));
  }, []);

  const typeMap = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const groups = useMemo(() => [...new Set(types.map((t) => t.group))], [types]);

  function startNew(t: IndicatorTypeInfo) {
    setDraft({ typeId: t.id, name: "", note: "", params: defaults(t) });
    setMsg("");
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMsg("");
    try {
      await api("/api/strategy/indicators", { body: draft });
      setDraft(null);
      await reload();
      setMsg("已儲存");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(ind: Indicator) {
    if (!confirm(`確定刪除參考指標「${ind.name}」？`)) return;
    setBusy(true);
    try {
      await api(`/api/strategy/indicators?id=${encodeURIComponent(ind.id)}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const draftType = draft ? typeMap.get(draft.typeId) : undefined;

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/indicators" intro="參考指標是策略的判斷依據：從系統清單挑一種、設定參數，存成自己的指標，再到「策略庫」組合使用。" />
      {(error || msg) && <p className={`text-sm ${error || (msg && msg !== "已儲存") ? "text-(--price-up)" : "text-(--price-down)"}`}>{error || msg}</p>}

      {draft && draftType ? (
        <section className={`${cardCls} space-y-3`}>
          <div>
            <h2 className="font-semibold">{draft.id ? "編輯" : "新增"}參考指標：{draftType.label}</h2>
            <p className="mt-1 text-sm text-(--text-muted)">{draftType.description}</p>
            {draftType.twOnly && <p className="mt-1 text-xs text-(--text-muted)">※ 只適用台股，美股會略過這個條件。</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {draftType.params.map((p) => (
              <label key={p.key} className="block space-y-1 text-sm">
                <span>
                  {p.label}
                  {p.type === "number" && p.unit ? `（${p.unit}）` : ""}
                </span>
                {p.type === "select" ? (
                  <select
                    value={String(draft.params[p.key])}
                    onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: e.target.value } })}
                    className={inputCls}
                  >
                    {p.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    min={p.min}
                    max={p.max}
                    step={p.step ?? 1}
                    value={draft.params[p.key]}
                    onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: Number(e.target.value) } })}
                    className={inputCls}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <input placeholder="名稱（可留空，自動用條件當名稱）" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} />
            <input placeholder="備註（選填）" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
              {busy ? "儲存中…" : "儲存"}
            </button>
            <button type="button" className={btnGhost} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </section>
      ) : (
        <section className={`${cardCls} space-y-3`}>
          <h2 className="font-semibold">＋ 新增參考指標（選一種類型）</h2>
          {types.length === 0 && <p className="text-sm text-(--text-muted)">載入中…</p>}
          {groups.map((g) => (
            <div key={g} className="space-y-1">
              <div className="text-xs font-medium text-(--text-muted)">{g}</div>
              <div className="flex flex-wrap gap-2">
                {types
                  .filter((t) => t.group === g)
                  .map((t) => (
                    <button key={t.id} type="button" className={`${btnGhost} text-xs`} title={t.description} onClick={() => startNew(t)}>
                      {t.label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">我的參考指標{items ? `（${items.length}）` : ""}</h2>
        {items === null && !error && <p className="text-sm text-(--text-muted)">載入中…</p>}
        {items?.length === 0 && <p className="text-sm text-(--text-muted)">還沒有參考指標，從上面選一種類型開始。</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {items?.map((ind) => (
            <div key={ind.id} className={`${cardCls} !p-4 text-sm`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{ind.name}</div>
                  <div className="text-xs text-(--text-muted)">
                    {typeMap.get(ind.typeId)?.label ?? ind.typeId}・{ind.summary}
                  </div>
                  {ind.note && <div className="mt-1 text-xs text-(--text-secondary)">{ind.note}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className={`${btnGhost} text-xs`} onClick={() => setDraft({ id: ind.id, typeId: ind.typeId, name: ind.name, note: ind.note, params: ind.params })}>
                    編輯
                  </button>
                  <button type="button" className={`${btnGhost} text-xs`} disabled={busy} onClick={() => remove(ind)}>
                    刪除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
