import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getGetPortfolioSummaryQueryKey,
  getListHoldingsQueryKey,
  getListSnapshotsQueryKey,
} from "@workspace/api-client-react";
import TradeOrdersTable, { getTradeNetAmount, type TradeOrder } from "@/pages/assets/TradeOrdersTable";
import TradeDialog from "@/pages/assets/TradeDialog";
import type { HoldingItem } from "@/pages/assets/types";
import PageHeader from "@/pages/PageHeader";
import { useToast } from "@/hooks/use-toast";

async function fetchTradeOrders(): Promise<TradeOrder[]> {
  const res = await fetch("/api/transactions");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

type CashFlow = {
  id: number;
  kind: string;
  account: string;
  origin: string;
  amount: number;
  note: string | null;
  source: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
};

const EMPTY_TRADE_ORDERS: TradeOrder[] = [];
const EMPTY_CASH_FLOWS: CashFlow[] = [];

async function fetchCashFlows(): Promise<CashFlow[]> {
  const res = await fetch("/api/portfolio/cash-flows");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function exportPortfolioXirrDebugCSV() {
  const res = await fetch("/api/portfolio/xirr/export");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
  const filename = filenameMatch?.[1] || `portfolio-xirr-debug-${new Date().toISOString().slice(0, 10)}.csv`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportAssetTimelineCSV(symbol: string) {
  const res = await fetch(`/api/assets/${encodeURIComponent(symbol)}/timeline?limit=5000`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as {
    events?: Array<{
      eventType: "price" | "transaction";
      date: string;
      assetCode: string;
      assetType: string;
      priceOrValue?: number | null;
      currentValue?: number | null;
      source?: string | null;
      side?: string | null;
      quantity?: number | null;
      unitPrice?: number | null;
      netAmount?: number | null;
      realizedPnl?: number | null;
      costBasisRemoved?: number | null;
      fundingSource?: string | null;
      origin?: string | null;
      status?: string | null;
      note?: string | null;
    }>;
  };
  const headers = [
    "date",
    "event_type",
    "asset",
    "asset_type",
    "side",
    "quantity",
    "price_or_value",
    "current_value",
    "unit_price",
    "net_amount",
    "realized_pnl",
    "cost_basis_removed",
    "source",
    "funding_source",
    "origin",
    "status",
    "note",
  ];
  const rows = (data.events ?? []).map((event) => [
    event.date,
    event.eventType,
    event.assetCode,
    event.assetType,
    event.side ?? "",
    event.quantity ?? "",
    event.priceOrValue ?? "",
    event.currentValue ?? "",
    event.unitPrice ?? "",
    event.netAmount ?? "",
    event.realizedPnl ?? "",
    event.costBasisRemoved ?? "",
    event.source ?? "",
    event.fundingSource ?? "",
    event.origin ?? "",
    event.status ?? "",
    event.note ?? "",
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\n");
  downloadCSV(csv, `asset-timeline-${symbol}-${new Date().toISOString().slice(0, 10)}.csv`);
}

function csvValue(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCSV(csv: string, filename: string) {
  const bom = "﻿";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportTradeOrdersCSV(orders: TradeOrder[], symbol?: string) {
  const headers = ["id","side","origin","asset","asset_type","quantity","net_amount","unit_price","realized_pnl","funding_source","status","executed_at","note"];
  const rows = orders.map((o) => [
    o.id, o.side, o.origin ?? "", o.symbol, o.assetType,
    o.quantity, getTradeNetAmount(o), o.unitPrice ?? "", o.realizedPnl ?? o.realizedInterest ?? "",
    o.fundingSource, o.status, o.executedAt, o.note ?? "",
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\n");
  const tag = symbol ? `-${symbol}` : "";
  downloadCSV(csv, `transactions${tag}-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportAssetDetailCSV(symbol: string, orders: TradeOrder[]) {
  const sorted = [...orders]
    .filter((o) => o.symbol === symbol)
    .sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime());

  let runningQty = 0;
  let totalInvested = 0;
  let cumulativePnL = 0;

  const headers = ["date","side","qty","unit_price","net_amount","running_qty","avg_cost","realized_pnl","cumulative_pnl","note"];
  const rows = sorted.map((o) => {
    const netAmount = getTradeNetAmount(o);
    let realizedPnL = 0;
    const avgCostBefore = runningQty > 0 ? totalInvested / runningQty : 0;

    if (o.side === "buy") {
      runningQty += o.quantity;
      totalInvested += netAmount;
    } else {
      const costBasis = o.quantity * avgCostBefore;
      realizedPnL = netAmount - costBasis;
      cumulativePnL += realizedPnL;
      runningQty = Math.max(0, runningQty - o.quantity);
      totalInvested = Math.max(0, totalInvested - costBasis);
    }

    const avgCostAfter = runningQty > 0 ? totalInvested / runningQty : 0;

    return [
      new Date(o.executedAt).toISOString().slice(0, 10),
      o.side,
      o.quantity,
      o.unitPrice ?? (o.quantity > 0 ? Math.round(netAmount / o.quantity) : ""),
      netAmount,
      runningQty,
      Math.round(avgCostAfter),
      o.side === "sell" ? Math.round(realizedPnL) : "",
      Math.round(cumulativePnL),
      o.note ?? "",
    ];
  });

  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\n");
  downloadCSV(csv, `asset-detail-${symbol}-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function fetchHoldings(): Promise<HoldingItem[]> {
  const res = await fetch("/api/portfolio/summary");
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return data?.holdings ?? [];
}

export default function TransactionsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<TradeOrder | null>(null);
  const [filterSymbol, setFilterSymbol] = useState<string>("");

  const tradeOrdersQuery = useQuery({ queryKey: ["transactions"], queryFn: fetchTradeOrders });
  const cashFlowsQuery   = useQuery({ queryKey: ["portfolio-cash-flows"], queryFn: fetchCashFlows });
  const holdingsQuery    = useQuery({ queryKey: ["holdings-for-trade"], queryFn: fetchHoldings });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["transactions"] });
    queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
  };

  const tradeBody = (body: { side: "buy"|"sell"; fundingSource: string; assetType: string; symbol: string; quantity: number; totalValue: number; netAmount?: number; note?: string; executedAt?: string }) =>
    ({ ...body, fundingSource: "CASH" });

  const createTrade = useMutation({
    mutationFn: async (body: Parameters<typeof tradeBody>[0]) => {
      const res = await fetch("/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tradeBody(body)) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Không thể lưu giao dịch.");
      return data as TradeOrder;
    },
    onSuccess: () => { invalidate(); setTradeDialogOpen(false); toast({ title: "Đã lưu giao dịch" }); },
    onError: (err) => toast({ title: "Lỗi", description: err instanceof Error ? err.message : "", variant: "destructive" }),
  });

  const updateTrade = useMutation({
    mutationFn: async (body: Parameters<typeof tradeBody>[0]) => {
      if (!editingOrder) throw new Error("No order selected.");
      const res = await fetch(`/api/transactions/${editingOrder.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tradeBody(body)) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Không thể cập nhật.");
      return data as TradeOrder;
    },
    onSuccess: () => { invalidate(); setTradeDialogOpen(false); setEditingOrder(null); toast({ title: "Đã cập nhật giao dịch" }); },
    onError: (err) => toast({ title: "Lỗi", description: err instanceof Error ? err.message : "", variant: "destructive" }),
  });

  const deleteTrade = useMutation({
    mutationFn: async (order: TradeOrder) => {
      const res = await fetch(`/api/transactions/${order.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { invalidate(); toast({ title: "Đã xóa giao dịch" }); },
    onError: (err) => toast({ title: "Lỗi", description: err instanceof Error ? err.message : "", variant: "destructive" }),
  });

  const [cashFlowKind, setCashFlowKind] = useState<"deposit" | "withdrawal">("deposit");
  const [cashFlowAmount, setCashFlowAmount] = useState("");
  const [cashFlowOccurredAt, setCashFlowOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [cashFlowNote, setCashFlowNote] = useState("");
  const [editingCashFlow, setEditingCashFlow] = useState<CashFlow | null>(null);

  const orders = tradeOrdersQuery.data ?? EMPTY_TRADE_ORDERS;
  const cashFlows = cashFlowsQuery.data ?? EMPTY_CASH_FLOWS;

  const assetOptions = useMemo(() => {
    const symbols = [...new Set(orders.map((o) => o.symbol))].sort();
    return symbols;
  }, [orders]);

  const filteredOrders = useMemo(
    () => (filterSymbol ? orders.filter((o) => o.symbol === filterSymbol) : orders),
    [orders, filterSymbol]
  );

  const cashFlowBalance = useMemo(
    () => cashFlows.reduce((sum, flow) => sum + (flow.kind === "withdrawal" ? -1 : 1) * flow.amount, 0),
    [cashFlows]
  );

  const invalidateCashFlow = () => {
    queryClient.invalidateQueries({ queryKey: ["portfolio-cash-flows"] });
    queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
  };

  const recalcCashMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/portfolio/cash-flows/recalculate", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to recalculate.");
      return data as { newCashBalance: number; flowCount: number };
    },
    onSuccess: (data) => {
      invalidateCashFlow();
      toast({ title: `Cash synced: ${data.newCashBalance.toLocaleString("vi-VN")}` });
    },
    onError: (err) => toast({ title: "Lỗi", description: err instanceof Error ? err.message : "", variant: "destructive" }),
  });

  const cashFlowBody = (kind: "deposit" | "withdrawal", amount: number, occurredAt: string, note: string) => ({
    kind,
    account: "CASH",
    amount,
    occurredAt: occurredAt ? new Date(`${occurredAt}T00:00:00+07:00`).toISOString() : undefined,
    note: note.trim() || undefined,
  });

  const createCashFlowMutation = useMutation({
    mutationFn: async (body: ReturnType<typeof cashFlowBody>) => {
      const res = await fetch("/api/portfolio/cash-flows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Unable to save cash flow.");
      return data as CashFlow;
    },
    onSuccess: () => { invalidateCashFlow(); setCashFlowAmount(""); setCashFlowNote(""); },
  });

  const updateCashFlowMutation = useMutation({
    mutationFn: async ({ id, ...body }: { id: number } & ReturnType<typeof cashFlowBody>) => {
      const res = await fetch(`/api/portfolio/cash-flows/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Unable to update cash flow.");
      return data as CashFlow;
    },
    onSuccess: () => { invalidateCashFlow(); setEditingCashFlow(null); setCashFlowAmount(""); setCashFlowNote(""); },
  });

  const deleteCashFlowMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/portfolio/cash-flows/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => invalidateCashFlow(),
  });

  const startEditCashFlow = (flow: CashFlow) => {
    setEditingCashFlow(flow);
    setCashFlowKind(flow.kind as "deposit" | "withdrawal");
    setCashFlowAmount(String(flow.amount));
    setCashFlowOccurredAt(new Date(flow.occurredAt).toISOString().slice(0, 10));
    setCashFlowNote(flow.note ?? "");
  };

  const cancelEditCashFlow = () => {
    setEditingCashFlow(null);
    setCashFlowAmount("");
    setCashFlowNote("");
    setCashFlowOccurredAt(new Date().toISOString().slice(0, 10));
    setCashFlowKind("deposit");
  };

  const handleCashFlowSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedAmount = Number(cashFlowAmount.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) return;
    const body = cashFlowBody(cashFlowKind, normalizedAmount, cashFlowOccurredAt, cashFlowNote);
    if (editingCashFlow) {
      updateCashFlowMutation.mutate({ id: editingCashFlow.id, ...body });
    } else {
      createCashFlowMutation.mutate(body);
    }
  };

  const menuActions = useMemo(() => {
    const actions: Parameters<typeof PageHeader>[0]["actions"] = [
      { kind: "item", label: "Thêm giao dịch", onSelect: () => { setEditingOrder(null); setTradeDialogOpen(true); } },
      { kind: "separator" },
      {
        kind: "item",
        label: filterSymbol ? `Export CSV — ${filterSymbol}` : "Export CSV (tất cả)",
        onSelect: () => exportTradeOrdersCSV(filteredOrders, filterSymbol || undefined),
        disabled: !filteredOrders.length,
      },
    ];
    if (filterSymbol) {
      actions.push({
        kind: "item",
        label: `Export Asset Detail — ${filterSymbol}`,
        onSelect: () => exportAssetDetailCSV(filterSymbol, orders),
      });
      actions.push({
        kind: "item",
        label: `Export Timeline — ${filterSymbol}`,
        onSelect: () => { void exportAssetTimelineCSV(filterSymbol); },
      });
    }
    actions.push({ kind: "separator" });
    actions.push({ kind: "item", label: "Export XIRR Debug", onSelect: () => { void exportPortfolioXirrDebugCSV(); } });
    return actions;
  }, [filterSymbol, filteredOrders, orders]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Transactions"
        subtitle="Giao dịch mua bán & dòng tiền đầu tư"
        actions={menuActions}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        <Card className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xs text-muted-foreground uppercase tracking-widest">Cash Flows</h2>
              <p className="text-xs text-muted-foreground mt-1">Deposit và withdrawal — ảnh hưởng trực tiếp đến Cash holding.</p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] px-2"
                disabled={recalcCashMutation.isPending}
                onClick={() => recalcCashMutation.mutate()}
              >
                Sync Cash
              </Button>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Net Flow</div>
                <div className="text-sm font-semibold tabular-nums">{cashFlowBalance.toLocaleString("vi-VN")}</div>
              </div>
            </div>
          </div>

          {editingCashFlow && (
            <p className="text-[10px] text-amber-400 uppercase tracking-widest">Editing #{editingCashFlow.id}</p>
          )}
          <form className="grid gap-2 md:grid-cols-[120px_1fr_160px_1.4fr_auto_auto]" onSubmit={handleCashFlowSubmit}>
            <Select value={cashFlowKind} onValueChange={(value) => setCashFlowKind(value as "deposit" | "withdrawal")}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">Deposit</SelectItem>
                <SelectItem value="withdrawal">Withdrawal</SelectItem>
              </SelectContent>
            </Select>
            <input
              value={cashFlowAmount}
              onChange={(event) => setCashFlowAmount(event.target.value)}
              placeholder="Amount"
              inputMode="decimal"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
            <input
              type="date"
              value={cashFlowOccurredAt}
              onChange={(event) => setCashFlowOccurredAt(event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
            <input
              value={cashFlowNote}
              onChange={(event) => setCashFlowNote(event.target.value)}
              placeholder="Note"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
            <Button type="submit" size="sm" className="h-9" disabled={createCashFlowMutation.isPending || updateCashFlowMutation.isPending}>
              {editingCashFlow ? "Save" : "Add"}
            </Button>
            {editingCashFlow && (
              <Button type="button" size="sm" variant="outline" className="h-9" onClick={cancelEditCashFlow}>
                Cancel
              </Button>
            )}
          </form>

          {(createCashFlowMutation.isError || updateCashFlowMutation.isError) && (
            <p className="text-xs text-red-300">
              {(createCashFlowMutation.error ?? updateCashFlowMutation.error) instanceof Error
                ? (createCashFlowMutation.error ?? updateCashFlowMutation.error)!.message
                : "Unable to save cash flow."}
            </p>
          )}

          {cashFlowsQuery.isError ? (
            <p className="text-xs text-red-300">
              {cashFlowsQuery.error instanceof Error ? cashFlowsQuery.error.message : "Unable to load cash flows."}
            </p>
          ) : cashFlows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No deposit or withdrawal recorded yet.</p>
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                    <th className="py-1.5 pr-3 text-left font-normal">Kind</th>
                    <th className="py-1.5 px-3 text-right font-normal">Amount</th>
                    <th className="py-1.5 px-3 text-left font-normal">Account</th>
                    <th className="py-1.5 px-3 text-left font-normal">Origin</th>
                    <th className="py-1.5 px-3 text-left font-normal">Note</th>
                    <th className="py-1.5 px-3 text-right font-normal">Date</th>
                    <th className="py-1.5 pl-3 text-right font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {[...cashFlows].reverse().map((flow) => (
                    <tr key={flow.id} className={`border-b border-border last:border-0 ${editingCashFlow?.id === flow.id ? "bg-amber-500/5" : ""}`}>
                      <td className={`py-2 pr-3 font-medium uppercase ${flow.kind === "withdrawal" ? "text-amber-300" : "text-emerald-400"}`}>
                        {flow.kind}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-medium">
                        {flow.amount.toLocaleString("vi-VN")}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground">{flow.account}</td>
                      <td className="py-2 px-3 text-muted-foreground">{flow.origin}</td>
                      <td className="py-2 px-3 text-muted-foreground">{flow.note || "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                        {new Date(flow.occurredAt).toLocaleDateString("vi-VN")}
                      </td>
                      <td className="py-2 pl-3 text-right">
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => startEditCashFlow(flow)}
                            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/50 hover:border-border transition"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (confirm("Xóa cash flow này?")) deleteCashFlowMutation.mutate(flow.id); }}
                            className="text-[10px] text-muted-foreground hover:text-red-400 px-1.5 py-0.5 rounded border border-border/50 hover:border-red-400/50 transition"
                          >
                            Del
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Asset filter + Trade Orders */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest shrink-0">Lọc tài sản</p>
            <select
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Tất cả ({orders.length})</option>
              {assetOptions.map((sym) => {
                const count = orders.filter((o) => o.symbol === sym).length;
                return (
                  <option key={sym} value={sym}>{sym} ({count})</option>
                );
              })}
            </select>
            {filterSymbol && (
              <button
                type="button"
                onClick={() => setFilterSymbol("")}
                className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/50 transition"
              >
                ✕ Xóa filter
              </button>
            )}
          </div>

          {tradeOrdersQuery.isError ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              {tradeOrdersQuery.error instanceof Error ? tradeOrdersQuery.error.message : "Unable to load transactions."}
            </div>
          ) : (
            <TradeOrdersTable
              orders={filteredOrders}
              isLoading={tradeOrdersQuery.isLoading}
              limit={0}
              onEdit={(order) => { setEditingOrder(order); setTradeDialogOpen(true); }}
              onDelete={(order) => deleteTrade.mutate(order)}
            />
          )}
        </div>
      </main>

      <TradeDialog
        open={tradeDialogOpen}
        holdings={holdingsQuery.data ?? []}
        editingOrder={editingOrder}
        isSaving={createTrade.isPending || updateTrade.isPending}
        onClose={() => { setTradeDialogOpen(false); setEditingOrder(null); }}
        onSubmit={(body) => editingOrder ? updateTrade.mutate(body) : createTrade.mutate(body)}
      />
    </div>
  );
}
