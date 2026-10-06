"use client";

import type { SimNavPoint } from "@/lib/simPortfolio/types";

/**
 * 淨值走勢（累計報酬 %）：AI 組合 vs 0050 vs 加權指數，起點都是 0%。輕量 SVG，不載入圖表套件。
 * 只有 1 個點時仍畫出點與數值。
 */
const W = 640;
const H = 220;
const PAD = { l: 44, r: 12, t: 12, b: 24 };

export default function NavChart({
  points,
  initialCapital,
  base,
}: {
  points: SimNavPoint[];
  initialCapital: number;
  base: { etf: number | null; index: number | null };
}) {
  if (points.length === 0) return <p className="py-8 text-center text-sm text-(--text-muted)">還沒有淨值紀錄。</p>;
  const toPct = (v: number | null, b: number | null) => (v != null && b != null && b > 0 ? (v / b - 1) * 100 : null);
  const series = [
    { key: "AI 組合", color: "var(--accent)", values: points.map((p) => toPct(p.nav, initialCapital)) },
    { key: "0050", color: "var(--text-muted)", values: points.map((p) => toPct(p.etf, base.etf)) },
    { key: "加權指數", color: "#c98a1b", values: points.map((p) => toPct(p.index, base.index)) },
  ];
  const all = [0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const x = (i: number) => PAD.l + (points.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = [hi, (hi + lo) / 2, lo];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="累計報酬走勢：AI 組合、0050、加權指數">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--gridline)" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
              {t.toFixed(1)}%
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--baseline)" strokeDasharray="3 3" />
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
          return (
            <g key={s.key}>
              {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={s.key === "AI 組合" ? 2.5 : 1.5} />}
              {s.values.map((v, i) => (v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={points.length === 1 ? 4 : 2} fill={s.color} />))}
            </g>
          );
        })}
        <text x={PAD.l} y={H - 6} fontSize="11" fill="var(--text-muted)">
          {points[0].day}
        </text>
        {points.length > 1 && (
          <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="11" fill="var(--text-muted)">
            {points[points.length - 1].day}
          </text>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-secondary)">
        {series.map((s) => {
          const last = [...s.values].reverse().find((v) => v != null);
          return (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: s.color }} />
              {s.key} {last == null ? "—" : `${last > 0 ? "+" : ""}${last.toFixed(2)}%`}
            </span>
          );
        })}
      </div>
    </div>
  );
}
