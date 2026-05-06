import { Router, type IRouter } from "express";
import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  baseAssetsTable,
  priceHistoryTable,
  forecastLoansTable,
  forecastLoanEventsTable,
  appSettingsTable,
  incomeExpenseTable,
  incomeSourcesTable,
  incomeForecastTable,
  incomeProjectCalcTable,
} from "../../../lib/db/src/index.ts";
import { FORECAST_YEARS, computeIncomeTotals } from "../lib/income-calc.ts";
import { getPortfolioCurrentValueSnapshot } from "./holdings.ts";

const router: IRouter = Router();

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const FINANCIAL_TYPES = new Set(["cash", "stock", "gold", "fund", "crypto"]);
const NON_MANUAL_TYPES = new Set(["stock", "gold", "crypto"]);
const norm = (t: string) => t.trim().toLowerCase().replace(/[\s-]+/g, "_");
const isFinancial  = (t: string) => FINANCIAL_TYPES.has(norm(t));
const isNonManual  = (t: string) => NON_MANUAL_TYPES.has(norm(t));
const STALE_DAYS   = 7;
const msPerDay     = 86_400_000;

export async function buildAIContext() {
  const now = new Date();

  const [portfolioSnapshot, baseAssets, latestPrices, loans, loanEvents, allSettings, ieRows, sources, forecastEntries, calcEntries] =
    await Promise.all([
      getPortfolioCurrentValueSnapshot(),
      db.select().from(baseAssetsTable),
      db.selectDistinctOn([priceHistoryTable.assetCode], {
        assetCode: priceHistoryTable.assetCode,
        priceOrValue: priceHistoryTable.priceOrValue,
        priceAt: priceHistoryTable.priceAt,
      }).from(priceHistoryTable).orderBy(priceHistoryTable.assetCode, desc(priceHistoryTable.priceAt)),
      db.select().from(forecastLoansTable),
      db.select().from(forecastLoanEventsTable),
      db.select().from(appSettingsTable),
      db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
      db.select().from(incomeSourcesTable).where(eq(incomeSourcesTable.active, true)),
      db.select().from(incomeForecastTable),
      db.select().from(incomeProjectCalcTable),
    ]);

  const settings = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));
  const { holdingsWithValue } = portfolioSnapshot;

  // ── Totals from portfolio snapshot (same formula as Investment page) ────────
  const totalFinancial = holdingsWithValue
    .filter((h) => isFinancial(h.type))
    .reduce((s, h) => s + (h.currentValue ?? 0), 0);
  const totalNonCash = holdingsWithValue
    .filter((h) => isFinancial(h.type) && norm(h.type) !== "cash")
    .reduce((s, h) => s + (h.currentValue ?? 0), 0);
  // Exclude financial snapshots and assets already tracked in holdingsWithValue (avoid double-count)
  const FINANCIAL_BASE_TYPES = new Set(["cash", "stock", "gold", "fund", "crypto", "financial"]);
  const nk = (s: string) => s.normalize("NFC").toUpperCase().trim();
  const holdingKeys = new Set(holdingsWithValue.map(h => `${norm(h.type)}::${nk(h.symbol)}`));
  const uniqueBaseAssets = baseAssets.filter(a =>
    !FINANCIAL_BASE_TYPES.has(norm(a.assetType)) &&
    !holdingKeys.has(`${norm(a.assetType)}::${nk(a.symbol)}`)
  );
  const totalBaseAssets = uniqueBaseAssets.reduce((s, a) => s + num(a.baseValue), 0);

  // Use total_assets saved by WealthAllocationPage (includes growth rates + forecast trades).
  // Fall back to raw sum if not yet saved.
  let liveTotalAssets = 0;
  try {
    const raw = settings["portfolio_live_total"];
    if (raw) liveTotalAssets = (JSON.parse(raw) as { total_assets?: number }).total_assets ?? 0;
  } catch { /* ignore */ }
  const totalAssets = liveTotalAssets > 0 ? liveTotalAssets : totalFinancial + totalBaseAssets;

  const activeLoans = loans.filter((l) => l.status === "active");

  // Compute remaining principal using same schedule logic as frontend getForecastDebtForYear()
  const currentYear = now.getFullYear();
  const eventsByLoanYear = new Map<string, typeof loanEvents>();
  for (const e of loanEvents) {
    const k = `${e.loanId}::${e.year}`;
    eventsByLoanYear.set(k, [...(eventsByLoanYear.get(k) ?? []), e]);
  }
  const loanState = new Map(activeLoans.map((l) => [l.id, num(l.principalStart)]));
  for (const year of Array.from({ length: currentYear - 2025 }, (_, i) => 2026 + i)) {
    for (const loan of activeLoans) {
      const starts = year >= loan.startYear;
      const ended = loan.endYear != null && year > loan.endYear;
      if (!starts || ended) continue;
      const startP = loanState.get(loan.id) ?? 0;
      const evts = eventsByLoanYear.get(`${loan.id}::${year}`) ?? [];
      const evtDrawdown   = evts.filter((e) => e.eventType === "drawdown").reduce((s, e) => s + num(e.amount), 0);
      const evtPrincipal  = evts.filter((e) => e.eventType === "principal_payment").reduce((s, e) => s + num(e.amount), 0);
      const evtSettlement = evts.filter((e) => e.eventType === "settlement").reduce((s, e) => s + num(e.amount), 0);
      const scheduled     = loan.repaymentType === "custom" ? 0 : num(loan.annualPrincipalPayment);
      const paid = Math.min(Math.max(0, startP + evtDrawdown), scheduled + evtPrincipal + evtSettlement);
      loanState.set(loan.id, Math.max(0, startP + evtDrawdown - paid));
    }
  }
  const totalLoan = activeLoans.reduce((s, l) => s + (loanState.get(l.id) ?? 0), 0);

  // Annual interest based on current remaining principal
  const annualInterest = activeLoans.reduce((s, l) => {
    const remaining = loanState.get(l.id) ?? 0;
    return s + (num(l.annualInterestPayment) || remaining * num(l.interestRate));
  }, 0);
  const netWorth       = totalAssets - totalLoan;
  const totalPnl       = holdingsWithValue.reduce((s, h) => s + (h.totalPnl ?? 0), 0);

  // ── Allocation targets from app_settings ──────────────────────────────────
  let allocTargets: Record<string, number> = {};
  try {
    const raw = settings["asset_forecast_allocation_ratios"];
    if (raw) allocTargets = JSON.parse(raw) as Record<string, number>;
  } catch { /* ignore */ }

  // ── dashboard_summary ─────────────────────────────────────────────────────
  const dashboard_summary = {
    total_assets:             Math.round(totalAssets),
    total_debt:               Math.round(totalLoan),
    net_worth:                Math.round(netWorth),
    total_investment:         Math.round(totalNonCash),
    investment_percent_total: totalAssets > 0 ? +((totalNonCash / totalAssets) * 100).toFixed(2) : 0,
    total_pnl:                Math.round(totalPnl),
    xirr:                     null,
    updated_at:               now.toISOString(),
  };

  // ── current_allocation ────────────────────────────────────────────────────
  const allocByType = new Map<string, number>();
  for (const h of holdingsWithValue) {
    if (!isFinancial(h.type)) continue;
    const t = norm(h.type);
    allocByType.set(t, (allocByType.get(t) ?? 0) + (h.currentValue ?? 0));
  }
  if (totalBaseAssets > 0) allocByType.set("base_assets", totalBaseAssets);

  const current_allocation = [...allocByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([assetClass, value]) => {
      const pctTotal = totalAssets > 0 ? +((value / totalAssets) * 100).toFixed(2) : 0;
      const pctFin   = totalFinancial > 0 && assetClass !== "base_assets"
        ? +((value / totalFinancial) * 100).toFixed(2) : null;
      const target   = allocTargets[assetClass] ?? null;
      let status = "no_target";
      if (target != null && pctFin != null) {
        status = pctFin < target * 0.7 ? "low" : pctFin > target * 1.3 ? "high" : "ok";
      }
      return { asset_class: assetClass, current_value: Math.round(value), percent_total_assets: pctTotal, percent_in_financial: pctFin, target_pct: target, status };
    });

  // ── current_holdings (from portfolio snapshot — same values as Investment page) ─
  const current_holdings = holdingsWithValue.map((h) => ({
    asset_code:           h.symbol,
    asset_class:          h.type,
    group:                h.investmentGroup || (isFinancial(h.type) ? "financial" : "real_estate"),
    current_value:        Math.round(h.currentValue ?? 0),
    cost_basis:           Math.round(h.costOfCapital ?? 0),
    realized_pnl:         Math.round(h.realizedPnl ?? 0),
    unrealized_pnl:       Math.round(h.unrealizedPnl ?? 0),
    total_pnl:            Math.round(h.totalPnl ?? 0),
    percent_in_financial: totalFinancial > 0 && isFinancial(h.type)
      ? +((( h.currentValue ?? 0) / totalFinancial) * 100).toFixed(2) : null,
    percent_total_assets: totalAssets > 0 ? +(((h.currentValue ?? 0) / totalAssets) * 100).toFixed(2) : 0,
    price_source:         "portfolio_summary",
  }));

  // Add base_assets as individual items — only unique non-financial ones not already in holdingsWithValue
  const base_assets_detail = uniqueBaseAssets.map((a) => ({
    asset_code:           a.symbol,
    asset_class:          a.assetType,
    group:                "base_assets",
    current_value:        Math.round(num(a.baseValue)),
    cost_basis:           Math.round(num(a.baseValue)),
    realized_pnl:         0,
    unrealized_pnl:       0,
    total_pnl:            0,
    percent_in_financial: null,
    percent_total_assets: totalAssets > 0 ? +((num(a.baseValue) / totalAssets) * 100).toFixed(2) : 0,
    price_source:         `base_year_${a.baseYear}`,
    updated_at:           a.updatedAt.toISOString(),
  }));

  // ── loans_summary ─────────────────────────────────────────────────────────
  const curYearIncome = num(ieRows.find((r) => r.year === now.getFullYear())?.income);
  const incomeTotals  = computeIncomeTotals(sources, forecastEntries, calcEntries);
  const curIncome     = (incomeTotals[now.getFullYear()] ?? 0) || curYearIncome;

  const loans_summary = {
    total_loan:          Math.round(totalLoan),
    loan_count:          activeLoans.length,
    monthly_interest:    Math.round(annualInterest / 12),
    annual_interest:     Math.round(annualInterest),
    debt_to_asset_ratio: totalAssets > 0 ? +((totalLoan / totalAssets) * 100).toFixed(2) : 0,
    interest_burden_pct: curIncome > 0 ? +((annualInterest / curIncome) * 100).toFixed(2) : null,
    loans: activeLoans.map((l) => ({
      name:            l.loanName,
      asset:           `${l.assetType}/${l.assetSymbol}`,
      principal:       Math.round(num(l.principalStart)),
      annual_interest: Math.round(num(l.annualInterestPayment)),
      rate_pct:        +((num(l.interestRate)) * 100).toFixed(2),
    })),
  };

  // ── cashflow_summary ──────────────────────────────────────────────────────
  const ieByYear = new Map(ieRows.map((r) => [r.year, r]));
  const cashflow_summary = FORECAST_YEARS.map((year) => {
    const row     = ieByYear.get(year);
    const income  = incomeTotals[year] ?? num(row?.income);
    const expense = row ? num(row.expense) + num(row.otherExpense) + num(row.totalInterest) : 0;
    return {
      year,
      income:      Math.round(income),
      expense:     Math.round(expense),
      net_saving:  Math.round(income - expense),
      ending_cash: row ? Math.round(income - expense) : null,
    };
  }).filter((r) => r.income > 0 || r.expense > 0);

  // ── data_quality ──────────────────────────────────────────────────────────
  const priceMap = new Map<string, { priceAt: Date }>();
  for (const p of latestPrices) priceMap.set(p.assetCode.toUpperCase(), { priceAt: p.priceAt });

  const missingPrices = holdingsWithValue
    .filter((h) => isNonManual(h.type) && (h.currentValue ?? 0) === 0)
    .map((h) => h.symbol);

  const stalePrices = holdingsWithValue
    .filter((h) => {
      if (!isNonManual(h.type)) return false;
      const ph = priceMap.get(h.symbol.toUpperCase());
      if (!ph) return false;
      return Math.floor((now.getTime() - ph.priceAt.getTime()) / msPerDay) > STALE_DAYS;
    })
    .map((h) => {
      const ph = priceMap.get(h.symbol.toUpperCase())!;
      return { asset_code: h.symbol, days_old: Math.floor((now.getTime() - ph.priceAt.getTime()) / msPerDay) };
    });

  const negativeCash = holdingsWithValue.some((h) => norm(h.type) === "cash" && (h.currentValue ?? 0) < 0);

  const allPriceDates = latestPrices.map((p) => p.priceAt.getTime()).filter(Boolean);
  const lastPriceUpdate = allPriceDates.length > 0
    ? new Date(Math.max(...allPriceDates)).toISOString()
    : null;

  const data_quality = {
    missing_prices:    missingPrices,
    stale_prices:      stalePrices,
    negative_cash:     negativeCash,
    base_assets_note:  "base_assets use base_year value — not live market price",
    xirr_note:         "xirr excluded — compute from /api/holdings endpoint",
    last_price_update: lastPriceUpdate,
    issues_count:      missingPrices.length + stalePrices.length + (negativeCash ? 1 : 0),
  };

  return {
    as_of:            now.toISOString(),
    dashboard_summary,
    current_allocation,
    current_holdings: [...current_holdings, ...base_assets_detail],
    loans_summary,
    cashflow_summary,
    data_quality,
  };
};

router.get("/ai/context", async (_req, res): Promise<void> => {
  res.json(await buildAIContext());
});

export default router;
