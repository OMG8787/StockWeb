"use client";

import { useEffect, useState } from "react";
import { api, type ScreenConfig } from "./api";
import { btnGhost, inputCls } from "@/components/auth/ui";

interface Options {
  metrics: Array<{ id: string; label: string }>;
  positions: Array<{ id: "top" | "middle" | "bottom"; label: string }>;
  counts: number[];
  aiModes: Array<{ id: string; label: string }>;
}

let optionsCache: Options | null = null;

/** 策略的「股票篩選判斷」：依指標排名取前／中／後 N 名、AI 判斷、或全部關注名單；可預覽名單 */
export default function ScreenEditor({ value, onChange }: { value: ScreenConfig | null; onChange: (v: ScreenConfig | null) => void }) {
  const [opts, setOpts] = useState<Options | null>(optionsCache);
  const [preview, setPreview] = useState<Array<{ symbol: string; name: string; value?: number }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (optionsCache) return;
    api<Options>("/api/strategy/screen")
      .then((o) => {
        optionsCache = o;
        setOpts(o);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const source = value?.source ?? "none";
  const sel = `${inputCls} !w-auto`;

  function setSource(src: string) {
    setPreview(null);
    if (src === "none") onChange(null);
    else if (src === "metric") onChange({ source: "metric", metric: "volume_today", position: "top", count: 20 });
    else if (src === "ai") onChange({ source: "ai", mode: "action_picks", count: 10 });
    else onChange({ source: "watchlist" });
  }

  async function runPreview() {
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      setPreview((await api<{ items: Array<{ symbol: string; name: string; value?: number }> }>("/api/strategy/screen", { body: { screen: value } })).items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-(--gridline) p-3 text-sm">
      <div className="font-medium">🔎 股票篩選判斷（先篩出名單，再用這個策略去跑）</div>
      <div className="flex flex-wrap gap-4">
        {[
          ["none", "不篩選（由模擬倉自己指定股票）"],
          ["metric", "依指標排名"],
          ["ai", "AI 判斷"],
          ["watchlist", "全部關注名單"],
        ].map(([id, label]) => (
          <label key={id} className="flex items-center gap-1">
            <input type="radio" checked={source === id} onChange={() => setSource(id)} />
            {label}
          </label>
        ))}
      </div>

      {value?.source === "metric" && opts && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={value.metric} onChange={(e) => onChange({ ...value, metric: e.target.value })} className={sel}>
            {opts.metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={value.position} onChange={(e) => onChange({ ...value, position: e.target.value as "top" | "middle" | "bottom" })} className={sel}>
            {opts.positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={value.count} onChange={(e) => onChange({ ...value, count: Number(e.target.value) })} className={sel}>
            {opts.counts.map((n) => (
              <option key={n} value={n}>
                {n} 名
              </option>
            ))}
          </select>
        </div>
      )}
      {value?.source === "ai" && opts && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value })} className={sel}>
            {opts.aiModes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={value.count} onChange={(e) => onChange({ ...value, count: Number(e.target.value) })} className={sel}>
            {opts.counts.map((n) => (
              <option key={n} value={n}>
                最多 {n} 檔
              </option>
            ))}
          </select>
        </div>
      )}

      {value && (
        <div className="space-y-1">
          <button type="button" className={`${btnGhost} text-xs`} disabled={busy} onClick={runPreview}>
            {busy ? "篩選中…" : "預覽篩選結果"}
          </button>
          {preview && (
            <p className="text-xs text-(--text-secondary)">
              共 {preview.length} 檔：{preview.map((p) => `${p.name}(${p.symbol})`).join("、") || "（沒有符合的股票）"}
            </p>
          )}
        </div>
      )}
      {error && <p className="text-xs text-(--price-up)">{error}</p>}
    </div>
  );
}
