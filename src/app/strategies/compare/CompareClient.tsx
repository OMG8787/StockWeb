"use client";

import Link from "next/link";
import { useState } from "react";
import LabTabs from "@/components/strategy/LabTabs";
import OrderBookPanel from "@/components/strategy/OrderBookPanel";
import { api, useList, type Strategy } from "@/components/strategy/api";
import { btnGhost, btnPrimary, cardCls, inputCls } from "@/components/auth/ui";
import { getWatchlist } from "@/lib/watchlist";

type Signal = "buy" | "sell" | null;
interface Line {
  id: string;
  name: string;
  signals: Signal[];
  current: Signal;
  summary: string;
  latestOnly: boolean;
}
interface Row {
  symbol: string;
  market: "TW" | "US";
  name: string;
  days: string[];
  closes: number[];
  live: boolean;
  lines: Line[];
  consensus: boolean[];
  error?: string;
}

const AI = { id: "ai", name: "🤖 AI 建議策略（本站綜合評等）" };
const MAX_SYMBOLS = 10;
const MAX_STRATEGIES = 8;

/** AI 建議策略（本站評等）的「賣出側」是「建議先不要買」，不是要你賣出 */
const signalText = (s: Signal, lineId?: string) => (s === "buy" ? "買進" : s === "sell" ? (lineId === "ai" ? "先不要買" : "賣出") : "不動作");
/** 台股慣例：紅＝買進（偏多）、綠＝賣出（偏空） */
const signalColor = (s: Signal) => (s === "buy" ? "var(--price-up)" : s === "sell" ? "var(--price-down)" : "var(--gridline)");

function SignalChip({ s, lineId }: { s: Signal; lineId?: string }) {
  const cls = s === "buy" ? "border-(--price-up) text-(--price-up)" : s === "sell" ? "border-(--price-down) text-(--price-down)" : "border-(--gridline) text-(--text-muted)";
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{signalText(s, lineId)}</span>;
}

/** 每檔股票的「即時五檔」開關（打開才開始每 5 秒抓，避免 10 檔同時輪詢） */
function BookToggle({ symbol }: { symbol: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <button type="button" className={`${btnGhost} text-xs`} onClick={() => setShow(!show)}>
        {show ? "收起即時五檔" : "📊 看即時五檔（每 5 秒刷新）"}
      </button>
      {show && <OrderBookPanel symbols={[symbol]} title="即時五檔" />}
    </div>
  );
}

const shortName = (l: { id: string; name: string }) => (l.id === "ai" ? "AI 策略" : l.name);
const pctText = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * 收盤價走勢＋每個策略一條訊號帶（＋兩個以上策略時的「全部同時買進」帶）。
 * 滑鼠／手指移到哪一天就畫一條貫穿價格與訊號帶的垂直線，上方顯示當天價格、漲跌與所處階段，
 * 才看得出買賣訊號出現時股價是在上漲、下跌還是盤整（2026-10-08 使用者要求）。
 */
function OverlayChart({ row }: { row: Row }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const LABEL_W = 110;
  const PRICE_H = 150;
  const STRIP_H = 14;
  const GAP = 4;
  const n = row.closes.length;
  if (n < 2) return null;
  const lo = Math.min(...row.closes);
  const hi = Math.max(...row.closes);
  const plotW = W - LABEL_W;
  const cellW = plotW / n;
  const x = (i: number) => LABEL_W + (i + 0.5) * cellW;
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (PRICE_H - 16);
  const showConsensus = row.lines.length > 1;
  const strips = [
    ...row.lines.map((l) => ({ key: l.id, name: shortName(l), cells: l.signals })),
    ...(showConsensus ? [{ key: "consensus", name: "全部同時買進", cells: row.consensus.map((c) => (c ? "buy" : null) as Signal) }] : []),
  ];
  const H = PRICE_H + GAP + strips.length * (STRIP_H + GAP);
  const path = row.closes.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const at = hover ?? n - 1;
  const close = row.closes[at];
  const dayChg = at > 0 ? ((close - row.closes[at - 1]) / row.closes[at - 1]) * 100 : null;
  const back5 = row.closes[Math.max(0, at - 5)];
  const chg5 = at > 0 ? ((close - back5) / back5) * 100 : null;
  const posPct = hi > lo ? Math.round(((close - lo) / (hi - lo)) * 100) : 50;
  const stage = chg5 == null ? "" : chg5 >= 3 ? "近 5 日上漲" : chg5 <= -3 ? "近 5 日下跌" : "近 5 日盤整";

  function pick(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    if (vx < LABEL_W) return setHover(null);
    setHover(Math.min(n - 1, Math.max(0, Math.floor((vx - LABEL_W) / cellW))));
  }

  return (
    <div className="space-y-1">
      {/* 游標所在那天的資訊（沒有指著的時候顯示最新一天） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-(--surface-2) px-2 py-1 text-xs">
        <span className="font-medium">
          {row.days[at]}
          {hover == null && "（最新）"}
        </span>
        <span>收盤 {close}</span>
        {dayChg != null && <span className={dayChg >= 0 ? "text-(--price-up)" : "text-(--price-down)"}>當日 {pctText(dayChg)}</span>}
        {chg5 != null && (
          <span className={chg5 >= 0 ? "text-(--price-up)" : "text-(--price-down)"}>
            {stage}（{pctText(chg5)}）
          </span>
        )}
        <span className="text-(--text-muted)">位在區間高低的 {posPct}%</span>
        {row.lines.map((l) => (
          <span key={l.id} className="flex items-center gap-1">
            {shortName(l)}
            <SignalChip s={l.signals[at] ?? null} lineId={l.id} />
          </span>
        ))}
        {showConsensus && row.consensus[at] && <span className="font-semibold text-(--price-up)">✅ 全部同時買進</span>}
      </div>
      {/* 手機上整張圖縮到 390 寬會小到看不清：圖至少 620 寬，窄螢幕可左右滑動看（觸控點一下仍可換日期） */}
      <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full min-w-[620px] touch-pan-x touch-pan-y select-none"
        role="img"
        aria-label={`${row.name} 策略訊號疊圖`}
        onPointerMove={pick}
        onPointerDown={pick}
        // 觸控點一下之後瀏覽器會馬上送出 pointerleave：只有滑鼠移出才清掉，手機點完會停在那一天
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
      >
        {row.consensus.map((c, i) =>
          showConsensus && c ? <rect key={`band-${i}`} x={LABEL_W + i * cellW} y={0} width={cellW} height={PRICE_H} fill="var(--price-up)" opacity={0.12} /> : null,
        )}
        <text x={4} y={14} fontSize={11} fill="var(--text-muted)">
          {hi}
        </text>
        <text x={4} y={PRICE_H - 4} fontSize={11} fill="var(--text-muted)">
          {lo}
        </text>
        <text x={4} y={PRICE_H / 2 + 4} fontSize={11} fill="var(--text-muted)">
          收盤價
        </text>
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {row.consensus.map((c, i) =>
          showConsensus && c && !row.consensus[i - 1] ? (
            <text key={`tri-${i}`} x={x(i)} y={Math.min(PRICE_H - 2, y(row.closes[i]) + 16)} textAnchor="middle" fontSize={12} fill="var(--price-up)">
              ▲
            </text>
          ) : null,
        )}
        {strips.map((s, si) => {
          const top = PRICE_H + GAP + si * (STRIP_H + GAP);
          return (
            <g key={s.key}>
              <text x={4} y={top + STRIP_H - 3} fontSize={11} fill={s.key === "consensus" ? "var(--price-up)" : "var(--text-secondary)"}>
                {s.name.length > 9 ? `${s.name.slice(0, 8)}…` : s.name}
              </text>
              {s.cells.map((c, i) => (
                <rect key={i} x={LABEL_W + i * cellW + 0.5} y={top} width={Math.max(1, cellW - 1)} height={STRIP_H} fill={signalColor(c)} opacity={c ? 0.9 : 0.35} />
              ))}
            </g>
          );
        })}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--text-primary)" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <circle cx={x(hover)} cy={y(close)} r={4} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      </div>
      <div className="space-y-0.5 text-xs text-(--text-muted)">
        <div>
          每一排是一個策略每天的訊號：紅＝買進、綠＝賣出（AI 策略為「先不要買」）、淡灰＝不動作。
          {showConsensus && "最後一排「全部同時買進」＝上面所有策略在同一天都是買進（價格圖上的淡紅底與 ▲ 也是同一件事）。"}
          滑鼠移到圖上（手機點一下或按住滑動）可看那一天的價格與訊號。
        </div>
        <div>
          {row.days[0]} ～ {row.days.at(-1)}
          {row.live && "（最後一根為盤中即時價）"}
        </div>
        {row.lines.some((l) => l.id === "ai" && l.signals.slice(0, -1).every((x) => x === null)) && (
          <div>※ AI 策略的歷史取自本站的評等紀錄，紀錄從新系統上線後才開始累積，之前的日子顯示為不動作，「全部同時買進」也只會出現在有紀錄的日子。</div>
        )}
      </div>
    </div>
  );
}

export default function CompareClient() {
  const strategies = useList<Strategy>("/api/strategy/strategies");
  const [symbolsText, setSymbolsText] = useState("");
  const [picked, setPicked] = useState<string[]>([AI.id]);
  const [toAdd, setToAdd] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [screening, setScreening] = useState(false);
  const [error, setError] = useState("");

  const options = [AI, ...(strategies.items ?? []).map((s) => ({ id: s.id, name: s.name }))];
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? "（已刪除的策略）";
  const available = options.filter((o) => !picked.includes(o.id));
  const symbols = symbolsText.split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

  async function run() {
    setBusy(true);
    setError("");
    try {
      setRows((await api<{ rows: Row[] }>("/api/strategy/compare", { body: { symbols: symbols.slice(0, MAX_SYMBOLS), strategyIds: picked } })).rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 pb-24">
      <LabTabs active="/strategies/compare" intro="選 1～10 檔股票，把策略一個個疊上去（包含 AI 建議策略），看每個策略最近半年每天的買賣訊號；所有策略同時買進的日子會特別標出來。" />

      <section className={`${cardCls} space-y-4`}>
        <div className="space-y-1">
          <div className="text-sm font-medium">① 選股票（最多 {MAX_SYMBOLS} 檔）</div>
          <div className="flex flex-wrap gap-2">
            <input value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} placeholder="代號，例如 2330, 2317, 2454" className={`${inputCls} !w-auto flex-1`} />
            <button type="button" className={`${btnGhost} text-xs`} onClick={() => setSymbolsText(getWatchlist().slice(0, MAX_SYMBOLS).map((w) => w.symbol).join(", "))}>
              帶入關注清單
            </button>
          </div>
          {(strategies.items ?? []).some((s) => s.config.screens.length) && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-(--text-muted)">用策略的股票篩選帶入：</span>
              {(strategies.items ?? [])
                .filter((s) => s.config.screens.length)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`${btnGhost} text-xs`}
                    disabled={screening}
                    onClick={async () => {
                      setScreening(true);
                      setError("");
                      try {
                        const r = await api<{ items: Array<{ symbol: string }> }>("/api/strategy/screen", { body: { strategyId: s.id } });
                        setSymbolsText(r.items.slice(0, MAX_SYMBOLS).map((x) => x.symbol).join(", "));
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setScreening(false);
                      }
                    }}
                  >
                    {screening ? "篩選中…" : s.name}
                  </button>
                ))}
            </div>
          )}
          {symbols.length > MAX_SYMBOLS && <p className="text-xs text-(--price-up)">超過 {MAX_SYMBOLS} 檔，只會比對前 {MAX_SYMBOLS} 檔。</p>}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">② 疊策略（依加入順序，最多 {MAX_STRATEGIES} 個）</div>
          <div className="flex flex-wrap gap-2">
            {picked.map((id, i) => (
              <span key={id} className="flex items-center gap-1 rounded-full border border-(--accent) px-3 py-1 text-xs">
                {i + 1}. {nameOf(id)}
                <button type="button" aria-label="移除" className="text-(--text-muted)" onClick={() => setPicked(picked.filter((x) => x !== id))}>
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={toAdd} onChange={(e) => setToAdd(e.target.value)} className={`${inputCls} !w-auto`}>
              <option value="">選擇要加入的策略…</option>
              {available.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={btnGhost}
              disabled={!toAdd || picked.length >= MAX_STRATEGIES}
              onClick={() => {
                setPicked([...picked, toAdd]);
                setToAdd("");
              }}
            >
              ＋ 加入策略
            </button>
            {strategies.items?.length === 0 && (
              <span className="self-center text-xs text-(--text-muted)">
                還沒有自己的策略，可到{" "}
                <Link href="/strategies" className="text-(--accent) underline">
                  策略庫
                </Link>{" "}
                建立。
              </span>
            )}
          </div>
        </div>

        <button type="button" className={btnPrimary} disabled={busy || symbols.length === 0 || picked.length === 0} onClick={run}>
          {busy ? "計算中，第一次約 30 秒～1 分鐘…" : "③ 開始比對"}
        </button>
        {error && <p className="text-sm text-(--price-up)">{error}</p>}
      </section>

      {rows?.map((row) => {
        const allBuyNow = row.lines.length > 0 && row.lines.every((l) => l.current === "buy");
        return (
          <section key={row.symbol} className={`${cardCls} space-y-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/stock/${row.symbol}`} prefetch={false} className="text-lg font-semibold hover:underline">
                {row.name} <span className="text-sm text-(--text-muted)">{row.symbol}</span>
              </Link>
              {row.closes.length > 0 && <span className="text-sm">收盤 {row.closes.at(-1)}</span>}
              {allBuyNow ? (
                <span className="rounded-full bg-(--price-up) px-3 py-1 text-xs font-semibold text-white">✅ 全部 {row.lines.length} 個策略目前都是買進</span>
              ) : (
                row.lines.length > 0 && (
                  <span className="rounded-full border border-(--gridline) px-3 py-1 text-xs text-(--text-muted)">
                    {row.lines.filter((l) => l.current === "buy").length}／{row.lines.length} 個策略目前是買進
                  </span>
                )
              )}
            </div>
            {row.error ? (
              <p className="text-sm text-(--price-up)">{row.error}</p>
            ) : (
              <>
                <div className="grid gap-1 sm:grid-cols-2">
                  {row.lines.map((l, i) => (
                    <div key={l.id} className="flex items-start gap-2 text-sm">
                      <SignalChip s={l.current} lineId={l.id} />
                      <span>
                        {i + 1}. {l.name}
                        <span className="block text-xs text-(--text-muted)">
                          {l.summary}
                          {l.latestOnly && "（含籌碼／基本面類指標，歷史日子只看技術面）"}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <OverlayChart row={row} />
                {row.market === "TW" && <BookToggle symbol={row.symbol} />}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
