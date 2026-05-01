import type { TypeMode } from "@/pages/assets/types";

const VND_INT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const VND_2 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const TYPE_META: Record<string, { label: string; shortLabel: string; decoratedLabel: string }> = {
  stock: { label: "Stock", shortLabel: "Stock", decoratedLabel: "📈 Stock" },
  fund: { label: "Fund", shortLabel: "Fund", decoratedLabel: "📦 Fund" },
  bond: { label: "Bond", shortLabel: "Bond", decoratedLabel: "🧾 Bond" },
  cash: { label: "Cash", shortLabel: "Cash", decoratedLabel: "💵 Cash" },
  real_estate: { label: "Real Estate", shortLabel: "Real Estate", decoratedLabel: "🏠 Real Estate" },
  gold: { label: "Gold", shortLabel: "Gold", decoratedLabel: "🥇 Gold" },
  crypto: { label: "Crypto", shortLabel: "Crypto", decoratedLabel: "🪙 Crypto" },
  other: { label: "Other", shortLabel: "Other", decoratedLabel: "💼 Other" },
  financial: { label: "Financial", shortLabel: "Financial", decoratedLabel: "📊 Financial" },
};

function toTitleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getTypeMeta(type: string) {
  const normalizedType = type.trim().toLowerCase();
  const fallbackLabel = toTitleCase(normalizedType || "other");
  return (
    TYPE_META[normalizedType] ?? {
      label: fallbackLabel,
      shortLabel: fallbackLabel,
      decoratedLabel: `💼 ${fallbackLabel}`,
    }
  );
}

export function formatVND(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000_000) return `${VND_2.format(value / 1_000_000_000)} tỷ`;
  if (value >= 1_000_000) return `${VND_2.format(value / 1_000_000)} tr`;
  return VND_INT.format(value);
}

export function formatVNDFull(value: number | null | undefined): string {
  if (value == null) return "—";
  return VND_INT.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export function resolveMode(type: string): TypeMode {
  if (type === "stock") return "stock";
  if (type === "gold") return "gold";
  return "other";
}

export function typeLabel(type: string) {
  return getTypeMeta(type).decoratedLabel;
}

export function formatTypeLabel(type: string) {
  return getTypeMeta(type).label;
}

export function formatTypeShortLabel(type: string) {
  return getTypeMeta(type).shortLabel;
}

export function deriveInvestmentGroup(type: string) {
  const normalizedType = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalizedType === "real_estate" || normalizedType === "realestate" ? "real_estate" : "financial";
}
