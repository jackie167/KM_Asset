import { Router, type IRouter } from "express";
import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  holdingsTable,
  baseAssetsTable,
  priceHistoryTable,
  forecastLoansTable,
  appSettingsTable,
  incomeExpenseTable,
  incomeSourcesTable,
  incomeForecastTable,
  incomeProjectCalcTable,
} from "../../../lib/db/src/index.ts";
import { FORECAST_YEARS, computeIncomeTotals } from "../lib/income-calc.ts";

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

router.get("/ai/context", async (_req, res): Promise<void> => {
  const now = new Date();

  const [holdings, baseAssets, latestPrices, loans, allSettings, ieRows, sources, forecastEntries, calcEntries] =
    await Promise.all([
      db.select().from(holdingsTable),
      db.select().from(baseAssetsTable),
      db.selectDistinctOn([priceHistoryTable.assetCode], {
        assetCode: priceHistoryTable.assetCode,
        priceOrValue: priceHistoryTable.priceOrValue,
        priceAt: priceHistoryTable.priceAt,
      }).from(priceHistoryTable).orderBy(priceHistoryTable.assetCode, desc(priceHistoryTable.priceAt)),
      db.select().from(forecastLoansTable),
      db.select().from(appSettingsTable),
      db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
      db.select().from(incomeSourcesTable).where(eq(incomeSourcesTable.active, true)),
      db.select().from(incomeForecastTable),
      db.select().from(incomeProjectCalcTable),
    ]);

  const settings = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));

  // ── Price map (per-unit price from price_history) ──────────────────────────
  const priceMap = new Map<string, { price: number; priceAt: Date }>();
  for (const p of latestPrices) {
    priceMap.set(p.assetCode.toUpperCase(), {
      price: num(p.priceOrValue),
      priceAt: p.priceAt,
    });
  }

  // ── Holdings with computed current value ───────────────────────────────────
  const holdingsCalc = holdings.map((h) => {
    const qty      = num(h.quantity);
    const manual   = num(h.manualPrice);
    const cost     = num(h.costOfCapital);
    const realized = num(h.interest);
    const ph       = priceMap.get(h.symbol.toUpperCase());

    const unitPrice    = isNonManual(h.type) ? (ph?.price || manual) : manual;
    const currentValue = isNonManual(h.type) ? qty * unitPrice : manual;
    const unrealized   = cost > 0 && currentValue > 0 ? currentValue - cost : 0;
    const totalPnl     = unrealized + realized;

    const daysOld      = ph ? Math.floor((now.getTime() - ph.priceAt.getTime()) / msPerDay) : null;
    const priceSource  = isNonManual(h.type)
      ? (ph ? `price_history (${daysOld}d ago)` : "manual_fallback")
      : "manual";

    return { h, currentValue, cost, realized, unrealized, totalPnl, priceSource, daysOld, unitPrice };
  });

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totalFinancial   = holdingsCalc.filter((x) => isFinancial(x.h.type)).reduce((s, x) => s + x.currentValue, 0);
  const totalNonCash     = holdingsCalc.filter((x) => isFinancial(x.h.type) && norm(x.h.type) !== "cash").reduce((s, x) => s + x.currentValue, 0);
  const totalBaseAssets  = baseAssets.reduce((s, a) => s + num(a.baseValue), 0);
  const totalAssets      = totalFinancial + totalBaseAssets;

  const activeLoans      = loans.filter((l) => l.status === "active");
  const totalLoan        = activeLoans.reduce((s, l) => s + num(l.principalStart), 0);
  const annualInterest   = activeLoans.reduce((s, l) => s + num(l.annualInterestPayment), 0);
  const netWorth         = totalAssets - totalLoan;
  const totalPnl         = holdingsCalc.reduce((s, x) => s + x.totalPnl, 0);

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
    xirr:                     null, // compute separately — expensive
    updated_at:               now.toISOString(),
  };

  // ── current_allocation ────────────────────────────────────────────────────
  const allocByType = new Map<string, number>();
  for (const { h, currentValue } of holdingsCalc) {
    if (!isFinancial(h.type)) continue;
    const t = norm(h.type);
    allocByType.set(t, (allocByType.get(t) ?? 0) + currentValue);
  }
  // Include base_assets as a category
  if (totalBaseAssets > 0) allocByType.set("base_assets", totalBaseAssets);

  const current_allocation = [...allocByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([assetClass, value]) => {
      const pctTotal   = totalAssets > 0 ? +((value / totalAssets) * 100).toFixed(2) : 0;
      const pctFin     = totalFinancial > 0 && assetClass !== "base_assets"
        ? +((value / totalFinancial) * 100).toFixed(2) : null;
      const target     = allocTargets[assetClass] ?? null;
      let status: string = "no_target";
      if (target != null && pctFin != null) {
        status = pctFin < target * 0.7 ? "low" : pctFin > target * 1.3 ? "high" : "ok";
      }
      return { asset_class: assetClass, current_value: Math.round(value), percent_total_assets: pctTotal, percent_in_financial: pctFin, target_pct: target, status };
    });

  // ── current_holdings ─────────────────────────────────────────────────────
  const current_holdings = holdingsCalc.map(({ h, currentValue, cost, realized, unrealized, totalPnl, priceSource }) => ({
    asset_code:          h.symbol,
    asset_class:         h.type,
    group:               h.investmentGroup || (isFinancial(h.type) ? "financial" : "real_estate"),
    current_value:       Math.round(currentValue),
    cost_basis:          Math.round(cost),
    realized_pnl:        Math.round(realized),
    unrealized_pnl:      Math.round(unrealized),
    total_pnl:           Math.round(totalPnl),
    percent_in_financial: totalFinancial > 0 && isFinancial(h.type)
      ? +((currentValue / totalFinancial) * 100).toFixed(2) : null,
    percent_total_assets: totalAssets > 0 ? +((currentValue / totalAssets) * 100).toFixed(2) : 0,
    price_source:        priceSource,
    updated_at:          h.updatedAt.toISOString(),
  }));

  // Add base_assets as individual items
  const base_assets_detail = baseAssets.map((a) => ({
    asset_code:          a.symbol,
    asset_class:         a.assetType,
    group:               "base_assets",
    current_value:       Math.round(num(a.baseValue)),
    cost_basis:          Math.round(num(a.baseValue)),
    realized_pnl:        0,
    unrealized_pnl:      0,
    total_pnl:           0,
    percent_in_financial: null,
    percent_total_assets: totalAssets > 0 ? +((num(a.baseValue) / totalAssets) * 100).toFixed(2) : 0,
    price_source:        `base_year_${a.baseYear}`,
    updated_at:          a.updatedAt.toISOString(),
  }));

  // ── loans_summary ─────────────────────────────────────────────────────────
  // Current year income for interest burden calculation
  const curYearIncome = num(ieRows.find((r) => r.year === now.getFullYear())?.income);
  const incomeTotals  = computeIncomeTotals(sources, forecastEntries, calcEntries);
  const curIncome     = (incomeTotals[now.getFullYear()] ?? 0) || curYearIncome;

  const loans_summary = {
    total_loan:           Math.round(totalLoan),
    loan_count:           activeLoans.length,
    monthly_interest:     Math.round(annualInterest / 12),
    annual_interest:      Math.round(annualInterest),
    debt_to_asset_ratio:  totalAssets > 0 ? +((totalLoan / totalAssets) * 100).toFixed(2) : 0,
    interest_burden_pct:  curIncome > 0 ? +((annualInterest / curIncome) * 100).toFixed(2) : null,
    loans: activeLoans.map((l) => ({
      name:             l.loanName,
      asset:            `${l.assetType}/${l.assetSymbol}`,
      principal:        Math.round(num(l.principalStart)),
      annual_interest:  Math.round(num(l.annualInterestPayment)),
      rate_pct:         +((num(l.interestRate)) * 100).toFixed(2),
    })),
  };

  // ── cashflow_summary ──────────────────────────────────────────────────────
  const ieByYear = new Map(ieRows.map((r) => [r.year, r]));
  const cashflow_summary = FORECAST_YEARS.map((year) => {
    const row      = ieByYear.get(year);
    const income   = incomeTotals[year] ?? num(row?.income);
    const expense  = row ? num(row.expense) + num(row.otherExpense) + num(row.totalInterest) : 0;
    return {
      year,
      income:       Math.round(income),
      expense:      Math.round(expense),
      net_saving:   Math.round(income - expense),
      ending_cash:  row ? Math.round(income - expense) : null, // simplified; full free cash from asset forecast page
    };
  }).filter((r) => r.income > 0 || r.expense > 0);

  // ── data_quality ──────────────────────────────────────────────────────────
  const missingPrices = holdingsCalc
    .filter(({ h, currentValue }) => isNonManual(h.type) && currentValue === 0)
    .map(({ h }) => h.symbol);

  const stalePrices = holdingsCalc
    .filter(({ h, daysOld }) => isNonManual(h.type) && daysOld != null && daysOld > STALE_DAYS)
    .map(({ h, daysOld }) => ({ asset_code: h.symbol, days_old: daysOld! }));

  const negativeCash = holdingsCalc.some(({ h, currentValue }) => norm(h.type) === "cash" && currentValue < 0);

  const allPriceDates = latestPrices.map((p) => p.priceAt.getTime()).filter(Boolean);
  const lastPriceUpdate = allPriceDates.length > 0
    ? new Date(Math.max(...allPriceDates)).toISOString()
    : null;

  const data_quality = {
    missing_prices:   missingPrices,
    stale_prices:     stalePrices,
    negative_cash:    negativeCash,
    base_assets_note: "base_assets use base_year value — not live market price",
    xirr_note:        "xirr excluded — compute from /api/holdings endpoint",
    last_price_update: lastPriceUpdate,
    issues_count:     missingPrices.length + stalePrices.length + (negativeCash ? 1 : 0),
  };

  res.json({
    as_of:             now.toISOString(),
    dashboard_summary,
    current_allocation,
    current_holdings:  [...current_holdings, ...base_assets_detail],
    loans_summary,
    cashflow_summary,
    data_quality,
  });
});

export default router;
