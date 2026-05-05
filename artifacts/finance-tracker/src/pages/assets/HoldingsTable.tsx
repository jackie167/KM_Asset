import { useMemo, useState, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { HoldingItem, SortOrder } from "@/pages/assets/types";
import { formatPercent, formatTypeLabel, formatTypeShortLabel, formatVNDFull } from "@/pages/assets/utils";

const RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");

function yearFraction(from: Date, to: Date) {
  return (to.getTime() - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
}

function calculateSnapshotXirr(costOfCapital: number | null | undefined, currentValue: number | null | undefined) {
  if (costOfCapital == null || currentValue == null || costOfCapital <= 0 || currentValue <= 0) return null;
  const years = yearFraction(RETURN_INITIAL_AT, new Date());
  if (!Number.isFinite(years) || years <= 0) return null;
  return Math.pow(currentValue / costOfCapital, 1 / years) - 1;
}

type SortKey =
  | "symbol"
  | "type"
  | "weight"
  | "currentValue"
  | "quantity"
  | "currentPrice"
  | "costOfCapital"
  | "unrealizedPnL"
  | "realizedPnL"
  | "totalPnL"
  | "unrealizedPnLPercent"
  | "xirrAnnual"
  | "xirrMonthly";

type SortDirection = "asc" | "desc";

function ChangeChip({
  change,
  changePercent,
}: {
  change: number | null | undefined;
  changePercent: number | null | undefined;
}) {
  if (change == null && changePercent == null) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const isPositive = (change ?? 0) >= 0;
  return (
    <span className={`text-xs font-medium ${isPositive ? "text-green-400" : "text-red-400"}`}>
      {isPositive ? "▲" : "▼"} {changePercent != null ? `${Math.abs(changePercent).toFixed(2)}%` : ""}
    </span>
  );
}

function isCashHolding(holding: HoldingItem) {
  return holding.type.trim().toLowerCase() === "cash" || holding.symbol.trim().toUpperCase() === "CASH";
}

function getRealizedPnL(holding: HoldingItem, realizedPnLBySymbol: Map<string, number>) {
  const symbol = holding.symbol.trim().toUpperCase();
  return realizedPnLBySymbol.has(symbol) ? realizedPnLBySymbol.get(symbol)! : holding.realizedPnl ?? holding.interest ?? 0;
}

function calculatePnL(holding: HoldingItem, realizedPnLBySymbol: Map<string, number>, cashAdjustedCost: number | null) {
  if (isCashHolding(holding)) {
    const effectiveCostOfCapital = cashAdjustedCost ?? holding.costOfCapital ?? 0;
    const totalPnL = (holding.currentValue ?? 0) - effectiveCostOfCapital;
    return {
      effectiveCostOfCapital,
      unrealizedPnL: totalPnL,
      realizedPnL: 0,
      totalPnL,
      totalPnLPercent: effectiveCostOfCapital > 0 ? totalPnL / effectiveCostOfCapital : null,
    };
  }

  const effectiveCostOfCapital = holding.costBasisRemaining ?? holding.costOfCapital ?? 0;
  const unrealizedPnL = (holding.currentValue ?? 0) - effectiveCostOfCapital;
  const realizedPnL = getRealizedPnL(holding, realizedPnLBySymbol);
  const totalPnL = unrealizedPnL + realizedPnL;
  return {
    effectiveCostOfCapital,
    unrealizedPnL,
    realizedPnL,
    totalPnL,
    totalPnLPercent: effectiveCostOfCapital > 0 ? totalPnL / effectiveCostOfCapital : null,
  };
}

type HoldingsTableProps = {
  holdings: HoldingItem[];
  filteredHoldings: HoldingItem[];
  totalValue: number;
  filteredTotal: number;
  filterType: string;
  availableTypes: string[];
  sortOrder: SortOrder;
  sortLabel: string;
  holdingsCollapsed: boolean;
  showQtyCol: boolean;
  showPriceCol: boolean;
  showCostOfCapitalCol?: boolean;
  showReturnCols?: boolean;
  cashAdjustedCost?: number | null;
  realizedPnLBySymbol?: Map<string, number>;
  formatMoney: (value: number | null | undefined, full?: boolean) => string;
  onToggleHoldingsCollapsed: () => void;
  onToggleQtyCol: () => void;
  onTogglePriceCol: () => void;
  onToggleCostOfCapitalCol?: () => void;
  onFilterTypeChange: (value: string) => void;
  onCycleSortOrder: () => void;
  onAdd?: () => void;
  onEdit?: (holding: HoldingItem) => void;
  onDelete?: (id: number) => void;
  onUpdatePrice?: (symbol: string, price: number) => void;
  readOnly?: boolean;
};

export default function HoldingsTable({
  holdings,
  filteredHoldings,
  totalValue,
  filteredTotal,
  filterType,
  availableTypes,
  holdingsCollapsed,
  showQtyCol,
  showPriceCol,
  showCostOfCapitalCol = false,
  showReturnCols = false,
  cashAdjustedCost = null,
  realizedPnLBySymbol = new Map<string, number>(),
  formatMoney,
  onToggleHoldingsCollapsed,
  onToggleQtyCol,
  onTogglePriceCol,
  onToggleCostOfCapitalCol,
  onFilterTypeChange,
  onAdd,
  onEdit,
  onDelete,
  onUpdatePrice,
  readOnly = false,
}: HoldingsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("currentValue");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [editingPrice, setEditingPrice] = useState<string | null>(null); // symbol being edited
  const [priceInput, setPriceInput] = useState("");
  const priceInputRef = useRef<HTMLInputElement>(null);

  const isManualPriceType = (type: string) =>
    !["stock", "gold", "crypto"].includes(type.toLowerCase().trim());

  const startPriceEdit = (holding: HoldingItem) => {
    setEditingPrice(holding.symbol);
    setPriceInput(String(holding.currentPrice ?? holding.manualPrice ?? ""));
    setTimeout(() => priceInputRef.current?.select(), 50);
  };

  const commitPriceEdit = (symbol: string) => {
    const price = parseFloat(priceInput.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(price) && price > 0 && onUpdatePrice) {
      onUpdatePrice(symbol, price);
    }
    setEditingPrice(null);
  };

  const filteredPnLTotal = filteredHoldings.reduce((sum, holding) => {
    return sum + calculatePnL(holding, realizedPnLBySymbol, cashAdjustedCost).totalPnL;
  }, 0);
  const filteredCostTotal = filteredHoldings.reduce((sum, holding) => {
    return sum + (calculatePnL(holding, realizedPnLBySymbol, cashAdjustedCost).effectiveCostOfCapital ?? 0);
  }, 0);
  const filteredUnrealizedPnLTotal = filteredHoldings.reduce((sum, holding) => {
    return sum + calculatePnL(holding, realizedPnLBySymbol, cashAdjustedCost).unrealizedPnL;
  }, 0);
  const filteredRealizedPnLTotal = filteredHoldings.reduce((sum, holding) => {
    return sum + calculatePnL(holding, realizedPnLBySymbol, cashAdjustedCost).realizedPnL;
  }, 0);

  const sortedFilteredHoldings = useMemo(() => {
    const denominator = filterType === "all" ? totalValue : filteredTotal;
    const rows = filteredHoldings.map((holding) => {
      const { effectiveCostOfCapital, unrealizedPnL, realizedPnL, totalPnL, totalPnLPercent } = calculatePnL(holding, realizedPnLBySymbol, cashAdjustedCost);
      const xirrAnnual = calculateSnapshotXirr(effectiveCostOfCapital, holding.currentValue);
      const xirrMonthly = xirrAnnual == null ? null : Math.pow(1 + xirrAnnual, 1 / 12) - 1;
      const weight =
        denominator > 0 && holding.currentValue != null
          ? holding.currentValue / denominator
          : null;

      return {
        holding,
        unrealizedPnL,
        realizedPnL,
        totalPnL,
        unrealizedPnLPercent: totalPnLPercent,
        xirrAnnual,
        xirrMonthly,
        weight,
      };
    });

    const direction = sortDirection === "asc" ? 1 : -1;
    return rows.sort((left, right) => {
      const normalizeText = (value: string) => value.trim().toLowerCase();

      if (sortKey === "symbol") {
        return left.holding.symbol.localeCompare(right.holding.symbol) * direction;
      }

      if (sortKey === "type") {
        return normalizeText(left.holding.type).localeCompare(normalizeText(right.holding.type)) * direction;
      }

      const resolveNumericValue = (row: typeof rows[number]) => {
        switch (sortKey) {
          case "weight":
            return row.weight;
          case "currentValue":
            return row.holding.currentValue;
          case "quantity":
            return row.holding.quantity;
          case "currentPrice":
            return row.holding.currentPrice;
          case "costOfCapital":
            return row.holding.costBasisRemaining ?? row.holding.costOfCapital;
          case "unrealizedPnL":
            return row.unrealizedPnL;
          case "realizedPnL":
            return row.realizedPnL;
          case "totalPnL":
            return row.totalPnL;
          case "unrealizedPnLPercent":
            return row.unrealizedPnLPercent;
          case "xirrAnnual":
            return row.xirrAnnual;
          case "xirrMonthly":
            return row.xirrMonthly;
          default:
            return Number.NEGATIVE_INFINITY;
        }
      };

      const leftValue = resolveNumericValue(left);
      const rightValue = resolveNumericValue(right);
      const normalizedLeft = typeof leftValue === "number" && Number.isFinite(leftValue) ? leftValue : Number.NEGATIVE_INFINITY;
      const normalizedRight = typeof rightValue === "number" && Number.isFinite(rightValue) ? rightValue : Number.NEGATIVE_INFINITY;

      if (normalizedLeft !== normalizedRight) {
        return (normalizedLeft - normalizedRight) * direction;
      }

      return left.holding.symbol.localeCompare(right.holding.symbol);
    });
  }, [cashAdjustedCost, filteredHoldings, filterType, filteredTotal, realizedPnLBySymbol, sortDirection, sortKey, totalValue]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "symbol" || key === "type" ? "asc" : "desc");
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDirection === "asc" ? " ↑" : " ↓";
  };

  const headerCellClass = "px-2 py-1.5 text-[9px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap";
  const compactHeaderCellClass = `${headerCellClass} w-px`;
  const cellClass = "px-2 py-2.5 border-b border-border align-middle whitespace-nowrap";
  const compactCellClass = `${cellClass} w-px`;
  const numericCellClass = `${cellClass} text-right tabular-nums`;
  const compactNumericCellClass = `${compactCellClass} text-right tabular-nums`;

  return (
    <div className="p-4 rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleHoldingsCollapsed}
            className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-widest hover:text-foreground transition-colors"
          >
            <span
              className="inline-block transition-transform duration-200"
              style={{ transform: holdingsCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            >
              ▾
            </span>
            Portfolio
            {holdings.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-normal">
                {holdings.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onToggleHoldingsCollapsed}
            className="inline-flex items-center justify-center h-7 w-7 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors"
            aria-label={holdingsCollapsed ? "Show portfolio" : "Hide portfolio"}
          >
            {holdingsCollapsed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        {!holdingsCollapsed && holdings.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {[
              { label: "Qty", active: showQtyCol, onToggle: onToggleQtyCol },
              { label: "Price", active: showPriceCol, onToggle: onTogglePriceCol },
              onToggleCostOfCapitalCol
                ? { label: "Cost", active: showCostOfCapitalCol, onToggle: onToggleCostOfCapitalCol }
                : null,
            ].filter((item): item is { label: string; active: boolean; onToggle: () => void } => item !== null).map(({ label, active, onToggle }) => (
              <button
                key={label}
                onClick={onToggle}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  active
                    ? "border-border text-muted-foreground hover:border-primary/40"
                    : "border-dashed border-border/50 text-muted-foreground/40 line-through"
                }`}
                title={active ? `Hide ${label} column` : `Show ${label} column`}
              >
                {label}
              </button>
            ))}

            {availableTypes.length > 1 && (
              <Select value={filterType} onValueChange={onFilterTypeChange}>
                <SelectTrigger className="h-7 text-xs px-2 border-border gap-1 w-auto min-w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {availableTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {formatTypeLabel(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

          </div>
        )}
      </div>

      {!holdingsCollapsed && (
        <>
          {holdings.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground text-sm">No assets yet</p>
              {readOnly ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  This portfolio is synced from the Investment sheet.
                </p>
              ) : (
                <Button variant="outline" size="sm" className="mt-3" onClick={onAdd}>
                  Add first asset
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              {filteredHoldings.length === 0 && filterType !== "all" ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No assets in this type.
                </p>
              ) : (
                <table className="w-max table-auto border-separate border-spacing-0 text-xs">
                  <thead>
                    <tr>
                      <th className={`${compactHeaderCellClass} text-left`}>
                        <button type="button" onClick={() => handleSort("symbol")} className="hover:text-foreground transition-colors">Asset{sortIndicator("symbol")}</button>
                      </th>
                      <th className={`${compactHeaderCellClass} text-center`}>
                        <button type="button" onClick={() => handleSort("type")} className="hover:text-foreground transition-colors">Type{sortIndicator("type")}</button>
                      </th>
                      <th className={`${compactHeaderCellClass} text-right`}>
                        <button type="button" onClick={() => handleSort("weight")} className="hover:text-foreground transition-colors">%{sortIndicator("weight")}</button>
                      </th>
                      <th className={`${headerCellClass} text-right`}>
                        <button type="button" onClick={() => handleSort("currentValue")} className="hover:text-foreground transition-colors">Total Value{sortIndicator("currentValue")}</button>
                      </th>
                      {showQtyCol && (
                        <th className={`${headerCellClass} text-right`}>
                          <button type="button" onClick={() => handleSort("quantity")} className="hover:text-foreground transition-colors">Qty{sortIndicator("quantity")}</button>
                        </th>
                      )}
                      {showPriceCol && (
                        <th className={`${headerCellClass} text-right`}>
                          <button type="button" onClick={() => handleSort("currentPrice")} className="hover:text-foreground transition-colors">Price{sortIndicator("currentPrice")}</button>
                        </th>
                      )}
                      {showCostOfCapitalCol && (
                        <th className={`${headerCellClass} text-right`}>
                          <button type="button" onClick={() => handleSort("costOfCapital")} className="hover:text-foreground transition-colors">Cost{sortIndicator("costOfCapital")}</button>
                        </th>
                      )}
                      {showReturnCols && (
                        <>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("unrealizedPnL")} className="hover:text-foreground transition-colors">Unrealized{sortIndicator("unrealizedPnL")}</button>
                          </th>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("realizedPnL")} className="hover:text-foreground transition-colors">Realized{sortIndicator("realizedPnL")}</button>
                          </th>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("totalPnL")} className="hover:text-foreground transition-colors">Total P/L{sortIndicator("totalPnL")}</button>
                          </th>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("unrealizedPnLPercent")} className="hover:text-foreground transition-colors">P/L %{sortIndicator("unrealizedPnLPercent")}</button>
                          </th>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("xirrAnnual")} className="hover:text-foreground transition-colors">XIRR Year{sortIndicator("xirrAnnual")}</button>
                          </th>
                          <th className={`${headerCellClass} text-right`}>
                            <button type="button" onClick={() => handleSort("xirrMonthly")} className="hover:text-foreground transition-colors">XIRR Month{sortIndicator("xirrMonthly")}</button>
                          </th>
                        </>
                      )}
                    </tr>
                  </thead>

                  <tbody>
                    {sortedFilteredHoldings.map(({ holding, unrealizedPnL, realizedPnL, totalPnL, unrealizedPnLPercent, xirrAnnual, xirrMonthly, weight }) => (
                      <tr key={holding.id}>
                        <td className={compactCellClass}>
                          <p className="text-sm font-medium">{holding.symbol}</p>
                      {!readOnly && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <ChangeChip change={holding.change} changePercent={holding.changePercent} />
                          <>
                            <button
                              onClick={() => onEdit?.(holding)}
                              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              Edit
                            </button>
                            <span className="text-[10px] text-muted-foreground">·</span>
                            <button
                              onClick={() => onDelete?.(holding.id)}
                              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                            >
                              Delete
                            </button>
                          </>
                        </div>
                      )}
                        </td>

                        <td className={`${compactCellClass} text-center`}>
                          <span className="inline-block text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground text-center leading-snug">
                            {formatTypeShortLabel(holding.type)}
                          </span>
                        </td>

                        <td className={`${compactNumericCellClass} text-[10px] text-muted-foreground`}>
                          {weight != null ? `${(weight * 100).toFixed(1)}%` : "—"}
                        </td>

                        <td className={`${numericCellClass} text-sm font-semibold`}>
                          {formatMoney(holding.currentValue, true)}
                        </td>

                    {showQtyCol && (
                      <td className={`${numericCellClass} text-[11px] text-muted-foreground`}>
                        {holding.quantity.toLocaleString("vi-VN")}
                      </td>
                    )}

                    {showPriceCol && (
                      <td className={`${numericCellClass} text-[11px] text-muted-foreground`}>
                        <span className="flex items-center justify-end gap-1">
                        {editingPrice === holding.symbol ? (
                          <input
                            ref={priceInputRef}
                            type="text"
                            inputMode="numeric"
                            value={priceInput}
                            onChange={e => setPriceInput(e.target.value)}
                            onBlur={() => commitPriceEdit(holding.symbol)}
                            onKeyDown={e => {
                              if (e.key === "Enter") commitPriceEdit(holding.symbol);
                              if (e.key === "Escape") setEditingPrice(null);
                            }}
                            className="w-24 rounded border border-primary bg-background px-1.5 py-0.5 text-[11px] text-right tabular-nums focus:outline-none"
                          />
                        ) : (
                          <>
                            {formatMoney(holding.currentPrice, true)}
                            {onUpdatePrice && isManualPriceType(holding.type) && (
                              <button
                                type="button"
                                onClick={() => startPriceEdit(holding)}
                                className="text-muted-foreground/50 hover:text-primary transition-colors shrink-0"
                                title="Chỉnh giá"
                              >✏</button>
                            )}
                          </>
                        )}
                        </span>
                      </td>
                    )}

                    {showCostOfCapitalCol && (
                      <td className={`${numericCellClass} text-[11px] text-muted-foreground`}>
                        {formatMoney(holding.costBasisRemaining ?? holding.costOfCapital, true)}
                      </td>
                    )}

                    {showReturnCols && (
                      <>
                        <td className={`${numericCellClass} text-[11px] ${(unrealizedPnL ?? 0) >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                          {formatVNDFull(unrealizedPnL)}
                        </td>
                        <td className={`${numericCellClass} text-[11px] ${(realizedPnL ?? 0) >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                          {formatVNDFull(realizedPnL)}
                        </td>
                        <td className={`${numericCellClass} text-[11px] ${(totalPnL ?? 0) >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                          {formatVNDFull(totalPnL)}
                        </td>
                        <td className={`${numericCellClass} text-[11px] ${
                          unrealizedPnLPercent == null
                            ? "text-muted-foreground"
                            : unrealizedPnLPercent >= 0
                              ? "text-emerald-400"
                              : "text-red-300"
                        }`}>
                          {formatPercent(unrealizedPnLPercent)}
                        </td>
                        <td className={`${numericCellClass} text-[11px] ${
                          xirrAnnual == null
                            ? "text-muted-foreground"
                            : xirrAnnual >= 0
                              ? "text-emerald-400"
                              : "text-red-300"
                        }`}>
                          {formatPercent(xirrAnnual)}
                        </td>
                        <td className={`${numericCellClass} text-[11px] ${
                          xirrMonthly == null
                            ? "text-muted-foreground"
                            : xirrMonthly >= 0
                              ? "text-emerald-400"
                              : "text-red-300"
                        }`}>
                          {formatPercent(xirrMonthly)}
                        </td>
                      </>
                    )}
                      </tr>
                    ))}

                {filteredHoldings.length > 0 && (
                  <tr>
                    <td className="w-px px-2 pt-2.5 align-middle whitespace-nowrap">
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      {filterType === "all"
                        ? "Portfolio Total"
                        : `${formatTypeLabel(filterType)} Total`}
                      </span>
                    </td>
                    <td className="w-px px-2 pt-2.5" />
                    <td className="w-px px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {filteredHoldings.length > 0 ? "100.0%" : "—"}
                    </td>
                    <td className="px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap text-primary">
                      {formatMoney(filteredTotal, true)}
                    </td>
                    {showQtyCol && <td className="px-2 pt-2.5" />}
                    {showPriceCol && <td className="px-2 pt-2.5" />}
                    {showCostOfCapitalCol && (
                      <td className="px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap text-muted-foreground">
                        {formatVNDFull(filteredCostTotal)}
                      </td>
                    )}
                    {showReturnCols && (
                      <>
                      <td className={`px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap ${
                        filteredUnrealizedPnLTotal >= 0 ? "text-emerald-400" : "text-red-300"
                      }`}>
                        {formatVNDFull(filteredUnrealizedPnLTotal)}
                      </td>
                      <td className={`px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap ${
                        filteredRealizedPnLTotal >= 0 ? "text-emerald-400" : "text-red-300"
                      }`}>
                        {formatVNDFull(filteredRealizedPnLTotal)}
                      </td>
                      <td className={`px-2 pt-2.5 text-sm font-bold text-right tabular-nums whitespace-nowrap ${
                        filteredPnLTotal >= 0 ? "text-emerald-400" : "text-red-300"
                      }`}>
                        {formatVNDFull(filteredPnLTotal)}
                      </td>
                      <td className="px-2 pt-2.5" />
                      <td className="px-2 pt-2.5" />
                      <td className="px-2 pt-2.5" />
                      </>
                    )}
                  </tr>
                )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
