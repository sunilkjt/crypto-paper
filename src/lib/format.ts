/** Pure display formatting. Null-safe — never invents values. */

export function formatPrice(value: number | null, symbol?: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : 6;
  void symbol;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPriceUsd(value: number | null, symbol?: string): string {
  const p = formatPrice(value, symbol);
  return p === "—" ? "—" : `$${p}`;
}

export function formatChangePct(value: number | null): { text: string; positive: boolean | null } {
  if (value === null || !Number.isFinite(value)) return { text: "—", positive: null };
  const sign = value > 0 ? "+" : value < 0 ? "" : "";
  return { text: `${sign}${value.toFixed(2)}%`, positive: value > 0 ? true : value < 0 ? false : null };
}

export function formatVolumeNotional(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatOiCoins(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}
