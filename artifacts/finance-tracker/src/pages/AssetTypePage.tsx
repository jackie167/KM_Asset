import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { usePortfolioData } from "@/hooks/use-portfolio";
import AllocationChart from "@/pages/assets/AllocationChart";
import HoldingsTable from "@/pages/assets/HoldingsTable";
import PerformanceChart from "@/pages/assets/PerformanceChart";
import PortfolioSummaryCard from "@/pages/assets/PortfolioSummaryCard";
import type { ChartPoint, HoldingItem, SnapshotRange, SortOrder } from "@/pages/assets/types";
import { deriveInvestmentGroup, formatVND, formatVNDFull, formatTypeLabel } from "@/pages/assets/utils";

type RouteParams = {
  type: string;
};

export default function AssetTypePage() {
  const [, params] = useRoute<RouteParams>("/assets/type/:type");
  const [, navigate] = useLocation();
  const [snapshotRange, setSnapshotRange] = useState<SnapshotRange>("1m");
  const { summary, snapshots, holdings: holdingsFromApi, isLoading, isError, error } = usePortfolioData(snapshotRange);
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [holdingsCollapsed, setHoldingsCollapsed] = useState<boolean>(
    () => localStorage.getItem("holdings_collapsed") !== "0"
  );
  const [hideValues, setHideValues] = useState<boolean>(() => localStorage.getItem("hide_values") === "1");
  const [showQtyCol, setShowQtyCol] = useState<boolean>(() => localStorage.getItem("col_sl") !== "0");
  const [showPriceCol, setShowPriceCol] = useState<boolean>(() => localStorage.getItem("col_gia") !== "0");
  const [showCostOfCapitalCol, setShowCostOfCapitalCol] = useState<boolean>(
    () => localStorage.getItem("col_cost_of_capital") !== "0"
  );

  const totalPortfolioQuery = useQuery({
    queryKey: ["settings", "portfolio_live_total"],
    queryFn: async () => {
      const res = await fetch("/api/settings/portfolio_live_total");
      if (!res.ok) return null;
      const data = await res.json();
      const v = parseFloat(data.value);
      return isNaN(v) ? null : v;
    },
    enabled: true,
  });
  const totalPortfolioValue = totalPortfolioQuery.data ?? undefined;

  const normalizedType = (params?.type ?? "").toLowerCase();
  const isInvestmentGroupPage = normalizedType === "financial" || normalizedType === "real_estate";
  const holdings: HoldingItem[] = (summary?.holdings ?? holdingsFromApi) as HoldingItem[];
  const typeHoldings = useMemo(
    () => holdings.filter((holding) => {
      const group = holding.investmentGroup ?? deriveInvestmentGroup(holding.type);
      return isInvestmentGroupPage ? group.toLowerCase() === normalizedType : holding.type.toLowerCase() === normalizedType;
    }),
    [holdings, isInvestmentGroupPage, normalizedType]
  );

  const sortedHoldings = useMemo(() => {
    if (sortOrder === "none") return typeHoldings;
    return [...typeHoldings].sort((a, b) => {
      const aValue = a.currentValue ?? 0;
      const bValue = b.currentValue ?? 0;
      return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
    });
  }, [sortOrder, typeHoldings]);

  const totalValue = useMemo(
    () => typeHoldings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [typeHoldings]
  );

  const chartData = useMemo(() => {
    const points = [...(snapshots || [])]
      .sort((a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime())
      .map((snapshot) => {
        const value = isInvestmentGroupPage
          ? Object.entries(snapshot.typeValues ?? {}).reduce((sum, [type, typeValue]) => {
              return deriveInvestmentGroup(type) === normalizedType ? sum + typeValue : sum;
            }, 0)
          : snapshot.typeValues?.[normalizedType] ??
          (normalizedType === "stock"
            ? snapshot.stockValue
            : normalizedType === "gold"
              ? snapshot.goldValue
              : null);

        if (value == null) return null;

        return {
          date: format(new Date(snapshot.snapshotAt), "dd/MM"),
          totalValue: value,
          stockValue: 0,
          goldValue: 0,
        } satisfies ChartPoint;
      })
      .filter((point): point is ChartPoint => point !== null);

    return points;
  }, [isInvestmentGroupPage, normalizedType, snapshots]);

  const supportsHistoricalChart = typeHoldings.length > 0;
  const typeLabel = normalizedType ? formatTypeLabel(normalizedType) : "Asset Type";
  const lastUpdated = summary?.lastUpdated;

  const formatMoney = (value: number | null | undefined, full = false) =>
    hideValues ? "****" : full ? formatVNDFull(value) : formatVND(value);

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
    localStorage.setItem("holdings_collapsed", next ? "1" : "0");
  };

  const toggleHideValues = () => {
    const next = !hideValues;
    setHideValues(next);
    localStorage.setItem("hide_values", next ? "1" : "0");
  };

  const toggleQtyCol = () => {
    const value = !showQtyCol;
    setShowQtyCol(value);
    localStorage.setItem("col_sl", value ? "1" : "0");
  };

  const togglePriceCol = () => {
    const value = !showPriceCol;
    setShowPriceCol(value);
    localStorage.setItem("col_gia", value ? "1" : "0");
  };

  const toggleCostOfCapitalCol = () => {
    const value = !showCostOfCapitalCol;
    setShowCostOfCapitalCol(value);
    localStorage.setItem("col_cost_of_capital", value ? "1" : "0");
  };



  const handleOpenDetailType = (type: string) => {
    navigate(`/assets/type/${encodeURIComponent(type)}`);
  };

  const sortLabel =
    sortOrder === "desc" ? "↓ High → Low" : sortOrder === "asc" ? "↑ Low → High" : "Sort";

  const isMissingType = !isLoading && !isError && normalizedType !== "" && typeHoldings.length === 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-3 sm:px-4 md:px-6 py-3 sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="md:max-w-5xl xl:max-w-7xl mx-auto space-y-3">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight">{typeLabel}</h1>
            {lastUpdated && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                Updated: {format(new Date(lastUpdated), "HH:mm dd/MM/yyyy")}
              </p>
            )}
          </div>

        </div>
      </header>

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        {isError ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unable to load data."}
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : isMissingType ? (
          <div className="rounded-lg border bg-card p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">This asset type was not found in the portfolio.</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/assets")}>
              Back to Investment
            </Button>
          </div>
        ) : (
          <>
            <PortfolioSummaryCard
              title={typeLabel}
              totalValueLabel={formatMoney(totalValue, true)}
              hideValues={hideValues}
              onToggleHideValues={toggleHideValues}
            />

            {isInvestmentGroupPage ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {typeHoldings.length > 0 && (
                  <AllocationChart
                    holdings={typeHoldings}
                    totalValue={totalValue}
                    title="Detail Allocation"
                    groupBy={normalizedType === "real_estate" ? (holding) => holding.symbol : undefined}
                    onTypeSelect={normalizedType === "real_estate" ? undefined : handleOpenDetailType}
                    showTargets={normalizedType === "financial"}
                    totalPortfolioValue={normalizedType === "financial" ? totalPortfolioValue : undefined}
                  />
                )}
                <PerformanceChart
                  title="Performance"
                  seriesLabel=""
                  chartData={supportsHistoricalChart ? chartData : []}
                  hideValues={hideValues}
                  selectedRange={snapshotRange}
                  onRangeChange={setSnapshotRange}
                  emptyMessage={
                    supportsHistoricalChart
                      ? "No historical data yet."
                      : "No separate history is available for this asset type yet."
                  }
                />
              </div>
            ) : (
              <PerformanceChart
                title="Performance"
                seriesLabel=""
                chartData={supportsHistoricalChart ? chartData : []}
                hideValues={hideValues}
                selectedRange={snapshotRange}
                onRangeChange={setSnapshotRange}
                emptyMessage={
                  supportsHistoricalChart
                    ? "No historical data yet."
                    : "No separate history is available for this asset type yet."
                }
              />
            )}

            <HoldingsTable
              holdings={typeHoldings}
              filteredHoldings={sortedHoldings}
              totalValue={totalValue}
              filteredTotal={totalValue}
              filterType="all"
              availableTypes={[]}
              sortOrder={sortOrder}
              sortLabel={sortLabel}
              holdingsCollapsed={holdingsCollapsed}
              showQtyCol={showQtyCol}
              showPriceCol={showPriceCol}
              showCostOfCapitalCol={showCostOfCapitalCol}
              formatMoney={formatMoney}
              onToggleHoldingsCollapsed={toggleHoldingsCollapsed}
              onToggleQtyCol={toggleQtyCol}
              onTogglePriceCol={togglePriceCol}
              onToggleCostOfCapitalCol={toggleCostOfCapitalCol}
              onFilterTypeChange={() => {}}
              onCycleSortOrder={cycleSortOrder}
              readOnly
            />
          </>
        )}
      </main>
    </div>
  );
}
