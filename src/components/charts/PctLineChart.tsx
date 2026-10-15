"use client";

/**
 * 通用的百分比折線圖（輕量 SVG，不載入圖表套件；同 NavChart 的畫法）：推薦回顧的平均報酬曲線、策略回測的淨值曲線共用。
 * 每個點滑鼠移上去會顯示 x 標籤與各線數值（title）；0% 畫虛線基準。
 */
export interface PctSeries {
  key: string;
  color: string;
  values: Array<number | null>;
  /** 主線畫粗一點 */
  bold?: boolean;
}

const W = 640;
const H = 240;
const PAD = { l: 48, r: 12, t: 12, b: 26 };

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export default function PctLineChart({
  series,
  xLabels,
  ariaLabel,
  hint,
}: {
  series: PctSeries[];
  /** 每個點的 x 標籤（例如「第 5 日」或日期） */
  xLabels: string[];
  ariaLabel: string;
  /** 每個點額外的說明（例如樣本數），顯示在滑鼠提示裡 */
  hint?: (i: number) => string;
}) {
  const n = xLabels.length;
  const all = [0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))];
  if (n === 0 || all.length === 1) return <p className="py-8 text-center text-sm text-(--text-muted)">還沒有足夠的資料可以畫圖。</p>;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const x = (i: number) => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = [hi, (hi + lo) / 2, lo];
  const mid = Math.floor((n - 1) / 2);
  const tip = (i: number) =>
    [xLabels[i], ...series.map((s) => `${s.key}：${s.values[i] == null ? "—" : fmtPct(s.values[i]!)}`), hint ? hint(i) : ""].filter(Boolean).join("\n");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
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
          return pts.length > 1 ? <polyline key={s.key} points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={s.bold ? 2.5 : 1.5} /> : null;
        })}
        {/* 每個 x 一條透明的感應區：滑鼠移上去顯示這一點所有線的數值 */}
        {xLabels.map((_, i) => (
          <rect key={i} x={x(i) - (W - PAD.l - PAD.r) / Math.max(1, n - 1) / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / Math.max(1, n - 1)} height={H - PAD.t - PAD.b} fill="transparent">
            <title>{tip(i)}</title>
          </rect>
        ))}
        {series.map((s) =>
          s.values.map((v, i) =>
            v == null || n > 60 ? null : (
              <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(v)} r={n === 1 ? 4 : 2} fill={s.color} pointerEvents="none" />
            ),
          ),
        )}
        <text x={PAD.l} y={H - 6} fontSize="11" fill="var(--text-muted)">
          {xLabels[0]}
        </text>
        {n > 2 && (
          <text x={x(mid)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {xLabels[mid]}
          </text>
        )}
        {n > 1 && (
          <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="11" fill="var(--text-muted)">
            {xLabels[n - 1]}
          </text>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-(--text-secondary)">
        {series.map((s) => {
          const last = [...s.values].reverse().find((v) => v != null);
          return (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: s.color }} />
              {s.key} {last == null ? "—" : fmtPct(last)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
