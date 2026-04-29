import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import PageHeader from "@/pages/PageHeader";
import { Card } from "@/components/ui/card";
import { formatTypeLabel, formatVND, formatVNDFull } from "@/pages/assets/utils";
import { CASHFLOW_SOURCE_SHEET, findColIdx, parseNum, fetchTotalAssetRows, type TotalAssetRow } from "@/lib/excel-sheets";
import { CURRENT_ASSET_SHEET, parseCurrentAssetRows } from "@/pages/wealthAllocationData";
import type { HoldingItem } from "@/pages/assets/types";

const FORECAST_YEARS = [2026, 2027, 2028, 2029, 2030];
const INITIAL_2026_FREE_CASH = 7_370_845_000;
const INVEST_TYPES = ["cash", "stock", "gold", "fund", "crypto"] as const;
type InvestType = typeof INVEST_TYPES[number];

const DEFAULT_RATES: Record<InvestType, number> = { cash: 4, stock: 15, gold: 8, fund: 9, crypto: 15 };
const TYPE_LABELS: Record<InvestType, string> = { cash: "Cash", stock: "Stock", gold: "Gold", fund: "Fund", crypto: "Crypto" };
const DEFAULT_ALLOCATION_RATIOS: Record<InvestType, number> = { cash: 10, gold: 30, fund: 10, crypto: 10, stock: 40 };
const SYMBOL_TYPE_MAP: Record<string, InvestType> = { cash: "cash", stock: "stock", gold: "gold", fund: "fund", crypto: "crypto" };

function isInvestType(value: string): value is InvestType {
  return INVEST_TYPES.includes(value as InvestType);
}

function getInvestmentType(holding: HoldingItem): InvestType | null {
  const type = holding.type.toLowerCase();
  if (isInvestType(type)) return type;
  return SYMBOL_TYPE_MAP[holding.symbol.toLowerCase()] ?? null;
}

function isUnallocatedFreeCash(holding: HoldingItem) {
  const normalizedSymbol = holding.symbol.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return getInvestmentType(holding) === "cash" || normalizedSymbol === "freecash";
}

type FreeCashRow = {
  year: number;
  income: number;
  otherIncome: number;
  expense: number;
  otherExpense: number;
  totalInterest: number;
  totalIncome: number;
  totalExpense: number;
  freeCash: number;
};

const LS = {
  get: (key: string, fallback: string) => localStorage.getItem(key) ?? fallback,
  set: (key: string, value: string) => localStorage.setItem(key, value),
};

function readJsonRecord(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function assetReturnKey(holding: HoldingItem) {
  return `${holding.type.trim().toLowerCase()}::${holding.symbol.trim().toUpperCase()}`;
}

async function fetchCurrentAssetData(): Promise<HoldingItem[]> {
  try {
    const res = await fetch(`/api/excel/sheet?name=${encodeURIComponent(CURRENT_ASSET_SHEET)}`);
    if (!res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return parseCurrentAssetRows(rows);
  } catch {
    return [];
  }
}

async function fetchFreeCashRows(): Promise<FreeCashRow[]> {
  try {
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

    return rows.slice(1).flatMap((row) => {
      const year = Number(row[yearCol]);
      if (!FORECAST_YEARS.includes(year)) return [];

      const income = parseNum(row[incomeCol]);
      const otherIncome = otherIncomeCol >= 0 ? parseNum(row[otherIncomeCol]) : 0;
      const expense = Math.abs(expenseCol >= 0 ? parseNum(row[expenseCol]) : 0);
      const otherExpense = Math.abs(otherExpenseCol >= 0 ? parseNum(row[otherExpenseCol]) : 0);
      const totalInterest = Math.abs(interestCol >= 0 ? parseNum(row[interestCol]) : 0);
      const totalIncome = income + otherIncome;
      const totalExpense = expense + otherExpense + totalInterest;

      return [{
        year,
        income,
        otherIncome,
        expense,
        otherExpense,
        totalInterest,
        totalIncome,
        totalExpense,
        freeCash: totalIncome - totalExpense,
      }];
    });
  } catch {
    return [];
  }
}

function parseInputNumber(value: string): number {
  const normalized = value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePercentInput(value: string): number {
  const cleaned = value.trim().replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercentValue(value: number) {
  return `${value.toFixed(2)}%`;
}

export default function AssetForecastPage() {
  const returnRateInput = LS.get("asset_forecast_return_rate", "8");
  const [assetReturnInputs, setAssetReturnInputs] = useState(() => readJsonRecord("asset_forecast_asset_returns"));
  const [allocationInputs, setAllocationInputs] = useState(() => readJsonRecord("asset_forecast_allocation_ratios"));
  const [investmentReturnInputs, setInvestmentReturnInputs] = useState<Record<string, string>>(() => {
    const stored = readJsonRecord("asset_forecast_investment_returns");
    return INVEST_TYPES.reduce<Record<string, string>>((acc, type) => {
      acc[type] = stored[type] ?? String(DEFAULT_RATES[type]);
      return acc;
    }, {});
  });

  const currentAssetQuery = useQuery({ queryKey: ["asset-forecast-current-asset"], queryFn: fetchCurrentAssetData });
  const freeCashQuery = useQuery({ queryKey: ["asset-forecast-free-cash-rows"], queryFn: fetchFreeCashRows });
  const loanRowsQuery = useQuery({ queryKey: ["excel-total-asset-rows"], queryFn: fetchTotalAssetRows });

  const currentAssetRows = useMemo(() => currentAssetQuery.data ?? [], [currentAssetQuery.data]);
  const freeCashRows = useMemo(() => freeCashQuery.data ?? [], [freeCashQuery.data]);

  const allocationRatios = useMemo(() => {
    return INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
      const input = allocationInputs[type] ?? String(DEFAULT_ALLOCATION_RATIOS[type]);
      acc[type] = parseInputNumber(input) / 100;
      return acc;
    }, {} as Record<InvestType, number>);
  }, [allocationInputs]);

  const investmentStartRows = useMemo(() => {
    const grouped = new Map<InvestType, number>();
    for (const holding of currentAssetRows) {
      if (isUnallocatedFreeCash(holding)) continue;
      const type = getInvestmentType(holding);
      if (!type) continue;
      const value = holding.currentValue ?? 0;
      grouped.set(type, (grouped.get(type) ?? 0) + value);
    }

    return INVEST_TYPES.map((type) => ({
      type,
      label: TYPE_LABELS[type],
      startValue: grouped.get(type) ?? 0,
      returnRate: parsePercentInput(investmentReturnInputs[type] ?? String(DEFAULT_RATES[type])) / 100,
    })).filter((row) => row.startValue !== 0 || allocationRatios[row.type] !== 0);
  }, [allocationRatios, currentAssetRows, investmentReturnInputs]);

  const fixedAssetRows = useMemo(() => {
    return currentAssetRows.flatMap((holding) => {
      if (isUnallocatedFreeCash(holding)) return [];
      if (getInvestmentType(holding)) return [];
      const startValue = holding.currentValue ?? 0;
      const returnInput = assetReturnInputs[assetReturnKey(holding)] ?? returnRateInput;
      return [{
        key: assetReturnKey(holding),
        symbol: holding.symbol,
        type: holding.type,
        startValue,
        returnRate: parsePercentInput(returnInput) / 100,
        returnInput,
        holding,
      }];
    });
  }, [assetReturnInputs, currentAssetRows, returnRateInput]);

  const allocationRows = useMemo(() => {
    const rows = new Map<number, number>();
    rows.set(2026, INITIAL_2026_FREE_CASH);
    for (const row of freeCashRows) {
      const allocationYear = row.year + 1;
      if (FORECAST_YEARS.includes(allocationYear)) rows.set(allocationYear, row.freeCash);
    }
    return FORECAST_YEARS.map((year) => ({
      year,
      freeCash: rows.get(year) ?? 0,
      byType: INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
        acc[type] = (rows.get(year) ?? 0) * allocationRatios[type];
        return acc;
      }, {} as Record<InvestType, number>),
    }));
  }, [allocationRatios, freeCashRows]);

  const forecastRows = useMemo(() => {
    const investmentValues = INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
      acc[type] = investmentStartRows.find((row) => row.type === type)?.startValue ?? 0;
      return acc;
    }, {} as Record<InvestType, number>);
    const fixedValues = fixedAssetRows.map((row) => ({ ...row }));

    return FORECAST_YEARS.map((forecastYear) => {
      const allocation = allocationRows.find((row) => row.year === forecastYear);
      const investmentDetails = INVEST_TYPES.map((type) => {
        const startValue = investmentValues[type] ?? 0;
        const allocationValue = allocation?.byType[type] ?? 0;
        const valueBeforeReturn = startValue + allocationValue;
        const returnRate = investmentStartRows.find((row) => row.type === type)?.returnRate ?? 0;
        const gain = valueBeforeReturn * returnRate;
        const endValue = valueBeforeReturn + gain;
        investmentValues[type] = endValue;
        return { type, label: TYPE_LABELS[type], startValue, allocationValue, valueBeforeReturn, returnRate, gain, endValue };
      });

      const fixedDetails = fixedValues.map((row) => {
        const startValue = row.startValue;
        const gain = startValue * row.returnRate;
        const endValue = startValue + gain;
        row.startValue = endValue;
        return { ...row, startValue, gain, endValue };
      });

      const investmentStart = investmentDetails.reduce((sum, row) => sum + row.startValue, 0);
      const investmentAllocation = investmentDetails.reduce((sum, row) => sum + row.allocationValue, 0);
      const investmentGain = investmentDetails.reduce((sum, row) => sum + row.gain, 0);
      const investmentEnd = investmentDetails.reduce((sum, row) => sum + row.endValue, 0);
      const fixedStart = fixedDetails.reduce((sum, row) => sum + row.startValue, 0);
      const fixedGain = fixedDetails.reduce((sum, row) => sum + row.gain, 0);
      const fixedEnd = fixedDetails.reduce((sum, row) => sum + row.endValue, 0);
      const totalStart = investmentStart + fixedStart;
      const totalEnd = investmentEnd + fixedEnd;

      return {
        year: forecastYear,
        investmentDetails,
        fixedDetails,
        freeCash: allocation?.freeCash ?? 0,
        investmentStart,
        investmentAllocation,
        investmentBeforeReturn: investmentStart + investmentAllocation,
        investmentGain,
        investmentEnd,
        fixedStart,
        fixedGain,
        fixedEnd,
        totalStart,
        totalEnd,
        totalIncrease: totalEnd - totalStart,
      };
    });
  }, [allocationRows, fixedAssetRows, investmentStartRows]);

  const firstForecast = forecastRows[0];
  const initialFixedTotal = fixedAssetRows.reduce((sum, row) => sum + row.startValue, 0);
  const allocationRatioTotal = INVEST_TYPES.reduce((sum, type) => sum + allocationRatios[type], 0);
  const totalAssetForecastRows = [
    {
      key: "fixed",
      label: "Fixed asset",
      values: FORECAST_YEARS.map((forecastYear) => (
        forecastRows.find((row) => row.year === forecastYear)?.fixedEnd ?? 0
      )),
    },
    ...INVEST_TYPES.map((type) => ({
      key: type,
      label: TYPE_LABELS[type],
      values: FORECAST_YEARS.map((forecastYear) => (
        forecastRows
          .find((row) => row.year === forecastYear)
          ?.investmentDetails.find((detail) => detail.type === type)
          ?.endValue ?? 0
      )),
    })),
  ];
  const totalAssetValues = FORECAST_YEARS.map((_, index) => (
    totalAssetForecastRows.reduce((sum, row) => sum + row.values[index], 0)
  ));
  const totalAssetChartData = FORECAST_YEARS.map((forecastYear, index) => ({
    year: String(forecastYear),
    value: totalAssetValues[index],
  }));

  const saveAllocationInput = (type: InvestType, value: string) => {
    setAllocationInputs((current) => {
      const next = { ...current, [type]: value };
      LS.set("asset_forecast_allocation_ratios", JSON.stringify(next));
      return next;
    });
  };

  const saveInvestmentReturnInput = (type: InvestType, value: string) => {
    setInvestmentReturnInputs((current) => {
      const next = { ...current, [type]: value };
      LS.set("asset_forecast_investment_returns", JSON.stringify(next));
      return next;
    });
  };

  const saveAssetReturnInput = (holding: HoldingItem, value: string) => {
    const key = assetReturnKey(holding);
    setAssetReturnInputs((current) => {
      const next = { ...current, [key]: value };
      LS.set("asset_forecast_asset_returns", JSON.stringify(next));
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Dự báo tài sản"
        subtitle="Ước tính tài sản cuối năm từ tài sản đầu năm, tăng trưởng giả định và free cash"
      />

      <main className="w-full max-w-screen-sm md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-6">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Biểu đồ forecast tài sản</p>
            <p className="text-[10px] text-muted-foreground">2026-2030</p>
          </div>
          <Card className="p-4 md:p-5">
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={totalAssetChartData} margin={{ top: 12, right: 12, left: 10, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="year"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(value: number) => formatVND(value)}
                    width={72}
                  />
                  <Tooltip
                    formatter={(value: number) => [formatVNDFull(value), "Tổng tài sản"]}
                    labelFormatter={(label) => `Năm ${label}`}
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      color: "hsl(var(--foreground))",
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="hsl(160, 84%, 45%)"
                    fill="hsl(160, 84%, 45%)"
                    fillOpacity={0.16}
                    strokeWidth={2}
                    dot={{ r: 3, fill: "hsl(160, 84%, 45%)" }}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Forecast summary</p>
            <p className="text-[10px] text-muted-foreground">Năm sau lấy cuối năm trước làm đầu kỳ</p>
          </div>
          <Card className="p-4 md:p-5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 text-left font-medium">Year</th>
                    <th className="py-2 px-4 text-right font-medium">Investment start</th>
                    <th className="py-2 px-4 text-right font-medium">Free cash allocated</th>
                    <th className="py-2 px-4 text-right font-medium">Investment before return</th>
                    <th className="py-2 px-4 text-right font-medium">Investment gain</th>
                    <th className="py-2 px-4 text-right font-medium">Investment end</th>
                    <th className="py-2 px-4 text-right font-medium">Fixed start</th>
                    <th className="py-2 px-4 text-right font-medium">Fixed gain</th>
                    <th className="py-2 px-4 text-right font-medium">Fixed end</th>
                    <th className="py-2 pl-4 text-right font-medium">Total end</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {forecastRows.map((row) => (
                    <tr key={row.year} className={row.year === 2026 || row.year === 2027 ? "bg-primary/5" : undefined}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.year}</td>
                      <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.investmentStart)}</td>
                      <td className={`py-2 px-4 text-right tabular-nums whitespace-nowrap ${row.investmentAllocation >= 0 ? "text-emerald-400" : "text-red-300"}`}>{formatVNDFull(row.investmentAllocation)}</td>
                      <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.investmentBeforeReturn)}</td>
                      <td className={`py-2 px-4 text-right tabular-nums whitespace-nowrap ${row.investmentGain >= 0 ? "text-emerald-400" : "text-red-300"}`}>{formatVNDFull(row.investmentGain)}</td>
                      <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(row.investmentEnd)}</td>
                      <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.fixedStart)}</td>
                      <td className={`py-2 px-4 text-right tabular-nums whitespace-nowrap ${row.fixedGain >= 0 ? "text-emerald-400" : "text-red-300"}`}>{formatVNDFull(row.fixedGain)}</td>
                      <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(row.fixedEnd)}</td>
                      <td className="py-2 pl-4 text-right tabular-nums font-bold whitespace-nowrap">{formatVNDFull(row.totalEnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Free cash từ sheet {CASHFLOW_SOURCE_SHEET}
            </p>
            <p className="text-[10px] text-muted-foreground">2026-2030</p>
          </div>
          <Card className="p-4 md:p-5">
            {freeCashQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((row) => (
                  <div key={row} className="h-8 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : freeCashRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa đọc được dữ liệu free cash từ sheet {CASHFLOW_SOURCE_SHEET}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4 text-left font-medium">Year</th>
                      <th className="py-2 px-4 text-right font-medium">Income</th>
                      <th className="py-2 px-4 text-right font-medium">Other income</th>
                      <th className="py-2 px-4 text-right font-medium">Expense</th>
                      <th className="py-2 px-4 text-right font-medium">Other expense</th>
                      <th className="py-2 px-4 text-right font-medium">Total interest</th>
                      <th className="py-2 px-4 text-right font-medium">Tổng income</th>
                      <th className="py-2 px-4 text-right font-medium">Tổng chi</th>
                      <th className="py-2 pl-4 text-right font-medium">Free cash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {freeCashRows.map((row) => {
                      return (
                        <tr key={row.year}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.year}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.income)}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.otherIncome)}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.expense)}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.otherExpense)}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(row.totalInterest)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium whitespace-nowrap">{formatVNDFull(row.totalIncome)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium whitespace-nowrap">{formatVNDFull(row.totalExpense)}</td>
                          <td className={`py-2 pl-4 text-right tabular-nums font-semibold whitespace-nowrap ${row.freeCash >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                            {formatVNDFull(row.freeCash)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Phân bổ free cash cho investment
            </p>
            <p className="text-[10px] text-muted-foreground">Cuối 2025 vào 2026, cuối năm N vào N+1</p>
          </div>
          <Card className="p-4 md:p-5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 text-left font-medium">Free cash</th>
                    {INVEST_TYPES.map((type) => (
                      <th key={type} className="py-2 px-4 text-right font-medium">{TYPE_LABELS[type]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  <tr className="bg-muted/20">
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      Ratio
                      <span className={`ml-2 tabular-nums ${Math.abs(allocationRatioTotal - 1) < 0.0001 ? "text-muted-foreground" : "text-amber-300"}`}>
                        {formatPercentValue(allocationRatioTotal * 100)}
                      </span>
                    </td>
                    {INVEST_TYPES.map((type) => (
                      <td key={type} className="py-2 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                          <input
                            value={allocationInputs[type] ?? String(DEFAULT_ALLOCATION_RATIOS[type])}
                            onChange={(event) => saveAllocationInput(type, event.target.value)}
                            inputMode="decimal"
                            className="w-12 bg-transparent text-right text-[11px] tabular-nums outline-none"
                          />
                          <span className="text-[10px] text-muted-foreground">%</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                  {allocationRows.map((row) => (
                    <tr key={`allocation-${row.year}`} className={row.year === 2026 || row.year === 2027 ? "bg-primary/5" : undefined}>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        <span className="font-medium">{row.year}</span>
                        <span className={`ml-3 tabular-nums ${row.freeCash >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                          {formatVNDFull(row.freeCash)}
                        </span>
                      </td>
                      {INVEST_TYPES.map((type) => (
                        <td key={type} className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                          {formatVNDFull(row.byType[type])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Fixed asset từ sheet {CURRENT_ASSET_SHEET}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {fixedAssetRows.length} dòng · tổng {formatVNDFull(initialFixedTotal)}
            </p>
          </div>
          <Card className="p-4 md:p-5">
            {currentAssetQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map((row) => (
                  <div key={row} className="h-8 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : fixedAssetRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa đọc được dữ liệu từ sheet {CURRENT_ASSET_SHEET}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4 text-left font-medium">Asset</th>
                      <th className="w-20 py-2 px-2 text-left font-medium">Type</th>
                      <th className="w-24 py-2 px-2 text-right font-medium">Assumed return</th>
                      <th className="py-2 px-4 text-right font-medium">Đầu 2026</th>
                      <th className="py-2 px-4 text-right font-medium">2026</th>
                      <th className="py-2 px-4 text-right font-medium">2027</th>
                      <th className="py-2 px-4 text-right font-medium">2028</th>
                      <th className="py-2 px-4 text-right font-medium">2029</th>
                      <th className="py-2 pl-4 text-right font-medium">2030</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {fixedAssetRows.map((row) => {
                      const firstYearDetail = firstForecast?.fixedDetails.find((detail) => detail.key === row.key);
                      const end2026 = firstYearDetail?.endValue ?? row.startValue * (1 + row.returnRate);
                      const end2027 = end2026 * (1 + row.returnRate);
                      const end2028 = end2027 * (1 + row.returnRate);
                      const end2029 = end2028 * (1 + row.returnRate);
                      const end2030 = end2029 * (1 + row.returnRate);

                      return (
                        <tr key={row.key}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.symbol}</td>
                          <td className="w-20 py-2 px-2 text-muted-foreground whitespace-normal leading-tight">{formatTypeLabel(row.type)}</td>
                          <td className="w-24 py-2 px-2 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                              <input
                                value={row.returnInput}
                                onChange={(event) => saveAssetReturnInput(row.holding, event.target.value)}
                                inputMode="decimal"
                                className="w-10 bg-transparent text-right text-[11px] tabular-nums outline-none"
                              />
                              <span className="text-[10px] text-muted-foreground">%</span>
                            </div>
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(row.startValue)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(end2026)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(end2027)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(end2028)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(end2029)}</td>
                          <td className="py-2 pl-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(end2030)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border">
                      <td className="pt-3 pr-4 text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
                      <td />
                      <td />
                      <td className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(initialFixedTotal)}</td>
                      <td className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(firstForecast?.fixedEnd ?? initialFixedTotal)}</td>
                      <td className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(forecastRows[1]?.fixedEnd ?? firstForecast?.fixedEnd ?? initialFixedTotal)}</td>
                      <td className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(forecastRows[2]?.fixedEnd ?? forecastRows[1]?.fixedEnd ?? firstForecast?.fixedEnd ?? initialFixedTotal)}</td>
                      <td className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(forecastRows[3]?.fixedEnd ?? forecastRows[2]?.fixedEnd ?? firstForecast?.fixedEnd ?? initialFixedTotal)}</td>
                      <td className="pt-3 pl-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(forecastRows[4]?.fixedEnd ?? forecastRows[3]?.fixedEnd ?? firstForecast?.fixedEnd ?? initialFixedTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Investment forecast 2026-2030</p>
            <p className="text-[10px] text-muted-foreground">Mỗi tài sản chỉ hiển thị đầu năm và cuối năm</p>
          </div>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-xs">
                <thead>
                  <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border/40">
                    <th rowSpan={3} className="py-2 px-4 text-left font-normal align-bottom">Year</th>
                    {(firstForecast?.investmentDetails ?? []).map((row) => (
                      <th key={row.type} colSpan={2} className="py-2 px-4 text-center font-normal">
                        {row.label}
                      </th>
                    ))}
                  </tr>
                  <tr className="text-[9px] text-muted-foreground border-b border-border/40">
                    {(firstForecast?.investmentDetails ?? []).map((row) => (
                      <th key={`${row.type}-return`} colSpan={2} className="py-2 px-4 text-center font-normal">
                        <div className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                          <input
                            value={investmentReturnInputs[row.type] ?? String(DEFAULT_RATES[row.type])}
                            onChange={(event) => saveInvestmentReturnInput(row.type, event.target.value)}
                            inputMode="decimal"
                            className="w-12 bg-transparent text-right text-[11px] tabular-nums outline-none"
                          />
                          <span className="text-[10px] text-muted-foreground">%</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                  <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                    {(firstForecast?.investmentDetails ?? []).map((row) => (
                      <Fragment key={`${row.type}-headers`}>
                        <th key={`${row.type}-start`} className="py-2 px-4 text-right font-normal">Đầu năm</th>
                        <th key={`${row.type}-end`} className="py-2 px-4 text-right font-normal">Cuối năm</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {forecastRows.map((yearRow) => (
                    <tr key={yearRow.year} className={yearRow.year === 2026 || yearRow.year === 2027 ? "bg-primary/5" : undefined}>
                      <td className="py-2.5 px-4 font-medium">{yearRow.year}</td>
                      {yearRow.investmentDetails.map((row) => (
                        <Fragment key={`${yearRow.year}-${row.type}-values`}>
                          <td key={`${row.type}-start`} className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                            {formatVNDFull(row.valueBeforeReturn)}
                          </td>
                          <td key={`${row.type}-end`} className="py-2.5 px-4 text-right tabular-nums font-semibold whitespace-nowrap">
                            {formatVNDFull(row.endValue)}
                          </td>
                        </Fragment>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Tổng tài sản forecast</p>
            <p className="text-[10px] text-muted-foreground">Fixed asset + tài sản tài chính cuối năm</p>
          </div>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead>
                  <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                    <th className="py-2 px-4 text-left font-normal">Tài sản</th>
                    {FORECAST_YEARS.map((forecastYear) => (
                      <th key={forecastYear} className="py-2 px-4 text-right font-normal">{forecastYear}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {totalAssetForecastRows.map((row) => (
                    <tr key={row.key}>
                      <td className="py-2.5 px-4 font-medium whitespace-nowrap">{row.label}</td>
                      {row.values.map((value, index) => (
                        <td key={`${row.key}-${FORECAST_YEARS[index]}`} className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                          {formatVNDFull(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="pt-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
                    {totalAssetValues.map((value, index) => (
                      <td key={`total-${FORECAST_YEARS[index]}`} className="pt-3 px-4 text-right tabular-nums font-bold whitespace-nowrap">
                        {formatVNDFull(value)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </section>

        {/* ── Theo dõi khoản vay ───────────────────────────────────────── */}
        {(() => {
          const rows: TotalAssetRow[] = loanRowsQuery.data ?? [];
          const debtRows = rows.filter((r, i, arr) => r.debt > 0 || (arr[i - 1]?.debt ?? 0) > 0);
          if (!loanRowsQuery.isLoading && debtRows.length === 0) return null;
          return (
            <section className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Theo dõi khoản vay</p>
              <Card className="overflow-hidden">
                {loanRowsQuery.isLoading ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[480px] text-xs">
                      <thead>
                        <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                          <th className="py-2 px-4 text-left font-normal">Năm</th>
                          <th className="py-2 px-4 text-right font-normal">Nợ đầu năm</th>
                          <th className="py-2 px-4 text-right font-normal">Thanh toán</th>
                          <th className="py-2 px-4 text-right font-normal">Nợ cuối năm</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {debtRows.map((row, i, arr) => {
                          const prev = arr[i - 1];
                          const debtStart = prev?.debt ?? null;
                          const payment = debtStart != null ? Math.max(0, debtStart - row.debt) : null;
                          const isCurrentYear = row.year === new Date().getFullYear();
                          return (
                            <tr key={row.year} className={isCurrentYear ? "bg-primary/5" : ""}>
                              <td className={`py-2.5 px-4 font-semibold ${isCurrentYear ? "text-primary" : ""}`}>
                                {row.year}{isCurrentYear && <span className="ml-1.5 text-[9px] text-primary/70 uppercase tracking-wider">hiện tại</span>}
                              </td>
                              <td className="py-2.5 px-4 text-right tabular-nums text-muted-foreground">
                                {debtStart != null ? formatVNDFull(debtStart) : "—"}
                              </td>
                              <td className={`py-2.5 px-4 text-right tabular-nums font-medium ${payment && payment > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                                {payment != null && payment > 0 ? formatVNDFull(payment) : "—"}
                              </td>
                              <td className={`py-2.5 px-4 text-right tabular-nums font-semibold ${row.debt > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                                {row.debt > 0 ? formatVNDFull(row.debt) : "Đã trả hết"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>
          );
        })()}

      </main>
    </div>
  );
}
