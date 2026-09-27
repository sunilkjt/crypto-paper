import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-slate-800 bg-slate-900/70 shadow-[0_0_0_1px_rgba(0,0,0,0.2)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-slate-100 uppercase">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

export function DemoBadge({ label = "DEMO" }: { label?: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold tracking-widest text-amber-300">
      {label}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: string }) {
  const styles =
    direction === "LONG"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
      : direction === "SHORT"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
        : "border-slate-600 bg-slate-800 text-slate-300";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold tracking-wider",
        styles
      )}
    >
      {direction}
    </span>
  );
}

export function EmptyState({
  title,
  message,
  hint,
}: {
  title: string;
  message: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-slate-700 bg-slate-800/60 text-lg text-slate-500">
        ○
      </div>
      <p className="text-sm font-semibold text-slate-200">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-400">{message}</p>
      {hint ? (
        <p className="mt-3 inline-flex items-center rounded-full border border-slate-800 bg-slate-950 px-3 py-1 text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">{description}</p>
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">
        {label}
      </p>
      <p className="mt-1.5 text-lg font-bold text-slate-100">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

export function TableShell({
  columns,
  children,
  minWidth = "760px",
}: {
  columns: readonly string[];
  children?: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-slate-800 text-[11px] tracking-widest text-slate-500 uppercase">
            {columns.map((c) => (
              <th key={c} className="px-4 py-3 font-semibold whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
