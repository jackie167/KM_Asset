import { CASHFLOW_SOURCE_SHEET, findColIdx, parseNum, type CashflowData } from "@/lib/excel-sheets";
import { fetchBaseAssetHoldings } from "@/pages/wealthAllocationData";
import type { HoldingItem } from "@/pages/assets/types";

export const FORECAST_YEARS = Array.from({ length: 2044 - 2026 + 1 }, (_, i) => 2026 + i);
export const INITIAL_2026_FREE_CASH = 7_370_845_000;
export const INVEST_TYPES = ["cash", "stock", "gold", "fund", "crypto"] as const;
export type InvestType = typeof INVEST_TYPES[number];

export const DEFAULT_RATES: Record<InvestType, number> = { cash: 4, stock: 15, gold: 8, fund: 9, crypto: 15 };
export const TYPE_LABELS: Record<InvestType, string> = { cash: "Cash", stock: "Stock", gold: "Gold", fund: "Fund", crypto: "Crypto" };
export const DEFAULT_ALLOCATION_RATIOS: Record<InvestType, number> = { cash: 10, gold: 30, fund: 10, crypto: 10, stock: 40 };
export const SYMBOL_TYPE_MAP: Record<string, InvestType> = { cash: "cash", stock: "stock", gold: "gold", fund: "fund", crypto: "crypto" };

export const DB_KEYS = {
  assetReturns: "asset_forecast_asset_returns",
  allocationRatios: "asset_forecast_allocation_ratios",
  investmentReturns: "asset_forecast_investment_returns",
} as const;

export function isInvestType(value: string): value is InvestType {
  return INVEST_TYPES.includes(value as InvestType);
}

export function getInvestmentType(holding: HoldingItem): InvestType | null {
  const type = holding.type.toLowerCase();
  if (isInvestType(type)) return type;
  return SYMBOL_TYPE_MAP[holding.symbol.toLowerCase()] ?? null;
}

export function isUnallocatedFreeCash(holding: HoldingItem) {
  const s = holding.symbol.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return getInvestmentType(holding) === "cash" || s === "freecash";
}

export function assetReturnKey(holding: HoldingItem) {
  return `${holding.type.trim().toLowerCase()}::${holding.symbol.trim().toUpperCase()}`;
}

export function fixedTradeKey(assetType: string, symbol: string) {
  return `${assetType.trim().toLowerCase()}::${symbol.trim().toUpperCase()}`;
}

export type ForecastTrade = {
  id: number;
  side: "buy" | "sell";
  year: number;
  assetType: string;
  symbol: string;
  amount: number;
  loanRatio: number;
  loanInterestRate: number;
  loanAnnualPrincipalPayment: number;
  loanAnnualInterestPayment: number;
  loanRepaymentType: "interest_only" | "principal_interest" | "bullet" | "custom";
  settleLoanOnSell: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FreeCashRow = {
  year: number; income: number; otherIncome: number; expense: number;
  otherExpense: number; totalInterest: number; totalIncome: number;
  totalExpense: number; freeCash: number;
};

export function parsePercentInput(value: string): number {
  const c = value.trim().replace(/[^\d,.-]/g, "");
  const n = c.includes(",") && !c.includes(".") ? c.replace(",", ".") : c;
  const p = Number.parseFloat(n);
  return Number.isFinite(p) ? p : 0;
}

export function readJsonRecord(key: string): Record<string, string> {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "{}");
    return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, string> : {};
  } catch { return {}; }
}

export async function loadDbSetting(key: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.value === "string" ? data.value : null;
  } catch { return null; }
}

export async function saveDbSetting(key: string, value: string): Promise<void> {
  await fetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export async function fetchCurrentAssetData(): Promise<HoldingItem[]> {
  try { return await fetchBaseAssetHoldings(); } catch { return []; }
}

export async function fetchForecastTrades(): Promise<ForecastTrade[]> {
  const res = await fetch("/api/asset-forecast/trades");
  if (!res.ok) throw new Error("Không đọc được forecast trades.");
  return res.json();
}

export async function fetchFreeCashRows(): Promise<FreeCashRow[]> {
  try {
    const dbRes = await fetch("/api/income-expense");
    if (dbRes.ok) {
      const dbRows = await dbRes.json() as FreeCashRow[];
      if (dbRows.length > 0) return dbRows;
    }

    const res = await fetch(`/api/excel/sheet?name=${encodeURIComponent(CASHFLOW_SOURCE_SHEET)}`);
    if (!res.ok) return [];
    const data = await res.json();
    const rows: unknown[][] = data?.rows ?? [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    const yearCol = findColIdx(headers, ["year", "năm"]);
    const incomeCol = findColIdx(headers, ["income", "thu nhập", "thu nhap"]);
    const otherIncomeCol = findColIdx(headers, ["other income", "thu nhập khác", "thu nhap khac"]);
    const expenseCol = findColIdx(headers, ["expense", "tiêu dùng", "tieu dung", "tiêu dụng"]);
    const otherExpenseCol = findColIdx(headers, ["other expense", "chi phí khác", "chi phi khac"]);
    const interestCol = findColIdx(headers, ["total interest", "interest", "lãi vay", "lai vay"]);
    if (yearCol < 0 || incomeCol < 0) return [];
    const parsed = rows.slice(1).flatMap((row) => {
      const year = Number(row[yearCol]);
      if (!FORECAST_YEARS.includes(year)) return [];
      const income = parseNum(row[incomeCol]);
      const otherIncome = otherIncomeCol >= 0 ? parseNum(row[otherIncomeCol]) : 0;
      const expense = Math.abs(expenseCol >= 0 ? parseNum(row[expenseCol]) : 0);
      const otherExpense = Math.abs(otherExpenseCol >= 0 ? parseNum(row[otherExpenseCol]) : 0);
      const totalInterest = Math.abs(interestCol >= 0 ? parseNum(row[interestCol]) : 0);
      const totalIncome = income + otherIncome;
      const totalExpense = expense + otherExpense + totalInterest;
      return [{ year, income, otherIncome, expense, otherExpense, totalInterest, totalIncome, totalExpense, freeCash: totalIncome - totalExpense }];
    });
    if (parsed.length > 0) {
      const imported = await saveIncomeExpenseRows(parsed, "import").catch(() => []);
      if (imported.length > 0) return imported;
    }
    return parsed;
  } catch { return []; }
}

export async function fetchIncomeExpenseCashflowData(year = new Date().getFullYear()): Promise<CashflowData | null> {
  const rows = await fetchFreeCashRows();
  const row =
    rows.find((item) => item.year === year) ??
    rows.findLast((item) => item.year <= year) ??
    rows[0];

  if (!row) return null;

  const income = row.income + row.otherIncome;
  const expense = row.expense + row.otherExpense;
  const savings = income - expense;

  return {
    year: row.year,
    income,
    expense,
    interest: row.totalInterest,
    savingsRate: income > 0 ? savings / income : null,
    interestBurden: income > 0 ? row.totalInterest / income : null,
  };
}

export async function saveIncomeExpenseRows(rows: FreeCashRow[], mode: "replace" | "import" = "replace"): Promise<FreeCashRow[]> {
  const res = await fetch(`/api/income-expense${mode === "import" ? "/import" : ""}`, {
    method: mode === "import" ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: rows.map((row) => ({
        year: row.year,
        income: row.income,
        otherIncome: row.otherIncome,
        expense: row.expense,
        otherExpense: row.otherExpense,
        totalInterest: row.totalInterest,
      })),
    }),
  });
  if (!res.ok) throw new Error("Không lưu được income/expense.");
  return res.json();
}

function getTradeInvestmentType(trade: Pick<ForecastTrade, "assetType" | "symbol">): InvestType | null {
  const at = trade.assetType.trim().toLowerCase();
  if (isInvestType(at)) return at;
  const sym = trade.symbol.trim().toLowerCase();
  if (isInvestType(sym)) return sym;
  return INVEST_TYPES.find((t) => TYPE_LABELS[t].toLowerCase() === sym) ?? null;
}

export type ForecastTotalsInput = {
  currentAssetRows: HoldingItem[];
  freeCashRows: FreeCashRow[];
  forecastTrades: ForecastTrade[];
  allocationRatios: Record<InvestType, number>;
  investmentReturnRates: Record<InvestType, number>;
  assetReturnRates: Record<string, number>;
};

export type ForecastYearTotal = { year: number; totalEnd: number; investmentEnd: number; endYearFreeCash: number };

export function computeForecastTotals({
  currentAssetRows, freeCashRows, forecastTrades,
  allocationRatios, investmentReturnRates, assetReturnRates,
}: ForecastTotalsInput): ForecastYearTotal[] {
  // --- investment start values ---
  const investmentValues = INVEST_TYPES.reduce<Record<InvestType, number>>((acc, t) => {
    const grouped = currentAssetRows
      .filter((h) => !isUnallocatedFreeCash(h) && getInvestmentType(h) === t)
      .reduce((s, h) => s + (h.currentValue ?? 0), 0);
    acc[t] = grouped;
    return acc;
  }, {} as Record<InvestType, number>);

  // --- fixed asset start values ---
  const fixedValues = currentAssetRows
    .filter((h) => !isUnallocatedFreeCash(h) && !getInvestmentType(h))
    .map((h) => ({
      key: assetReturnKey(h),
      startValue: h.currentValue ?? 0,
      returnRate: assetReturnRates[assetReturnKey(h)] ?? 0,
    }));

  // --- trade maps ---
  const tradeCashByYear = new Map<number, number>();
  const fixedSellByYearKey = new Map<string, number>();
  const fixedBuyByYearKey = new Map<string, number>();
  for (const trade of forecastTrades) {
    if (getTradeInvestmentType(trade)) continue;
    const k = `${trade.year}::${fixedTradeKey(trade.assetType, trade.symbol)}`;
    if (trade.side === "sell") {
      tradeCashByYear.set(trade.year, (tradeCashByYear.get(trade.year) ?? 0) + trade.amount);
      fixedSellByYearKey.set(k, (fixedSellByYearKey.get(k) ?? 0) + trade.amount);
    } else {
      const cashOut = trade.amount * (1 - Math.max(0, Math.min(1, trade.loanRatio ?? 0)));
      tradeCashByYear.set(trade.year, (tradeCashByYear.get(trade.year) ?? 0) - cashOut);
      fixedBuyByYearKey.set(k, (fixedBuyByYearKey.get(k) ?? 0) + trade.amount);
      if (!fixedValues.some((row) => row.key === fixedTradeKey(trade.assetType, trade.symbol))) {
        fixedValues.push({
          key: fixedTradeKey(trade.assetType, trade.symbol),
          startValue: 0,
          returnRate: assetReturnRates[fixedTradeKey(trade.assetType, trade.symbol)] ?? 0,
        });
      }
    }
  }

  // --- allocation rows ---
  const allocationFreeCash = new Map<number, number>();
  allocationFreeCash.set(2026, INITIAL_2026_FREE_CASH);
  for (const row of freeCashRows) {
    const yr = row.year + 1;
    if (FORECAST_YEARS.includes(yr)) {
      allocationFreeCash.set(yr, row.freeCash + (tradeCashByYear.get(row.year) ?? 0));
    }
  }
  const baseFreeCashByYear = new Map(freeCashRows.map((r) => [r.year, r.freeCash]));

  return FORECAST_YEARS.map((forecastYear) => {
    const freeCash = allocationFreeCash.get(forecastYear) ?? 0;

    let investmentEnd = 0;
    for (const type of INVEST_TYPES) {
      const startValue = investmentValues[type] ?? 0;
      const allocationValue = freeCash * (allocationRatios[type] ?? 0);
      const valueBeforeReturn = startValue + allocationValue;
      const endValue = valueBeforeReturn * (1 + (investmentReturnRates[type] ?? 0));
      investmentValues[type] = endValue;
      investmentEnd += endValue;
    }

    let fixedEnd = 0;
    for (const row of fixedValues) {
      const sellAmount = fixedSellByYearKey.get(`${forecastYear}::${row.key}`) ?? 0;
      const buyAmount = fixedBuyByYearKey.get(`${forecastYear}::${row.key}`) ?? 0;
      const effectiveSell = Math.min(Math.max(0, row.startValue), sellAmount);
      const endValue = Math.max(0, row.startValue + buyAmount - effectiveSell) * (1 + row.returnRate);
      row.startValue = endValue;
      fixedEnd += endValue;
    }

    const endYearFreeCash = (baseFreeCashByYear.get(forecastYear) ?? 0) + (tradeCashByYear.get(forecastYear) ?? 0);
    return { year: forecastYear, totalEnd: investmentEnd + fixedEnd + endYearFreeCash, investmentEnd, endYearFreeCash };
  });
}
