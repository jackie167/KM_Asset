// ─── Year constants ───────────────────────────────────────────────────────────

export const YEAR_START     = 2026;
export const YEAR_END       = 2044;
export const FORECAST_YEARS = Array.from({ length: YEAR_END - YEAR_START + 1 }, (_, i) => YEAR_START + i);

// ─── Types ────────────────────────────────────────────────────────────────────

export type CalcType = "direct" | "per_ha";

// Minimal structural interfaces — Drizzle inferred types satisfy these
interface IncomeSource {
  id: number;
  type: string;
  forecastMode: string;
  forecastBase: string | null;
  forecastRate: string | null;
}
interface ForecastEntry { sourceId: number; year: number; amount: string; }
interface CalcEntry     { sourceId: number; rowId: string; year: number; value: string; }

// ─── FCF computation (single source of truth) ─────────────────────────────────

export function computeFCF(inp: Record<string, number>, calcType: CalcType = "direct"): number {
  const g   = (id: string) => inp[id] ?? 0;
  const rev = calcType === "per_ha"
    ? g("area") * g("yield_per_ha") * g("price")
    : g("revenue_direct");
  const cogs = calcType === "per_ha"
    ? g("area") * (g("cogs_material") + g("cogs_labor") + g("cogs_overhead"))
    : g("cogs_direct");
  const dep  = g("depreciation");
  const ebit = (rev - cogs) - dep - g("interest") - g("sga");
  return (ebit - Math.max(0, ebit) * (g("tax_rate") / 100)) + dep - g("capex") - g("delta_wc");
}

// ─── Income totals per year (pure — no DB dependency) ─────────────────────────
// Aggregates: manual entries + growth-mode formula + business FCF

export function computeIncomeTotals(
  sources: IncomeSource[],
  forecastEntries: ForecastEntry[],
  calcEntries: CalcEntry[],
): Record<number, number> {
  const totals: Record<number, number> = {};
  for (const y of FORECAST_YEARS) totals[y] = 0;

  const fcBySource: Record<number, Record<number, number>> = {};
  for (const e of forecastEntries) {
    fcBySource[e.sourceId] ??= {};
    fcBySource[e.sourceId]![e.year] = Number(e.amount);
  }

  const calcBySource: Record<number, CalcEntry[]> = {};
  for (const e of calcEntries) {
    calcBySource[e.sourceId] ??= [];
    calcBySource[e.sourceId]!.push(e);
  }

  for (const src of sources) {
    if (src.type === "business") {
      const rows = calcBySource[src.id] ?? [];
      let calcType: CalcType = "direct";
      const vals: Record<string, Record<number, number>> = {};
      for (const e of rows) {
        if (e.rowId === "_calc_type") { calcType = Number(e.value) === 1 ? "per_ha" : "direct"; continue; }
        vals[e.rowId] ??= {};
        vals[e.rowId]![e.year] = Number(e.value);
      }
      for (const year of FORECAST_YEARS) {
        const inp: Record<string, number> = {};
        for (const [rowId, ym] of Object.entries(vals)) inp[rowId] = ym[year] ?? 0;
        totals[year]! += computeFCF(inp, calcType);
      }
    } else if (src.forecastMode === "growth" && Number(src.forecastBase) > 0) {
      const base = Number(src.forecastBase);
      const rate = Number(src.forecastRate) || 0;
      for (const year of FORECAST_YEARS) {
        totals[year]! += base * Math.pow(1 + rate / 100, year - YEAR_START);
      }
    } else {
      const stored = fcBySource[src.id] ?? {};
      for (const year of FORECAST_YEARS) totals[year]! += stored[year] ?? 0;
    }
  }

  return totals;
}
