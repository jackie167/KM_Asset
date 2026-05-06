import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { formatVNDFull } from "@/pages/assets/utils";

export type TradeOrder = {
  id: number;
  side: "buy" | "sell";
  origin?: string;
  fundingSource: string;
  assetType: string;
  symbol: string;
  quantity: number;
  totalValue: number;
  grossAmount?: number | null;
  fee?: number | null;
  tax?: number | null;
  netAmount?: number | null;
  unitPrice: number | null;
  realizedInterest?: number | null;
  realizedPnl?: number | null;
  note?: string | null;
  status: string;
  executedAt: string;
  createdAt?: string;
  updatedAt?: string;
};

export function getTradeNetAmount(order: Pick<TradeOrder, "netAmount" | "totalValue">) {
  return order.netAmount ?? order.totalValue;
}

type TradeOrdersTableProps = {
  orders: TradeOrder[];
  isLoading: boolean;
  limit?: number;
  onEdit?: (order: TradeOrder) => void;
  onDelete?: (order: TradeOrder) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

export default function TradeOrdersTable({
  orders,
  isLoading,
  limit = 10,
  onEdit,
  onDelete,
  collapsed = false,
  onToggleCollapsed,
}: TradeOrdersTableProps) {
  const visibleOrders = limit > 0 ? orders.slice(0, limit) : orders;
  const hasActions = Boolean(onEdit || onDelete);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-widest hover:text-foreground transition-colors"
          >
            <span
              className="inline-block transition-transform duration-200"
              style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            >
              ▾
            </span>
            Trade Orders
            {orders.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-normal">
                {orders.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex items-center justify-center h-7 w-7 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors"
            aria-label={collapsed ? "Show trade orders" : "Hide trade orders"}
          >
            {collapsed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading trades...</p>
      ) : orders.length === 0 ? (
        <p className="text-xs text-muted-foreground">No trade orders recorded yet.</p>
      ) : (
        <div className="overflow-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                <th className="py-1.5 pr-3 text-left font-normal">Side</th>
                <th className="py-1.5 px-3 text-left font-normal">Asset</th>
                <th className="py-1.5 px-3 text-right font-normal">Qty</th>
                <th className="py-1.5 px-3 text-right font-normal">Net</th>
                <th className="py-1.5 px-3 text-left font-normal">Source</th>
                <th className="py-1.5 pl-3 text-right font-normal">Date</th>
                {hasActions && <th className="py-1.5 pl-3 text-right font-normal">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => (
                <tr key={order.id} className="border-b border-border last:border-0">
                  <td className={`py-2 pr-3 font-semibold uppercase ${order.side === "buy" ? "text-emerald-400" : "text-amber-300"}`}>
                    {order.side}
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{order.symbol}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {order.assetType}
                      {order.origin === "excel_sync" ? " · Sheet sync" : ""}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                    {order.quantity.toLocaleString("vi-VN")}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">
                    {formatVNDFull(getTradeNetAmount(order))}
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">{order.fundingSource}</td>
                  <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">
                    {new Date(order.executedAt).toLocaleDateString("vi-VN")}
                  </td>
                  {hasActions && (
                    <td className="py-2 pl-3 text-right whitespace-nowrap">
                      {onEdit && (
                        <button
                          type="button"
                          disabled={order.origin === "excel_sync"}
                          onClick={() => onEdit(order)}
                          className="cursor-pointer disabled:cursor-not-allowed text-[10px] text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground/60 disabled:opacity-60 transition-colors"
                        >
                          Edit
                        </button>
                      )}
                      {onEdit && onDelete && <span className="mx-1.5 text-muted-foreground">·</span>}
                      {onDelete && (
                        <button
                          type="button"
                          disabled={order.origin === "excel_sync"}
                          onClick={() => {
                            if (order.origin === "excel_sync") return;
                            if (confirmDeleteId === order.id) {
                              onDelete(order);
                              setConfirmDeleteId(null);
                              return;
                            }
                            setConfirmDeleteId(order.id);
                          }}
                          className="cursor-pointer disabled:cursor-not-allowed text-[10px] font-medium text-destructive hover:text-destructive/80 disabled:hover:text-destructive disabled:opacity-60 transition-colors"
                        >
                          {confirmDeleteId === order.id ? "Confirm?" : "Delete"}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}
    </Card>
  );
}
