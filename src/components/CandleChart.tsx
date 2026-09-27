import { useMemo } from "react";
import type { Candle } from "../market/hyperliquid/types";

const W = 720;
const H = 260;
const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 12;
const PAD_B = 22;

/**
 * Lightweight SVG candlestick chart (no per-candle React chart instances).
 * Renders the full fetched window (300 candles max from useCandles) —
 * a single SVG with a few hundred nodes stays responsive, unlike hundreds
 * of chart components. Aggregation is deliberately avoided so no price
 * action is hidden from the user. Optional `levels` overlay entry/SL/TPs.
 */
export interface ChartLevel {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
}

export function CandleChart({ candles, levels = [] }: { candles: Candle[]; levels?: ChartLevel[] }) {
  const view = useMemo(() => {
    const data = candles;
    if (data.length === 0) return null;
    let hi = -Infinity;
    let lo = Infinity;
    let vmax = 0;
    for (const c of data) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      if (c.volume > vmax) vmax = c.volume;
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
    const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    hi += pad;
    lo -= pad;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const volH = plotH * 0.18;
    const priceH = plotH - volH - 8;
    const y = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * priceH;
    const step = plotW / data.length;
    const bodyW = Math.max(1.5, Math.min(14, step * 0.62));
    return { data, hi, lo, vmax, y, step, bodyW, plotH, priceH, volH };
  }, [candles]);

  if (!view) {
    return (
      <div className="flex h-[260px] items-center justify-center text-xs text-slate-500">
        No candles to render.
      </div>
    );
  }

  const { data, hi, lo, vmax, y, step, bodyW, volH } = view;
  const ticks = [hi, (hi + lo) / 2, lo];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[260px] w-full" role="img" aria-label="Candlestick chart">
      {[0.1, 0.35, 0.6, 0.85].map((f) => (
        <line
          key={f}
          x1={PAD_L}
          x2={W - PAD_R}
          y1={PAD_T + f * (H - PAD_T - PAD_B)}
          y2={PAD_T + f * (H - PAD_T - PAD_B)}
          stroke="#1e293b"
          strokeDasharray="3 4"
          strokeWidth={1}
        />
      ))}
      {data.map((c, i) => {
        const x = PAD_L + i * step + step / 2;
        const up = c.close >= c.open;
        const color = up ? "#34d399" : "#fb7185";
        const top = y(Math.max(c.open, c.close));
        const bottom = y(Math.min(c.open, c.close));
        const vh = vmax > 0 ? Math.max(1, (c.volume / vmax) * volH) : 1;
        const d = new Date(c.timestamp);
        const label =
          i % Math.ceil(data.length / 5) === 0
            ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
            : null;
        return (
          <g key={c.timestamp}>
            <rect x={x - bodyW / 2} y={H - PAD_B - vh} width={bodyW} height={vh} fill={color} opacity={0.28} />
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={Math.max(1, bodyW * 0.18)} />
            <rect
              x={x - bodyW / 2}
              y={top}
              width={bodyW}
              height={Math.max(1, bottom - top)}
              fill={color}
              rx={0.8}
            />
            {label && (
              <text x={x} y={H - 6} fill="#64748b" fontSize={9} textAnchor="middle">
                {label}
              </text>
            )}
          </g>
        );
      })}
      {ticks.map((t) => (
        <text key={t} x={W - PAD_R + 6} y={y(t) + 3} fill="#64748b" fontSize={10} fontFamily="monospace">
          {t >= 1000 ? t.toFixed(1) : t >= 100 ? t.toFixed(2) : t >= 1 ? t.toFixed(3) : t.toFixed(5)}
        </text>
      ))}
      {levels
        .filter((l) => Number.isFinite(l.price) && l.price >= lo && l.price <= hi)
        .map((l, i) => (
          <g key={`${l.label}-${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(l.price)}
              y2={y(l.price)}
              stroke={l.color}
              strokeWidth={1.2}
              strokeDasharray={l.dashed === false ? undefined : "5 4"}
            />
            <text x={W - PAD_R + 4} y={y(l.price) - 3} fill={l.color} fontSize={9} fontWeight="bold">
              {l.label}
            </text>
          </g>
        ))}
    </svg>
  );
}
