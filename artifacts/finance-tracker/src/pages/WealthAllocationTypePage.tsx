import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import AllocationChart from "@/pages/assets/AllocationChart";
import HoldingsTable from "@/pages/assets/HoldingsTable";
import PerformanceChart from "@/pages/assets/PerformanceChart";
import PortfolioSummaryCard from "@/pages/assets/PortfolioSummaryCard";
import type { ChartPoint, HoldingItem, SnapshotRange, SortOrder } from "@/pages/assets/types";
import { formatTypeLabel, formatVND, formatVNDFull } from "@/pages/assets/utils";
import { fetchWealthAllocationHoldings, fetchFinancialDetailHoldings } from "@/pages/wealthAllocationData";

type RouteParams = {
  type: string;
};

export default function WealthAllocationTypePage() {
  const [, params] = useRoute<RouteParams>("/wealth-allocation/type/:type");
  const [, navigate] = useLocation();
  const [snapshotRange, setSnapshotRange] = useState<SnapshotRange>("1m");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [holdingsCollapsed, setHoldingsCollapsed] = useState<boolean>(
    () => localStorage.getItem("wealth_type_holdings_collapsed") !== "0"
  );
  const [hideValues, setHideValues] = useState<boolean>(() => localStorage.getItem("hide_values") === "1");
  const [showQtyCol, setShowQtyCol] = useState<boolean>(() => localStorage.getItem("wealth_col_qty") === "1");
  const [showPriceCol, setShowPriceCol] = useState<boolean>(() => localStorage.getItem("wealth_col_price") === "1");
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedType = decodeURIComponent(params?.type ?? "").toLowerCase();
  const typeLabel = normalizedType ? formatTypeLabel(normalizedType) : "Asset Type";

  const loadHoldings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      let filtered;
      if (normalizedType === "financial") {
        filtered = await fetchFinancialDetailHoldings();
      } else {
        const all = await fetchWealthAllocationHoldings();
        filtered = all.filter((h) => h.type.toLowerCase() === normalizedType);
      }
      setHoldings(filtered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load data.");
    } finally {
      setIsLoading(false);
    }
  }, [normalizedType]);

  useEffect(() => {
    loadHoldings();
  }, [loadHoldings]);

  const typeHoldings = holdings;

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

  const chartData: ChartPoint[] = [];
  const formatMoney = (value: number | null | undefined, full = false) =>
    hideValues ? "****" : full ? formatVNDFull(value) : formatVND(value);

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
    localStorage.setItem("wealth_type_holdings_collapsed", next ? "1" : "0");
  };

  const toggleHideValues = () => {
    const next = !hideValues;
    setHideValues(next);
    localStorage.setItem("hide_values", next ? "1" : "0");
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
    if (!typeHoldings.length) return;
    const formatNumber = (value: number) => value.toLocaleString("vi-VN");
    const header = ["asset", "type", "current_value"];
    const rows = typeHoldings.map((holding) => [
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
    link.download = `wealth-allocation-${normalizedType}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const isMissingType = !isLoading && !error && normalizedType !== "" && typeHoldings.length === 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-3 sm:px-4 md:px-6 py-3 sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="md:max-w-5xl xl:max-w-7xl mx-auto space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight">{typeLabel}</h1>
              <p className="text-xs text-muted-foreground leading-relaxed">Wealth Allocation</p>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <Link href="/" className="hover:text-foreground transition-colors">
                Home
              </Link>
              <Link href="/assets" className="hover:text-foreground transition-colors">
                Investment
              </Link>
              <Link href="/wealth-allocation" className="hover:text-foreground transition-colors">
                Wealth Allocation
              </Link>
              <Link href="/excel" className="hover:text-foreground transition-colors">
                Excel
              </Link>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/wealth-allocation")} className="text-xs h-8">
              ← Back
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!typeHoldings.length} className="text-xs h-8">
              ↓ Export
            </Button>
            <span className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
              Source: Base Assets + Investment
            </span>
          </div>
        </div>
      </header>

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        {error ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">{error}</div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : isMissingType ? (
          <div className="rounded-lg border bg-card p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">This asset type was not found in Wealth Allocation.</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/wealth-allocation")}>
              Back to Wealth Allocation
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

            {(totalValue > 0 || typeHoldings.length > 0) && (
              <div className="grid md:grid-cols-2 gap-4">
                {totalValue > 0 && (
                  <AllocationChart
                    holdings={typeHoldings}
                    totalValue={totalValue}
                  />
                )}
                <PerformanceChart
                  title="Performance"
                  seriesLabel=""
                  chartData={chartData}
                  hideValues={hideValues}
                  selectedRange={snapshotRange}
                  onRangeChange={setSnapshotRange}
                  emptyMessage="No wealth history yet."
                />
              </div>
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
              formatMoney={formatMoney}
              onToggleHoldingsCollapsed={toggleHoldingsCollapsed}
              onToggleQtyCol={toggleQtyCol}
              onTogglePriceCol={togglePriceCol}
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
