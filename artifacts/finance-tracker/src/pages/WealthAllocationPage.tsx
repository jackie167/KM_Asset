import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import AllocationChart from "@/pages/assets/AllocationChart";
import AssetsHeader from "@/pages/assets/AssetsHeader";
import HoldingsTable from "@/pages/assets/HoldingsTable";
import PerformanceChart from "@/pages/assets/PerformanceChart";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ChartPoint, HoldingItem, SnapshotRange, SortOrder } from "@/pages/assets/types";
import { formatTypeLabel, formatVND, formatVNDFull } from "@/pages/assets/utils";
import { fetchWealthAllocationHoldings } from "@/pages/wealthAllocationData";
import { fetchForecastTrades } from "@/lib/asset-forecast";
import { buildForecastLoanEventsWithTradeSettlements, fetchForecastLoanEvents, fetchForecastLoans, getForecastDebtForYear } from "@/lib/forecast-loans";
import { useToast } from "@/hooks/use-toast";

export default function WealthAllocationPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [snapshotRange, setSnapshotRange] = useState<SnapshotRange>("1m");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [holdingsCollapsed, setHoldingsCollapsed] = useState<boolean>(
    () => localStorage.getItem("wealth_holdings_collapsed") !== "0"
  );
  const [filterType, setFilterType] = useState<string>("all");
  const [hideValues, setHideValues] = useState<boolean>(() => localStorage.getItem("hide_values") === "1");
  const [showQtyCol, setShowQtyCol] = useState<boolean>(() => localStorage.getItem("wealth_col_qty") === "1");
  const [showPriceCol, setShowPriceCol] = useState<boolean>(() => localStorage.getItem("wealth_col_price") === "1");
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [debt, setDebt] = useState<number>(0);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWealthAllocation = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [wealthHoldings, totalAssetData, forecastTrades, latestSnapshot] = await Promise.all([
        fetchWealthAllocationHoldings(),
        Promise.all([fetchForecastLoans(), fetchForecastLoanEvents()]),
        fetchForecastTrades(),
        fetch("/api/wealth/snapshots/latest").then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setHoldings(wealthHoldings);
      setDebt(getForecastDebtForYear(
        totalAssetData[0],
        buildForecastLoanEventsWithTradeSettlements(totalAssetData[0], totalAssetData[1], forecastTrades)
      ));
      if (latestSnapshot) setLastSavedAt(latestSnapshot.snapshotAt);
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
    () => holdings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [holdings]
  );

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

  const filteredTotal = useMemo(
    () => filteredHoldings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [filteredHoldings]
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
    localStorage.setItem("wealth_holdings_collapsed", next ? "1" : "0");
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

  const saveSnapshotMutation = useMutation({
    mutationFn: async () => {
      const body = {
        totalAsset: totalValue,
        debt,
        netAsset,
        items: holdings.map((h) => ({
          type: h.type,
          label: h.symbol,
          value: h.currentValue ?? 0,
        })).filter((i) => i.value > 0),
      };
      const res = await fetch("/api/wealth/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Unable to save snapshot.");
      return data as { snapshotAt: string };
    },
    onSuccess: (data) => {
      setLastSavedAt(data.snapshotAt);
      void queryClient.invalidateQueries({ queryKey: ["wealth-snapshots"] });
      toast({ title: "Đã lưu snapshot tài sản" });
    },
    onError: (err) => toast({ title: "Lỗi", description: err instanceof Error ? err.message : "", variant: "destructive" }),
  });

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
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Tổng tài sản", value: totalValue, color: "text-foreground" },
                { label: "Nợ", value: debt, color: debt > 0 ? "text-amber-400" : "text-muted-foreground" },
                { label: "Tài sản ròng", value: netAsset, color: netAsset >= 0 ? "text-emerald-400" : "text-red-400" },
              ].map((card) => (
                <Card key={card.label} className="p-4 space-y-1">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{card.label}</p>
                  <p className={`text-sm sm:text-base md:text-lg font-bold tabular-nums break-all leading-snug ${card.color}`}>
                    {formatMoney(card.value, true)}
                  </p>
                </Card>
              ))}
            </div>

            {/* ── Save + last saved ─────────────────────────────────── */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={toggleHideValues}
                className="text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-widest transition-colors"
              >
                {hideValues ? "Hiện số liệu" : "Ẩn số liệu"}
              </button>
              <p className="text-[10px] text-muted-foreground">
                {lastSavedAt
                  ? `Lần lưu cuối: ${new Date(lastSavedAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
                  : "Chưa lưu snapshot nào"}
              </p>
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={saveSnapshotMutation.isPending || totalValue === 0}
                onClick={() => saveSnapshotMutation.mutate()}
              >
                {saveSnapshotMutation.isPending ? "Đang lưu..." : "Lưu snapshot"}
              </Button>
            </div>

            {(totalValue > 0 || holdings.length > 0) && (
              <div className="grid lg:grid-cols-2 gap-4">
                {totalValue > 0 && (
                  <AllocationChart
                    holdings={holdings}
                    totalValue={totalValue}
                    onTypeSelect={handleOpenAssetType}
                  />
                )}
                {holdings.length > 0 && (
                  <PerformanceChart
                    title="Performance"
                    chartData={chartData}
                    hideValues={hideValues}
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
