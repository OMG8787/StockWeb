"use client";

import Link from "next/link";
import { useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import { api, useList, type Indicator, type Strategy, type StrategyConfig } from "@/components/strategy/api";
import SourcePicker from "@/components/strategy/SourcePicker";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";

const EMPTY: StrategyConfig = {
  mode: "rules",
  buy: { ids: [], match: 0 },
  sell: { ids: [], match: 1 },
  weights: {},
  buyScore: 3,
  sellScore: -1,
  stopLossPct: 8,
  takeProfitPct: 20,
  maxHoldDays: 0,
  positionPct: 20,
  maxPositions: 5,
  screens: [],
  screenMode: "union",
};

type Draft = { id?: string; name: string; note: string; config: StrategyConfig };

interface Preview {
  symbol: string;
  name: string;
  lastDay: string;
  decision: { buy: boolean; sell: boolean; score: number; summary: string; hits: Array<{ id: string; name: string; pass: boolean | null; detail: string }> };
}

const numCls = `${inputCls} !w-24`;

function NumField({ label, value, onChange, step = 1, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; hint?: string }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={numCls} />
      {hint && <span className="block text-xs text-(--text-muted)">{hint}</span>}
    </label>
  );
}

function ConditionPicker({
  title,
  indicators,
  set,
  onChange,
}: {
  title: string;
  indicators: Indicator[];
  set: { ids: string[]; match: number };
  onChange: (s: { ids: string[]; match: number }) => void;
}) {
  const toggle = (id: string, on: boolean) => onChange({ ...set, ids: on ? [...set.ids, id] : set.ids.filter((x) => x !== id) });
  return (
    <div className="space-y-2 rounded-md border border-(--gridline) p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <select value={set.match} onChange={(e) => onChange({ ...set, match: Number(e.target.value) })} className="rounded border border-(--gridline) bg-(--surface-2) px-2 py-1 text-xs">
          <option value={0}>全部符合</option>
          {Array.from({ length: Math.max(1, set.ids.length) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              至少 {n} 個符合
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {indicators.map((i) => (
          <label key={i.id} className="flex items-center gap-1" title={i.summary}>
            <input type="checkbox" checked={set.ids.includes(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
            {i.name}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function StrategiesClient() {
  const ind = useList<Indicator>("/api/strategy/indicators");
  const st = useList<Strategy>("/api/strategy/strategies");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testSymbol, setTestSymbol] = useState("2330");
  const [preview, setPreview] = useState<Preview | null>(null);

  const indicators = ind.items ?? [];
  const setCfg = (patch: Partial<StrategyConfig>) => draft && setDraft({ ...draft, config: { ...draft.config, ...patch } });

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ item: Strategy }>("/api/strategy/strategies", { body: draft });
      setDraft({ id: r.item.id, name: r.item.name, note: r.item.note, config: r.item.config });
      await st.reload();
      setMsg({ ok: true, text: "已儲存" });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Strategy) {
    if (!confirm(`確定刪除策略「${s.name}」？`)) return;
    try {
      await api(`/api/strategy/strategies?id=${encodeURIComponent(s.id)}`, { method: "DELETE" });
      await st.reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  async function test() {
    if (!draft?.id) return;
    setBusy(true);
    setPreview(null);
    setMsg(null);
    try {
      setPreview(await api<Preview>("/api/strategy/strategies/preview", { body: { strategyId: draft.id, symbol: testSymbol } }));
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const c = draft?.config;

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/strategies" intro="策略把多個參考指標組合成買賣規則，可選「條件式」或「加權計分」，再加上停損、停利與資金分配；模擬倉選一個策略就會照它自動交易。" />
      {msg && <p className={`text-sm ${msg.ok ? "text-(--price-down)" : "text-(--price-up)"}`}>{msg.text}</p>}
      {(ind.error || st.error) && <p className="text-sm text-(--price-up)">{ind.error || st.error}</p>}

      {ind.items && indicators.length === 0 && (
        <p className={`${cardCls} text-sm`}>
          還沒有參考指標，請先到{" "}
          <Link href="/indicators" className="text-(--accent) underline">
            參考指標
          </Link>{" "}
          建立幾個。
        </p>
      )}

      {draft && c ? (
        <section className={`${cardCls} space-y-4`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input placeholder="策略名稱" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} />
            <input placeholder="備註（選填）" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} />
          </div>

          <SourcePicker
            title="🔎 股票篩選判斷（可複選：先挑出股票名單，再用這個策略判斷買賣）"
            sources={c.screens}
            mode={c.screenMode}
            onChange={(screens, screenMode) => setCfg({ screens, screenMode })}
            emptyHint="目前沒有選：這個策略本身不挑股票。股票名單由使用它的地方決定——模擬倉在「策略要從哪些股票裡挑」自己選（例如自選清單、全市場），策略疊圖則是你自己輸入的股票。選了來源之後，模擬倉可以用「依策略選股」直接套用這裡的名單。"
          />

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" checked={c.mode === "rules"} onChange={() => setCfg({ mode: "rules" })} />
              條件式（符合條件就買／賣）
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={c.mode === "score"} onChange={() => setCfg({ mode: "score" })} />
              加權計分（各指標給分數，總分過門檻才買／賣）
            </label>
          </div>

          {c.mode === "rules" ? (
            <div className="space-y-3">
              <ConditionPicker title="🟥 買進條件" indicators={indicators} set={c.buy} onChange={(buy) => setCfg({ buy })} />
              <ConditionPicker title="🟩 賣出條件（選填，另有下方停損停利）" indicators={indicators} set={c.sell} onChange={(sell) => setCfg({ sell })} />
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-(--gridline) p-3">
              <p className="text-xs text-(--text-muted)">每個指標成立時加上它的分數（看空的指標可以給負分），0＝不使用。</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {indicators.map((i) => (
                  <label key={i.id} className="flex items-center justify-between gap-2 text-sm" title={i.summary}>
                    <span className="truncate">{i.name}</span>
                    <input
                      type="number"
                      step={0.5}
                      value={c.weights[i.id] ?? 0}
                      onChange={(e) => setCfg({ weights: { ...c.weights, [i.id]: Number(e.target.value) } })}
                      className={numCls}
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-4">
                <NumField label="總分 ≥ 多少買進" value={c.buyScore} step={0.5} onChange={(v) => setCfg({ buyScore: v })} />
                <NumField label="總分 ≤ 多少賣出" value={c.sellScore} step={0.5} onChange={(v) => setCfg({ sellScore: v })} />
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-md border border-(--gridline) p-3">
            <div className="text-sm font-medium">風控與資金</div>
            <div className="flex flex-wrap gap-4">
              <NumField label="停損 %" value={c.stopLossPct} onChange={(v) => setCfg({ stopLossPct: v })} hint="0＝不設" />
              <NumField label="停利 %" value={c.takeProfitPct} onChange={(v) => setCfg({ takeProfitPct: v })} hint="0＝不設" />
              <NumField label="最長持有天數" value={c.maxHoldDays} onChange={(v) => setCfg({ maxHoldDays: v })} hint="0＝不限" />
              <NumField label="每檔投入資金 %" value={c.positionPct} onChange={(v) => setCfg({ positionPct: v })} hint="占初始資金" />
              <NumField label="最多持有幾檔" value={c.maxPositions} onChange={(v) => setCfg({ maxPositions: v })} />
            </div>
          </div>

          {/* 錯誤訊息在頁面最上方，表單很長時按完儲存看不到：在按鈕旁再顯示一次 */}
          {msg && !msg.ok && <p className="text-sm text-(--price-up)">{msg.text}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
              {busy ? "處理中…" : "儲存策略"}
            </button>
            <button type="button" className={btnGhost} onClick={() => { setDraft(null); setPreview(null); }}>
              關閉
            </button>
          </div>

          {draft.id && (
            <div className="space-y-2 rounded-md border border-(--gridline) p-3 text-sm">
              <div className="font-medium">🔍 用這個策略測試一檔股票（以最新收盤判斷）</div>
              <div className="flex gap-2">
                <input value={testSymbol} onChange={(e) => setTestSymbol(e.target.value)} placeholder="代號，例如 2330" className={`${inputCls} !w-40`} />
                <button type="button" className={btnGhost} disabled={busy || !testSymbol.trim()} onClick={test}>
                  測試
                </button>
              </div>
              <p className="text-xs text-(--text-muted)">測試用的是已儲存的設定；改過設定請先按「儲存策略」。</p>
              {preview && (
                <div className="space-y-1">
                  <div>
                    {preview.name}（{preview.symbol}，{preview.lastDay}）：
                    <b className={preview.decision.buy ? "text-(--price-up)" : preview.decision.sell ? "text-(--price-down)" : ""}>
                      {preview.decision.buy ? "符合買進" : preview.decision.sell ? "符合賣出" : "不動作"}
                    </b>
                    <span className="ml-2 text-xs text-(--text-muted)">{preview.decision.summary}</span>
                  </div>
                  <ul className="space-y-0.5 text-xs">
                    {preview.decision.hits.map((h) => (
                      <li key={h.id}>
                        {h.pass === true ? "✅" : h.pass === false ? "❌" : "⚪"} {h.name}：{h.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <button type="button" className={btnPrimary} disabled={indicators.length === 0} onClick={() => setDraft({ name: "", note: "", config: EMPTY })}>
          ＋ 新增策略
        </button>
      )}
      {!draft && indicators.length === 0 && !ind.error && (
        <p className="text-xs text-(--text-muted)">{ind.items === null ? "載入參考指標中…（載入完才能新增策略）" : "要先有參考指標才能新增策略，請到「參考指標」頁建立。"}</p>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">我的策略{st.items ? `（${st.items.length}）` : ""}</h2>
        {st.items === null && !st.error && <p className="text-sm text-(--text-muted)">載入中…</p>}
        {st.items?.length === 0 && <p className="text-sm text-(--text-muted)">還沒有策略。</p>}
        <div className="grid gap-2">
          {st.items?.map((s) => (
            <div key={s.id} className={`${cardCls} !p-4 text-sm`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-(--text-muted)">{s.summary}</div>
                  {s.note && <div className="mt-1 text-xs text-(--text-secondary)">{s.note}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className={`${btnGhost} text-xs`} onClick={() => { setDraft({ id: s.id, name: s.name, note: s.note, config: s.config }); setPreview(null); setMsg(null); }}>
                    編輯／測試
                  </button>
                  <button type="button" className={`${btnGhost} text-xs`} onClick={() => remove(s)}>
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
