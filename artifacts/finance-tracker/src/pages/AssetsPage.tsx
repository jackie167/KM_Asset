import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetPortfolioSummaryQueryKey,
  getListHoldingsQueryKey,
  getListSnapshotsQueryKey,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { usePortfolioData } from "@/hooks/use-portfolio";
import { useToast } from "@/hooks/use-toast";
import AllocationChart from "@/pages/assets/AllocationChart";
import AssetsHeader from "@/pages/assets/AssetsHeader";
import HoldingsTable from "@/pages/assets/HoldingsTable";
import PerformanceChart from "@/pages/assets/PerformanceChart";
import PortfolioSummaryCard from "@/pages/assets/PortfolioSummaryCard";
import TradeDialog from "@/pages/assets/TradeDialog";
import TradeOrdersTable, { getTradeNetAmount, type TradeOrder } from "@/pages/assets/TradeOrdersTable";
import type { ChartPoint, HoldingItem, SnapshotRange, SortOrder } from "@/pages/assets/types";
import { deriveInvestmentGroup, formatVND, formatVNDFull } from "@/pages/assets/utils";

const RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function deriveMonthlyReturn(annual: number | null, monthly: unknown) {
  if (typeof monthly === "number" && Number.isFinite(monthly)) return monthly;
  if (annual == null || !Number.isFinite(annual) || annual <= -1) return null;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

function normalizeAssetType(type: string) {
  return type.trim().toLowerCase();
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function isCashHolding(holding: Pick<HoldingItem, "type" | "symbol">) {
  return normalizeAssetType(holding.type) === "cash" || normalizeSymbol(holding.symbol) === "CASH";
}

function buildRealizedPnLBySymbol(orders: TradeOrder[] | undefined) {
  const realized = new Map<string, number>();
  for (const order of orders ?? []) {
    if (order.side !== "sell" || order.status !== "applied") continue;
    const value = order.realizedPnl ?? order.realizedInterest ?? 0;
    if (!Number.isFinite(value)) continue;
    const symbol = normalizeSymbol(order.symbol);
    realized.set(symbol, (realized.get(symbol) ?? 0) + value);
  }
  return realized;
}

type CashFlow = {
  kind: string;
  amount: number;
  occurredAt: string;
};

type ClosedPosition = {
  symbol: string;
  assetType: string;
  sellCount: number;
  soldQuantity: number;
  netProceeds: number;
  realizedPnl: number;
  costBasisRemoved: number;
  realizedPnlPercent: number | null;
  lastSoldAt: string;
};

async function fetchCashFlows(): Promise<CashFlow[]> {
  const res = await fetch("/api/portfolio/cash-flows");
  if (!res.ok) return [];
  return res.json();
}

async function fetchClosedPositions(): Promise<ClosedPosition[]> {
  const res = await fetch("/api/portfolio/closed-positions");
  if (!res.ok) return [];
  return res.json();
}

function calculateNetExternalCashFlow(cashFlows: CashFlow[] | undefined) {
  return (cashFlows ?? []).reduce((sum, flow) => {
    const occurredAt = new Date(flow.occurredAt);
    if (occurredAt < RETURN_INITIAL_AT || occurredAt > new Date()) return sum;

    const kind = flow.kind.trim().toLowerCase();
    if (kind === "deposit" || kind === "contribution") return sum + flow.amount;
    if (kind === "withdrawal") return sum - flow.amount;
    return sum;
  }, 0);
}

function calculateCashCostBasis(orders: TradeOrder[] | undefined, cashHolding: HoldingItem | undefined, cashFlows: CashFlow[] | undefined) {
  if (!cashHolding || cashHolding.costOfCapital == null) return null;

  const totalBuyFromCash = (orders ?? []).reduce((sum, order) => {
    if (order.side !== "buy") return sum;
    if (order.status !== "applied") return sum;
    if (order.fundingSource.trim().toUpperCase() !== "CASH") return sum;
    return sum + getTradeNetAmount(order);
  }, 0);

  return cashHolding.costOfCapital - totalBuyFromCash + calculateNetExternalCashFlow(cashFlows);
}

function resolveRealizedPnL(holding: HoldingItem, realizedPnLBySymbol: Map<string, number>) {
  const symbol = normalizeSymbol(holding.symbol);
  return realizedPnLBySymbol.has(symbol) ? realizedPnLBySymbol.get(symbol)! : holding.realizedPnl ?? holding.interest ?? 0;
}

function calculateHoldingPnL(holding: HoldingItem, realizedPnLBySymbol: Map<string, number>, cashCostBasis: number | null) {
  if (isCashHolding(holding)) {
    const costBasis = cashCostBasis ?? holding.costOfCapital ?? 0;
    const currentValue = holding.currentValue ?? 0;
    const totalPnL = currentValue - costBasis;
    return {
      costBasis,
      unrealizedPnL: totalPnL,
      realizedPnL: 0,
      totalPnL,
      totalPnLPercent: costBasis > 0 ? totalPnL / costBasis : null,
    };
  }

  const costBasis = holding.costBasisRemaining ?? holding.costOfCapital ?? 0;
  const currentValue = holding.currentValue ?? 0;
  const unrealizedPnL = currentValue - costBasis;
  const realizedPnL = resolveRealizedPnL(holding, realizedPnLBySymbol);
  const totalPnL = unrealizedPnL + realizedPnL;

  return {
    costBasis,
    unrealizedPnL,
    realizedPnL,
    totalPnL,
    totalPnLPercent: costBasis > 0 ? totalPnL / costBasis : null,
  };
}

async function fetchTradeOrders(): Promise<TradeOrder[]> {
  const res = await fetch("/api/transactions");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function updateManualPrice(symbol: string, price: number): Promise<void> {
  const res = await fetch("/api/excel/investment/update-price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, price }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
}

async function fetchPortfolioXirr(): Promise<{ xirrAnnual: number | null; xirrMonthly: number | null }> {
  const res = await fetch("/api/portfolio/xirr");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} ${res.statusText}`);
  const xirrAnnual = typeof data?.xirrAnnual === "number" ? data.xirrAnnual : null;
  return {
    xirrAnnual,
    xirrMonthly: deriveMonthlyReturn(xirrAnnual, data?.xirrMonthly ?? data?.xirrMonth),
  };
}

export default function AssetsPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [snapshotRange, setSnapshotRange] = useState<SnapshotRange>("1m");
  const { summary, snapshots, holdings: holdingsFromApi, isLoading, isError, error } = usePortfolioData(snapshotRange);
  const tradeOrdersQuery = useQuery({
    queryKey: ["transactions"],
    queryFn: fetchTradeOrders,
  });
  const cashFlowsQuery = useQuery({
    queryKey: ["portfolio-cash-flows"],
    queryFn: fetchCashFlows,
  });
  const closedPositionsQuery = useQuery({
    queryKey: ["portfolio-closed-positions"],
    queryFn: fetchClosedPositions,
  });
  const portfolioXirrQuery = useQuery({
    queryKey: ["portfolio-xirr"],
    queryFn: fetchPortfolioXirr,
  });
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [holdingsCollapsed, setHoldingsCollapsed] = useState<boolean>(
    () => localStorage.getItem("holdings_collapsed") !== "0"
  );
  const [filterType, setFilterType] = useState<string>("all");
  const [hideValues, setHideValues] = useState<boolean>(() => localStorage.getItem("hide_values") === "1");
  const [showQtyCol, setShowQtyCol] = useState<boolean>(() => localStorage.getItem("col_sl") !== "0");
  const [showPriceCol, setShowPriceCol] = useState<boolean>(() => localStorage.getItem("col_gia") !== "0");
  const [showCostOfCapitalCol, setShowCostOfCapitalCol] = useState<boolean>(
    () => localStorage.getItem("col_cost_of_capital") !== "0"
  );
  const [tradeOrdersCollapsed, setTradeOrdersCollapsed] = useState<boolean>(
    () => localStorage.getItem("trade_orders_collapsed") === "1"
  );
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  const [editingTradeOrder, setEditingTradeOrder] = useState<TradeOrder | null>(null);

  const invalidatePortfolioAfterTrade = () => {
    queryClient.invalidateQueries({ queryKey: ["transactions"] });
    queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
    queryClient.invalidateQueries({ queryKey: ["portfolio-closed-positions"] });
  };

  const tradeBodyToRequest = (body: {
    side: "buy" | "sell";
    fundingSource: string;
    assetType: string;
    symbol: string;
    quantity: number;
    totalValue: number;
    netAmount?: number;
    note?: string;
    executedAt?: string;
  }) => ({
    ...body,
    fundingSource: "CASH",
    netAmount: body.netAmount ?? body.totalValue,
  });

  const createTradeMutation = useMutation({
    mutationFn: async (body: {
      side: "buy" | "sell";
      fundingSource: string;
      assetType: string;
      symbol: string;
      quantity: number;
      totalValue: number;
      netAmount?: number;
      note?: string;
      executedAt?: string;
    }) => {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tradeBodyToRequest(body)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Unable to save trade.");
      return data as TradeOrder;
    },
    onSuccess: () => {
      invalidatePortfolioAfterTrade();
      setTradeDialogOpen(false);
      toast({ title: "Trade saved", description: "The order was recorded in the database." });
    },
    onError: (err) => {
      toast({
        title: "Trade save failed",
        description: err instanceof Error ? err.message : "Unable to save trade.",
        variant: "destructive",
      });
    },
  });

  const updateTradeMutation = useMutation({
    mutationFn: async (body: {
      side: "buy" | "sell";
      fundingSource: string;
      assetType: string;
      symbol: string;
      quantity: number;
      totalValue: number;
      netAmount?: number;
      note?: string;
      executedAt?: string;
    }) => {
      if (!editingTradeOrder) throw new Error("No trade selected.");
      const res = await fetch(`/api/transactions/${editingTradeOrder.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tradeBodyToRequest(body)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Unable to update trade.");
      return data as TradeOrder;
    },
    onSuccess: () => {
      invalidatePortfolioAfterTrade();
      setTradeDialogOpen(false);
      setEditingTradeOrder(null);
      toast({ title: "Trade updated", description: "The order content was updated." });
    },
    onError: (err) => {
      toast({
        title: "Trade update failed",
        description: err instanceof Error ? err.message : "Unable to update trade.",
        variant: "destructive",
      });
    },
  });

  const updatePriceMutation = useMutation({
    mutationFn: ({ symbol, price }: { symbol: string; price: number }) => updateManualPrice(symbol, price),
    onSuccess: (_, { symbol }) => {
      queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
      toast({ title: "Đã cập nhật giá", description: `${symbol} đã được lưu vào DB và Google Sheets.` });
    },
    onError: (err) => {
      toast({ title: "Lỗi cập nhật giá", description: err instanceof Error ? err.message : "Không thể lưu.", variant: "destructive" });
    },
  });

  const deleteTradeMutation = useMutation({
    mutationFn: async (order: TradeOrder) => {
      const res = await fetch(`/api/transactions/${order.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Unable to delete trade.");
      }
    },
    onSuccess: () => {
      invalidatePortfolioAfterTrade();
      toast({ title: "Trade deleted", description: "The order was removed." });
    },
    onError: (err) => {
      toast({
        title: "Trade delete failed",
        description: err instanceof Error ? err.message : "Unable to delete trade.",
        variant: "destructive",
      });
    },
  });

  const holdings: HoldingItem[] = (summary?.holdings ?? holdingsFromApi) as HoldingItem[];
  const totalValue = summary?.totalValue ?? 0;
  const lastUpdated = summary?.lastUpdated;

  const chartData = useMemo(() => {
    const points = [...(snapshots || [])]
      .sort((a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime())
      .reduce((acc: ChartPoint[], snapshot) => {
        const dateKey = format(new Date(snapshot.snapshotAt), "dd/MM");
        const existing = acc.find((item) => item.date === dateKey);
        if (existing) {
          existing.totalValue = snapshot.totalValue;
          existing.stockValue = snapshot.stockValue;
          existing.goldValue = snapshot.goldValue;
        } else {
          acc.push({
            date: dateKey,
            totalValue: snapshot.totalValue,
            stockValue: snapshot.stockValue,
            goldValue: snapshot.goldValue,
          });
        }
        return acc;
      }, []);

    if (summary) {
      const currentDateKey = format(new Date(), "dd/MM");
      const existing = points.find((item) => item.date === currentDateKey);
      const currentPoint = {
        date: currentDateKey,
        totalValue: summary.totalValue,
        stockValue: summary.stockValue,
        goldValue: summary.goldValue,
      };
      if (existing) {
        Object.assign(existing, currentPoint);
      } else {
        points.push(currentPoint);
      }
    }

    return points;
  }, [snapshots, summary]);

  const sortedHoldings = useMemo(() => {
    if (sortOrder === "none") return holdings;
    return [...holdings].sort((a, b) => {
      const aValue = a.currentValue ?? 0;
      const bValue = b.currentValue ?? 0;
      return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
    });
  }, [holdings, sortOrder]);

  const availableTypes = useMemo(() => {
    const types = [...new Set(holdings.map((holding) => holding.type.toLowerCase()))];
    return types.sort((a, b) => {
      if (a === "stock") return -1;
      if (b === "stock") return 1;
      if (a === "gold") return -1;
      if (b === "gold") return 1;
      if (a === "crypto") return -1;
      if (b === "crypto") return 1;
      return a.localeCompare(b);
    });
  }, [holdings]);

  const filteredHoldings = useMemo(
    () => (filterType === "all" ? sortedHoldings : sortedHoldings.filter((holding) => holding.type.toLowerCase() === filterType)),
    [filterType, sortedHoldings]
  );

  const filteredTotal = useMemo(
    () => filteredHoldings.reduce((sum, holding) => sum + (holding.currentValue ?? 0), 0),
    [filteredHoldings]
  );

  const realizedPnLBySymbol = useMemo(
    () => buildRealizedPnLBySymbol(tradeOrdersQuery.data),
    [tradeOrdersQuery.data]
  );

  const cashCostBasis = useMemo(
    () => calculateCashCostBasis(tradeOrdersQuery.data, holdings.find(isCashHolding), cashFlowsQuery.data),
    [cashFlowsQuery.data, holdings, tradeOrdersQuery.data]
  );

  const portfolioReturnSummary = useMemo(() => {
    const holdingSymbols = new Set(holdings.map((holding) => normalizeSymbol(holding.symbol)));
    const openHoldingPnL = holdings.reduce((sum, holding) => {
      return sum + calculateHoldingPnL(holding, realizedPnLBySymbol, cashCostBasis).totalPnL;
    }, 0);
    const closedPositionRealizedPnL = [...realizedPnLBySymbol.entries()].reduce((sum, [symbol, value]) => {
      return holdingSymbols.has(symbol) ? sum : sum + value;
    }, 0);
    const totalCapital = holdings.reduce((sum, holding) => {
      return sum + (isCashHolding(holding)
        ? cashCostBasis ?? holding.costOfCapital ?? 0
        : holding.costBasisRemaining ?? holding.costOfCapital ?? 0);
    }, 0);
    const totalPnL = openHoldingPnL + closedPositionRealizedPnL;
    const totalPnLPercent = totalCapital > 0 ? totalPnL / totalCapital : null;

    return {
      totalPnL,
      totalPnLPercent,
      xirrAnnual: portfolioXirrQuery.data?.xirrAnnual ?? null,
      xirrMonthly: portfolioXirrQuery.data?.xirrMonthly ?? null,
    };
  }, [cashCostBasis, holdings, portfolioXirrQuery.data, realizedPnLBySymbol]);

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

  const handleExportCSV = () => {
    if (!holdings.length) return;
    const formatNumber = (value: number) => value.toLocaleString("vi-VN");
    const header = ["symbol", "type", "quantity", "current_price", "total_value", "cost_of_capital"];
    const rows = holdings.map((holding) => [
      holding.symbol,
      holding.type,
      holding.quantity != null ? formatNumber(holding.quantity) : "",
      holding.currentPrice != null ? formatNumber(holding.currentPrice) : "",
      holding.currentValue != null ? formatNumber(Math.round(holding.currentValue)) : "",
      holding.costBasisRemaining != null || holding.costOfCapital != null
        ? formatNumber(Math.round(holding.costBasisRemaining ?? holding.costOfCapital ?? 0))
        : "",
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `danh-muc-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportDebug = async () => {
    const res = await fetch("/api/investment/debug-export");
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast({
        title: "Export debug failed",
        description: data?.error || `HTTP ${res.status}`,
        variant: "destructive",
      });
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
    const filename = filenameMatch?.[1] || `investment-debug-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportSyncWorkbook = async () => {
    const res = await fetch("/api/investment/sync-export");
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast({
        title: "Export sync workbook failed",
        description: data?.error || `HTTP ${res.status}`,
        variant: "destructive",
      });
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
    const filename = filenameMatch?.[1] || `investment-sync-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const sortLabel =
    sortOrder === "desc" ? "↓ High → Low" : sortOrder === "asc" ? "↑ Low → High" : "Sort";

  const handleOpenAssetType = (type: string) => {
    navigate(`/assets/type/${encodeURIComponent(type)}`);
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

  const toggleTradeOrdersCollapsed = () => {
    const value = !tradeOrdersCollapsed;
    setTradeOrdersCollapsed(value);
    localStorage.setItem("trade_orders_collapsed", value ? "1" : "0");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AssetsHeader
        lastUpdated={lastUpdated}
        hasHoldings={holdings.length > 0}
        onExport={handleExportCSV}
        onSyncExport={() => { void handleExportSyncWorkbook(); }}
        onDebugExport={() => { void handleExportDebug(); }}
        onTrade={() => {
          setEditingTradeOrder(null);
          setTradeDialogOpen(true);
        }}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        {isError ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unable to load data."}
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            Loading...
          </div>
        ) : (
          <>
            <PortfolioSummaryCard
              totalValueLabel={formatMoney(totalValue, true)}
              hideValues={hideValues}
              onToggleHideValues={toggleHideValues}
              metrics={[
                {
                  label: "P/L",
                  value: formatVNDFull(portfolioReturnSummary.totalPnL),
                  tone: portfolioReturnSummary.totalPnL >= 0 ? "positive" : "negative",
                },
                {
                  label: "P/L %",
                  value: formatPercent(portfolioReturnSummary.totalPnLPercent),
                  tone:
                    portfolioReturnSummary.totalPnLPercent == null
                      ? "neutral"
                      : portfolioReturnSummary.totalPnLPercent >= 0
                        ? "positive"
                        : "negative",
                },
                {
                  label: "XIRR / Year",
                  value: formatPercent(portfolioReturnSummary.xirrAnnual),
                  tone:
                    portfolioReturnSummary.xirrAnnual == null
                      ? "neutral"
                      : portfolioReturnSummary.xirrAnnual >= 0
                        ? "positive"
                        : "negative",
                },
                {
                  label: "XIRR / Month",
                  value: formatPercent(portfolioReturnSummary.xirrMonthly),
                  tone:
                    portfolioReturnSummary.xirrMonthly == null
                      ? "neutral"
                      : portfolioReturnSummary.xirrMonthly >= 0
                        ? "positive"
                        : "negative",
                },
              ]}
            />

            {(totalValue > 0 || holdings.length > 0) && (
              <div className="grid sm:grid-cols-2 gap-4">
                {totalValue > 0 && (
                  <AllocationChart
                    holdings={holdings}
                    totalValue={totalValue}
                    title="Investment Allocation"
                    groupBy={(holding) => holding.investmentGroup ?? deriveInvestmentGroup(holding.type)}
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
              showCostOfCapitalCol={showCostOfCapitalCol}
              showReturnCols
              cashAdjustedCost={cashCostBasis}
              realizedPnLBySymbol={realizedPnLBySymbol}
              formatMoney={formatMoney}
              onToggleHoldingsCollapsed={toggleHoldingsCollapsed}
              onToggleQtyCol={toggleQtyCol}
              onTogglePriceCol={togglePriceCol}
              onToggleCostOfCapitalCol={toggleCostOfCapitalCol}
              onFilterTypeChange={setFilterType}
              onCycleSortOrder={cycleSortOrder}
              onUpdatePrice={(symbol, price) => updatePriceMutation.mutate({ symbol, price })}
              readOnly
            />

            {(closedPositionsQuery.data?.length ?? 0) > 0 && (
              <div className="p-4 rounded-lg border bg-card text-card-foreground shadow-sm">
                <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">Closed Positions</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                        <th className="py-1.5 pr-3 text-left font-normal">Asset</th>
                        <th className="py-1.5 px-3 text-right font-normal">Sells</th>
                        <th className="py-1.5 px-3 text-right font-normal">Proceeds</th>
                        <th className="py-1.5 px-3 text-right font-normal">Cost Removed</th>
                        <th className="py-1.5 px-3 text-right font-normal">Realized</th>
                        <th className="py-1.5 pl-3 text-right font-normal">Realized %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(closedPositionsQuery.data ?? []).map((position) => (
                        <tr key={position.symbol} className="border-b border-border last:border-0">
                          <td className="py-2 pr-3">
                            <div className="font-medium">{position.symbol}</div>
                            <div className="text-[10px] text-muted-foreground">{position.assetType}</div>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{position.sellCount}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{formatMoney(position.netProceeds, true)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{formatMoney(position.costBasisRemoved, true)}</td>
                          <td className={`py-2 px-3 text-right tabular-nums ${position.realizedPnl >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                            {formatMoney(position.realizedPnl, true)}
                          </td>
                          <td className={`py-2 pl-3 text-right tabular-nums ${
                            position.realizedPnlPercent == null
                              ? "text-muted-foreground"
                              : position.realizedPnlPercent >= 0
                                ? "text-emerald-400"
                                : "text-red-300"
                          }`}>
                            {formatPercent(position.realizedPnlPercent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <TradeOrdersTable
              orders={tradeOrdersQuery.data ?? []}
              isLoading={tradeOrdersQuery.isLoading}
              collapsed={tradeOrdersCollapsed}
              onToggleCollapsed={toggleTradeOrdersCollapsed}
              onEdit={(order) => {
                setEditingTradeOrder(order);
                setTradeDialogOpen(true);
              }}
              onDelete={(order) => {
                deleteTradeMutation.mutate(order);
              }}
            />
          </>
        )}
      </main>
      <TradeDialog
        open={tradeDialogOpen}
        holdings={holdings}
        editingOrder={editingTradeOrder}
        isSaving={createTradeMutation.isPending || updateTradeMutation.isPending}
        onClose={() => {
          setTradeDialogOpen(false);
          setEditingTradeOrder(null);
        }}
        onSubmit={(body) => {
          if (editingTradeOrder) {
            updateTradeMutation.mutate(body);
          } else {
            createTradeMutation.mutate(body);
          }
        }}
      />
    </div>
  );
}
