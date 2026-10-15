"use client";

import { AI_LIST_MAX, POOL_CANDIDATE_LIMIT, POOL_RATED_LIMIT, POOL_SOURCES } from "@/lib/ai/actionPoolInfo";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT } from "@/lib/ai/actionScoring";
import { useState } from "react";
import { MAX_SOURCES, SCREEN_AI_MODES, SCREEN_COUNTS, SCREEN_METRICS, SCREEN_POSITIONS, type ScreenMetric, type ScreenPosition } from "@/lib/strategy/screenConfig";
import { getWatchlist } from "@/lib/watchlist";
import { api, describeSource, type SourceMode, type StockSource, type Strategy } from "./api";
import { btnGhost, inputCls } from "@/components/auth/ui";

/**
 * 股票來源（可複選，2026-10-08 使用者要求）：像「新增參考指標」一樣用按鈕挑來源，
 * 每個來源有自己的顏色；預覽時每檔股票標出來自哪幾個來源的顏色點。
 * 策略庫（allowStrategy=false）與模擬倉（allowStrategy=true，多一個「依策略選股」）共用。
 */

interface PreviewResult {
  items: Array<{ symbol: string; name: string; value?: number; tags: number[] }>;
  counts: number[];
  labels: string[];
  errors: Array<{ index: number; message: string }>;
}

/** 每個來源的顏色（避開紅綠，紅綠在本站代表漲跌） */
export const SOURCE_COLORS = ["#3b82f6", "#f59e0b", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#06b6d4", "#a16207"];
const opts = { metrics: SCREEN_METRICS, positions: SCREEN_POSITIONS, counts: SCREEN_COUNTS, aiModes: SCREEN_AI_MODES };

/** AI 建議名單的資料池說明（數字讀 actionPoolInfo／actionScoring 的同一份常數，不會跟實際不一致） */
function AiPoolInfo() {
  return (
    <details className="rounded border border-(--gridline) bg-(--page-plane) px-2 py-1 text-xs text-(--text-secondary)">
      <summary className="cursor-pointer select-none text-(--accent)">這份 AI 建議名單的股票是怎麼來的？（點開看資料池）</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          <b>第 1 步：組候選池</b>（不是全市場，而是從下列榜單各取前幾名，同一檔重複上榜只算一檔，依序加入、合計最多 {POOL_CANDIDATE_LIMIT} 檔）：
        </p>
        <ul className="list-inside list-disc">
          {POOL_SOURCES.map((p) => (
            <li key={p.label}>
              {p.label}：前 {p.limit} 名——{p.note}
            </li>
          ))}
        </ul>
        <p>
          <b>第 2 步：初篩</b>——五個面向（技術、籌碼、持股結構、估值、財報）至少 {QUALIFY_MIN_SUPPORT} 個支持、且明確不支持不超過 {QUALIFY_MAX_AGAINST} 個。
        </p>
        <p>
          <b>第 3 步：評分</b>——通過初篩的最多取前 {POOL_RATED_LIMIT} 檔，各算一次「本站綜合評等」（跟個股頁、今日建議同一份），只留評等為「建議買進」的。
        </p>
        <p>
          <b>第 4 步：排名</b>——依本站把握程度（高→低）、面向支持數、現價離支撐遠近排序，取你設定的前 N 檔（最多 {AI_LIST_MAX} 檔）。你的策略條件（含成交量等）是在這份名單上再篩一次。
        </p>
      </div>
    </details>
  );
}

function parseSymbols(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

function Dot({ i }: { i: number }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />;
}

/** 自選清單卡片：文字框自己保留輸入中的文字（避免打逗號時被整理掉） */
function ListEditor({ symbols, onChange }: { symbols: string[]; onChange: (s: string[]) => void }) {
  const [text, setText] = useState(symbols.join(", "));
  return (
    <div className="space-y-1">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseSymbols(e.target.value));
        }}
        rows={2}
        placeholder="輸入代號，用逗號或空白分隔，例如：2330, 2317, 2454, AAPL"
        className={inputCls}
      />
      <button
        type="button"
        className={`${btnGhost} text-xs`}
        onClick={() => {
          const merged = [...new Set([...parseSymbols(text), ...getWatchlist().map((w) => w.symbol)])];
          setText(merged.join(", "));
          onChange(merged);
        }}
      >
        ＋ 帶入我的關注清單（之後關注清單變動不會跟著變）
      </button>
    </div>
  );
}

export default function SourcePicker({
  title,
  sources,
  mode,
  onChange,
  allowStrategy = false,
  strategy,
  emptyHint,
}: {
  title: string;
  sources: StockSource[];
  mode: SourceMode;
  onChange: (sources: StockSource[], mode: SourceMode) => void;
  /** 模擬倉才有「依策略選股」 */
  allowStrategy?: boolean;
  /** 模擬倉目前選的策略（展開「依策略選股」與預覽用） */
  strategy?: Strategy;
  emptyHint: string;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 每張卡片一個穩定的 key（刪掉中間的卡片時，後面卡片的輸入框不會錯位）
  const [keys, setKeys] = useState<number[]>(() => sources.map((_, i) => i));
  const [nextKey, setNextKey] = useState(sources.length);

  const update = (list: StockSource[], m: SourceMode = mode) => {
    setPreview(null);
    onChange(list, m);
  };
  const add = (s: StockSource) => {
    if (sources.length >= MAX_SOURCES) return setError(`最多選 ${MAX_SOURCES} 個來源`);
    setError("");
    setKeys([...keys, nextKey]);
    setNextKey(nextKey + 1);
    update([...sources, s]);
  };
  const remove = (i: number) => {
    setKeys(keys.filter((_, j) => j !== i));
    update(sources.filter((_, j) => j !== i));
  };
  const patch = (i: number, s: StockSource) => update(sources.map((x, j) => (j === i ? s : x)));
  /** 全市場、關注名單、依策略選股只能選一次：再按一次就取消 */
  const toggleSingle = (kind: "all" | "watchlist" | "strategy" | "smart") => {
    const at = sources.findIndex((s) => s.source === kind);
    if (at >= 0) remove(at);
    else add({ source: kind });
  };
  const has = (pred: (s: StockSource) => boolean) => sources.some(pred);

  const chip = (active: boolean) =>
    `${btnGhost} text-xs ${active ? "!border-(--accent) !bg-(--accent)/10 !text-(--accent) font-semibold" : ""}`;
  const sel = `${inputCls} !w-auto !py-1 text-xs`;
  const strategyScreens = strategy?.config.screens ?? [];

  async function runPreview() {
    setBusy(true);
    setError("");
    try {
      setPreview(await api<PreviewResult>("/api/strategy/screen", { body: { sources, mode, strategyId: strategy?.id }, busyText: "篩選股票名單中…（指標排名第一次約 10～60 秒）" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-(--gridline) p-3 text-sm">
      <div className="font-medium">{title}</div>

      {/* 可以選的來源（像新增參考指標一樣的按鈕，可複選） */}
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="text-xs font-medium text-(--text-muted)">基本範圍</div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={chip(has((s) => s.source === "all"))} onClick={() => toggleSingle("all")} title="台股當天有成交的所有股票（量大的先判斷）">
              全市場
            </button>
            <button
              type="button"
              className={chip(has((s) => s.source === "metric" && s.metric === "volume_today" && s.position === "top"))}
              onClick={() => add({ source: "metric", metric: "volume_today", position: "top", count: 30 })}
              title="台股當日成交量排名前 N 名"
            >
              台股成交量前 N 名
            </button>
            <button type="button" className={chip(has((s) => s.source === "list"))} onClick={() => add({ source: "list", symbols: [] })} title="自己輸入股票代號">
              自選清單
            </button>
            <button type="button" className={chip(has((s) => s.source === "watchlist"))} onClick={() => toggleSingle("watchlist")} title="每次執行時讀取你帳號目前的關注清單">
              我的關注清單
            </button>
            <button type="button" className={chip(has((s) => s.source === "smart"))} onClick={() => toggleSingle("smart")} title="每次執行時讀取你的智能清單裡目前符合策略的股票">
              🧠 我的智能清單
            </button>
            {allowStrategy && (
              <button
                type="button"
                className={chip(has((s) => s.source === "strategy"))}
                onClick={() => toggleSingle("strategy")}
                title="用所選策略在策略庫設定的「股票篩選判斷」"
              >
                依策略選股
              </button>
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-(--text-muted)">依指標排名（取前／中／後 N 名）</div>
          <div className="flex flex-wrap gap-2">
            {opts.metrics.map((m) => (
              <button
                key={m.id}
                type="button"
                className={chip(has((s) => s.source === "metric" && s.metric === m.id))}
                onClick={() => add({ source: "metric", metric: m.id, position: "top", count: 20 })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-(--text-muted)">AI 判斷</div>
          <AiPoolInfo />
          <div className="flex flex-wrap gap-2">
            {opts.aiModes.map((m) => (
              <button key={m.id} type="button" className={chip(has((s) => s.source === "ai" && s.mode === m.id))} onClick={() => add({ source: "ai", mode: m.id, count: 10 })}>
                🤖 {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 已選的來源 */}
      {sources.length === 0 ? (
        <p className="rounded-md bg-(--surface-2) px-3 py-2 text-xs text-(--text-secondary)">{emptyHint}</p>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium text-(--text-muted)">已選的來源（{sources.length}）</div>
          {sources.map((s, i) => (
            <div key={keys[i] ?? `i${i}`} className="space-y-2 rounded-md border border-(--gridline) border-l-4 p-2" style={{ borderLeftColor: SOURCE_COLORS[i % SOURCE_COLORS.length] }}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-medium">
                  <Dot i={i} />
                  來源 {i + 1}：{describeSource(s, strategy)}
                </span>
                <button type="button" aria-label="移除這個來源" className="text-xs text-(--text-muted) hover:text-(--price-up)" onClick={() => remove(i)}>
                  ✕ 移除
                </button>
              </div>
              {s.source === "metric" && (
                <div className="flex flex-wrap items-center gap-2">
                  <select value={s.metric} onChange={(e) => patch(i, { ...s, metric: e.target.value as ScreenMetric })} className={sel}>
                    {opts.metrics.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select value={s.position} onChange={(e) => patch(i, { ...s, position: e.target.value as ScreenPosition })} className={sel}>
                    {opts.positions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <select value={s.count} onChange={(e) => patch(i, { ...s, count: Number(e.target.value) })} className={sel}>
                    {opts.counts.map((n) => (
                      <option key={n} value={n}>
                        {n} 名
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {s.source === "ai" && (
                <div className="flex flex-wrap items-center gap-2">
                  <AiPoolInfo />
                  <p className="text-xs text-(--text-muted)">每次執行時讀取 AI 建議名單（依本站評分排名，取你在「我的關注 → AI 建議清單」設定的前 N 檔），名單變動會跟著變。</p>
                </div>
              )}
              {s.source === "list" && <ListEditor symbols={s.symbols} onChange={(symbols) => patch(i, { source: "list", symbols })} />}
              {s.source === "all" && <p className="text-xs text-(--text-muted)">台股當天有成交的股票（約一千多檔），依成交量由大到小判斷；模擬倉每天執行有時間上限，來不及的會略過並寫在執行紀錄。</p>}
              {s.source === "watchlist" && <p className="text-xs text-(--text-muted)">每次執行時讀取你帳號「目前」的關注清單，關注清單變動會跟著變。</p>}
              {s.source === "smart" && <p className="text-xs text-(--text-muted)">每次執行時讀取你的智能清單裡「目前符合策略」的股票（在 🧠 智能清單 設定策略與更新時間）。</p>}
              {s.source === "strategy" &&
                (strategy ? (
                  strategyScreens.length ? (
                    <p className="text-xs text-(--text-muted)">用策略「{strategy.name}」設定的股票篩選：{strategy.summary.split("；")[0].replace(/^股票：/, "")}</p>
                  ) : (
                    <p className="text-xs text-(--price-up)">策略「{strategy.name}」沒有設定股票篩選判斷，請到策略庫設定，或改選其他來源。</p>
                  )
                ) : (
                  <p className="text-xs text-(--price-up)">請先在上方選擇使用的策略。</p>
                ))}
            </div>
          ))}

          {sources.length > 1 && (
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="font-medium">多個來源怎麼合併：</span>
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === "union"} onChange={() => update(sources, "union")} />
                符合任一個（全部合起來）
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === "intersect"} onChange={() => update(sources, "intersect")} />
                同時符合全部（只留重疊的）
              </label>
            </div>
          )}

          <button type="button" className={`${btnGhost} text-xs`} disabled={busy} onClick={runPreview}>
            {busy ? "篩選中…（指標排名第一次可能要十幾秒）" : "👀 預覽名單"}
          </button>
        </div>
      )}

      {preview && (
        <div className="space-y-2 rounded-md bg-(--surface-2) p-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {preview.labels.map((label, i) => (
              <span key={i} className="flex items-center gap-1">
                <Dot i={i} />
                {label}：{preview.counts[i] < 0 ? <span className="text-(--price-up)">失敗</span> : `${preview.counts[i]} 檔`}
              </span>
            ))}
          </div>
          {preview.errors.map((e) => (
            <p key={e.index} className="text-(--price-up)">
              來源 {e.index + 1} 失敗：{e.message}
            </p>
          ))}
          <div className="font-medium">
            合併後共 {preview.items.length} 檔{sources.length > 1 ? `（${mode === "intersect" ? "同時符合全部" : "符合任一個"}）` : ""}
            {preview.items.length > 300 && "，下面只列前 300 檔"}
          </div>
          {preview.items.length === 0 ? (
            <p className="text-(--text-muted)">（沒有符合的股票）</p>
          ) : (
            <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">
              {preview.items.slice(0, 300).map((p) => (
                <span
                  key={p.symbol}
                  className="flex items-center gap-1 rounded-full border border-(--gridline) bg-(--surface-1) px-2 py-0.5"
                  title={`來自：${p.tags.map((t) => `來源 ${t + 1}`).join("、")}`}
                >
                  <span className="flex gap-0.5">
                    {p.tags.map((t) => (
                      <Dot key={t} i={t} />
                    ))}
                  </span>
                  {p.name}
                  <span className="text-(--text-muted)">{p.symbol}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-(--price-up)">{error}</p>}
    </div>
  );
}
