import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import AllocationChart from "@/pages/assets/AllocationChart";
import AssetsHeader from "@/pages/assets/AssetsHeader";
import HoldingsTable from "@/pages/assets/HoldingsTable";
import PerformanceChart from "@/pages/assets/PerformanceChart";
import PortfolioSummaryCard from "@/pages/assets/PortfolioSummaryCard";
import type { ChartPoint, HoldingItem, SnapshotRange, SortOrder } from "@/pages/assets/types";
import { formatTypeLabel, formatVND, formatVNDFull } from "@/pages/assets/utils";
import { formatPercent } from "@/pages/assets/utils";
import { fetchWealthAllocationHoldings, fetchWealthAllocationSummaryHoldings } from "@/pages/wealthAllocationData";
import { fetchForecastTrades } from "@/lib/asset-forecast";
import { buildForecastLoanEventsWithTradeSettlements, fetchForecastLoanEvents, fetchForecastLoans, getForecastDebtForYear } from "@/lib/forecast-loans";
import { getTradeNetAmount, type TradeOrder } from "@/pages/assets/TradeOrdersTable";

const CASH_RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");
type CashFlow = { kind: string; amount: number; occurredAt: string };

function calcCashCostBasis(orders: TradeOrder[], cashCostOfCapital: number, cashFlows: CashFlow[]) {
  const totalBuyFromCash = orders.reduce((s, o) => {
    if (o.side !== "buy" || o.status !== "applied") return s;
    if (o.fundingSource.trim().toUpperCase() !== "CASH") return s;
    return s + getTradeNetAmount(o);
  }, 0);
  const netExternal = cashFlows.reduce((s, f) => {
    const at = new Date(f.occurredAt);
    if (at < CASH_RETURN_INITIAL_AT || at > new Date()) return s;
    const k = f.kind.trim().toLowerCase();
    if (k === "deposit" || k === "contribution") return s + f.amount;
    if (k === "withdrawal") return s - f.amount;
    return s;
  }, 0);
  return cashCostOfCapital - totalBuyFromCash + netExternal;
}
export default function WealthAllocationPage() {
  const [, navigate] = useLocation();
  const [snapshotRange, setSnapshotRange] = useState<SnapshotRange>("1m");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [holdingsCollapsed, setHoldingsCollapsed] = useState<boolean>(
    () => localStorage.getItem("wealth_holdings_collapsed") !== "0"
  );
  const [filterType, setFilterType] = useState<string>("all");
  const [showQtyCol, setShowQtyCol] = useState<boolean>(() => localStorage.getItem("wealth_col_qty") === "1");
  const [showPriceCol, setShowPriceCol] = useState<boolean>(() => localStorage.getItem("wealth_col_price") === "1");
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [allocationHoldings, setAllocationHoldings] = useState<HoldingItem[]>([]);
  const [debt, setDebt] = useState<number>(0);
  const [tradeOrders, setTradeOrders] = useState<TradeOrder[]>([]);
  const [cashFlows, setCashFlows] = useState<CashFlow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWealthAllocation = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [wealthHoldings, summaryHoldings, totalAssetData, forecastTrades, orders, flows] = await Promise.all([
        fetchWealthAllocationHoldings(),
        fetchWealthAllocationSummaryHoldings(),
        Promise.all([fetchForecastLoans(), fetchForecastLoanEvents()]),
        fetchForecastTrades(),
        fetch("/api/transactions").then((r) => r.ok ? r.json() : []).catch(() => []),
        fetch("/api/portfolio/cash-flows").then((r) => r.ok ? r.json() : []).catch(() => []),
      ]);
      setHoldings(wealthHoldings);
      setAllocationHoldings(summaryHoldings);
      setTradeOrders(orders as TradeOrder[]);
      setCashFlows(flows as CashFlow[]);
      setDebt(getForecastDebtForYear(
        totalAssetData[0],
        buildForecastLoanEventsWithTradeSettlements(totalAssetData[0], totalAssetData[1], forecastTrades)
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load wealth allocation.");
    } finally {
      setIsLoading(false);
    }
  }, []);


  useEffect(() => {
    loadWealthAllocation();
  }, [loadWealthAllocation]);

  const totalValue = useMemo(
    () => allocationHoldings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [allocationHoldings]
  );

  // Auto-save live total to DB whenever wealth page finishes loading
  useEffect(() => {
    if (isLoading || totalValue <= 0) return;
    const financialAssets = allocationHoldings.find((h) => h.type === "financial")?.currentValue ?? 0;
    fetch("/api/settings/portfolio_live_total", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: JSON.stringify({
          total_assets: Math.round(totalValue),
          financial_assets: Math.round(financialAssets),
          debt: Math.round(debt),
          net_worth: Math.round(totalValue - debt),
          updated_at: new Date().toISOString(),
        }),
      }),
    }).catch(() => {});
  }, [isLoading, totalValue, debt, allocationHoldings]);

  const sortedHoldings = useMemo(() => {
    if (sortOrder === "none") return holdings;
    return [...holdings].sort((a, b) => {
      const aValue = a.currentValue ?? 0;
      const bValue = b.currentValue ?? 0;
      return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
    });
  }, [holdings, sortOrder]);

  const availableTypes = useMemo(
    () => [...new Set(holdings.map((holding) => holding.type.toLowerCase()))].sort(),
    [holdings]
  );

  const filteredHoldings = useMemo(
    () => (filterType === "all" ? sortedHoldings : sortedHoldings.filter((holding) => holding.type.toLowerCase() === filterType)),
    [filterType, sortedHoldings]
  );

  const cashAdjustedCost = useMemo(() => {
    const cashHolding = holdings.find((h) => h.type.toLowerCase() === "cash");
    if (!cashHolding || cashHolding.costOfCapital == null) return null;
    return calcCashCostBasis(tradeOrders, cashHolding.costOfCapital, cashFlows);
  }, [holdings, tradeOrders, cashFlows]);

  const filteredTotal = useMemo(
    () => filteredHoldings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [filteredHoldings]
  );

  const chartData: ChartPoint[] = [];

  const formatMoney = (value: number | null | undefined, full = false) =>
    full ? formatVNDFull(value) : formatVND(value);

  const sortLabel =
    sortOrder === "desc" ? "↓ High → Low" : sortOrder === "asc" ? "↑ Low → High" : "Sort";

  const cycleSortOrder = () => {
    setSortOrder((previous) => {
      if (previous === "none") return "desc";
      if (previous === "desc") return "asc";
      return "none";
    });
  };

  const toggleHoldingsCollapsed = () => {
    const next = !holdingsCollapsed;
    setHoldingsCollapsed(next);
    localStorage.setItem("wealth_holdings_collapsed", next ? "1" : "0");
  };

  const toggleQtyCol = () => {
    const value = !showQtyCol;
    setShowQtyCol(value);
    localStorage.setItem("wealth_col_qty", value ? "1" : "0");
  };

  const togglePriceCol = () => {
    const value = !showPriceCol;
    setShowPriceCol(value);
    localStorage.setItem("wealth_col_price", value ? "1" : "0");
  };

  const handleExportCSV = () => {
    if (!holdings.length) return;
    const formatNumber = (value: number) => value.toLocaleString("vi-VN");
    const header = ["asset", "type", "current_value"];
    const rows = holdings.map((holding) => [
      holding.symbol,
      formatTypeLabel(holding.type),
      holding.currentValue != null ? formatNumber(Math.round(holding.currentValue)) : "",
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wealth-allocation-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const netAsset = totalValue - debt;

  const totalPnl = useMemo(() => {
    return holdings.reduce((sum, h) => {
      const isCash = h.type.toLowerCase() === "cash";
      const cost = isCash
        ? (cashAdjustedCost ?? h.costOfCapital ?? 0)
        : (h.costBasisRemaining ?? h.costOfCapital ?? 0);
      const unrealized = (h.currentValue ?? 0) - cost;
      const realized = h.realizedPnl ?? (h as { interest?: number }).interest ?? 0;
      return sum + unrealized + realized;
    }, 0);
  }, [holdings, cashAdjustedCost]);

  const totalCost = useMemo(() => {
    return holdings.reduce((sum, h) => {
      const isCash = h.type.toLowerCase() === "cash";
      return sum + (isCash ? (cashAdjustedCost ?? h.costOfCapital ?? 0) : (h.costBasisRemaining ?? h.costOfCapital ?? 0));
    }, 0);
  }, [holdings, cashAdjustedCost]);

  const handleOpenAssetType = (type: string) => {
    if (type === "financial") {
      navigate("/assets/type/financial");
      return;
    }
    if (["cash", "stock", "gold", "fund", "crypto"].includes(type)) {
      navigate(`/assets/type/${encodeURIComponent(type)}`);
      return;
    }
    navigate(`/wealth-allocation/type/${encodeURIComponent(type)}`);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AssetsHeader
        title="WEALTH ALLOCATION"
        hasHoldings={holdings.length > 0}
        onExport={handleExportCSV}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        {error ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">{error}</div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : (
          <>
            {/* ── Tổng quan tài sản ─────────────────────────────────── */}
            <PortfolioSummaryCard
              title="Tổng tài sản"
              totalValueLabel={formatMoney(totalValue, true)}
              hideValues={false}
              onToggleHideValues={() => {}}
              metrics={[
                {
                  label: "P/L",
                  value: formatVNDFull(totalPnl),
                  tone: totalPnl >= 0 ? "positive" : "negative",
                },
                {
                  label: "P/L %",
                  value: formatPercent(totalCost > 0 ? totalPnl / totalCost : null),
                  tone: totalPnl >= 0 ? "positive" : "negative",
                },
                {
                  label: "Nợ",
                  value: formatVNDFull(debt),
                  tone: debt > 0 ? "negative" : "neutral",
                },
                {
                  label: "Tài sản ròng",
                  value: formatVNDFull(netAsset),
                  tone: netAsset >= 0 ? "positive" : "negative",
                },
              ]}
            />


            {(totalValue > 0 || holdings.length > 0) && (
              <div className="grid lg:grid-cols-2 gap-4">
                {totalValue > 0 && (
                  <AllocationChart
                    holdings={allocationHoldings}
                    totalValue={totalValue}
                    onTypeSelect={handleOpenAssetType}
                    showTargets
                    targetsSettingKey="wealth_allocation_targets"
                  />
                )}
                {holdings.length > 0 && (
                  <PerformanceChart
                    title="Performance"
                    chartData={chartData}
                    hideValues={false}
                    selectedRange={snapshotRange}
                    onRangeChange={setSnapshotRange}
                    emptyMessage="No wealth history yet."
                  />
                )}
              </div>
            )}

            <HoldingsTable
              holdings={holdings}
              filteredHoldings={filteredHoldings}
              totalValue={totalValue}
              filteredTotal={filteredTotal}
              filterType={filterType}
              availableTypes={availableTypes}
              sortOrder={sortOrder}
              sortLabel={sortLabel}
              holdingsCollapsed={holdingsCollapsed}
              showQtyCol={showQtyCol}
              showPriceCol={showPriceCol}
              showCostOfCapitalCol
              showReturnCols
              cashAdjustedCost={cashAdjustedCost}
              formatMoney={formatMoney}
              onToggleHoldingsCollapsed={toggleHoldingsCollapsed}
              onToggleQtyCol={toggleQtyCol}
              onTogglePriceCol={togglePriceCol}
              onFilterTypeChange={setFilterType}
              onCycleSortOrder={cycleSortOrder}
              readOnly
            />
          </>
        )}
      </main>
    </div>
  );
}
