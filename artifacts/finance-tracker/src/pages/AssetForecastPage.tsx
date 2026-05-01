import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetPortfolioSummaryQueryKey, getListHoldingsQueryKey, getListSnapshotsQueryKey } from "@workspace/api-client-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import PageHeader from "@/pages/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatTypeLabel, formatVND, formatVNDFull } from "@/pages/assets/utils";
import {
  FORECAST_YEARS, INITIAL_2026_FREE_CASH, INVEST_TYPES, type InvestType,
  DEFAULT_RATES, TYPE_LABELS, DEFAULT_ALLOCATION_RATIOS,
  isInvestType, getInvestmentType, isUnallocatedFreeCash,
  assetReturnKey, fixedTradeKey,
  type ForecastTrade,
  DB_KEYS, readJsonRecord, loadDbSetting, saveDbSetting,
  fetchCurrentAssetData, fetchForecastTrades, fetchFreeCashRows,
  parsePercentInput, saveIncomeExpenseRows, type FreeCashRow,
} from "@/lib/asset-forecast";
import {
  buildForecastLoanDetailSchedule,
  buildForecastLoanSchedule,
  createForecastLoanEvent,
  deleteForecastLoanEvent,
  fetchForecastLoanEvents,
  fetchForecastLoans,
  type ForecastLoan,
  type ForecastLoanEvent,
  updateForecastLoan,
} from "@/lib/forecast-loans";
import type { HoldingItem } from "@/pages/assets/types";

type ForecastTradeInput = {
  side: "buy" | "sell";
  year: number;
  assetType: string;
  symbol: string;
  amount: number;
  loanRatio?: number;
  loanInterestRate?: number;
  loanAnnualPrincipalPayment?: number;
  loanAnnualInterestPayment?: number;
  loanRepaymentType?: ForecastLoan["repaymentType"];
  settleLoanOnSell?: boolean;
  note?: string | null;
};

type ForecastFixedAssetRow = {
  key: string;
  symbol: string;
  type: string;
  startValue: number;
  returnRate: number;
  returnInput: string;
  holding: HoldingItem | null;
};

type SellCapacityRow = {
  tradeId: number;
  availableBeforeSell: number;
  effectiveSell: number;
};

function getTradeInvestmentType(trade: Pick<ForecastTrade, "assetType" | "symbol">): InvestType | null {
  const assetType = trade.assetType.trim().toLowerCase();
  if (isInvestType(assetType)) return assetType;
  const symbol = trade.symbol.trim().toLowerCase();
  if (isInvestType(symbol)) return symbol;
  return INVEST_TYPES.find((type) => TYPE_LABELS[type].toLowerCase() === symbol) ?? null;
}

function isExecutedForecastTrade(trade: Pick<ForecastTrade, "status">) {
  return trade.status === "executed";
}

const LS = {
  get: (key: string, fallback: string) => localStorage.getItem(key) ?? fallback,
  set: (key: string, value: string) => localStorage.setItem(key, value),
};

async function createForecastTrade(input: ForecastTradeInput): Promise<ForecastTrade> {
  const res = await fetch("/api/asset-forecast/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Không lưu được forecast trade.");
  return res.json();
}

async function updateForecastTrade(id: number, input: ForecastTradeInput): Promise<ForecastTrade> {
  const res = await fetch(`/api/asset-forecast/trades/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Không cập nhật được forecast trade.");
  return res.json();
}

async function deleteForecastTrade(id: number): Promise<void> {
  const res = await fetch(`/api/asset-forecast/trades/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Không xóa được forecast trade.");
}

function parseAmountInput(value: string): number {
  const cleaned = value.trim().replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercentValue(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatLoanEventType(value: ForecastLoanEvent["eventType"]) {
  switch (value) {
    case "drawdown": return "Vay thêm";
    case "interest": return "Lãi vay";
    case "principal_payment": return "Trả gốc";
    case "settlement": return "Tất toán";
  }
}

function normalizeAssetMatcher(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

function elapsedMonthsFromBaseYear(baseYear = 2026, now = new Date()) {
  return Math.max(0, (now.getFullYear() - baseYear) * 12 + now.getMonth());
}

function roundVND(value: number) {
  return Math.max(0, Math.round(value));
}

export default function AssetForecastPage() {
  const queryClient = useQueryClient();
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
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  const [editingTrade, setEditingTrade] = useState<ForecastTrade | null>(null);
  const [tradeSide, setTradeSide] = useState<ForecastTrade["side"]>("sell");
  const [tradeYear, setTradeYear] = useState("2026");
  const [tradeAssetKey, setTradeAssetKey] = useState("");
  const [tradeBuyAssetType, setTradeBuyAssetType] = useState("Real Estate");
  const [tradeBuyAssetTypeMode, setTradeBuyAssetTypeMode] = useState<"existing" | "new">("existing");
  const [tradeBuySymbol, setTradeBuySymbol] = useState("");
  const [tradeAmount, setTradeAmount] = useState("");
  const [tradeLoanRatio, setTradeLoanRatio] = useState("0");
  const [tradeLoanRate, setTradeLoanRate] = useState("0");
  const [tradeLoanPrincipal, setTradeLoanPrincipal] = useState("0");
  const [tradeLoanInterest, setTradeLoanInterest] = useState("0");
  const [tradeLoanRepaymentType, setTradeLoanRepaymentType] = useState<ForecastLoan["repaymentType"]>("interest_only");
  const [tradeSettleLoanOnSell, setTradeSettleLoanOnSell] = useState(true);
  const [tradeNote, setTradeNote] = useState("");
  const [incomeExpenseEditing, setIncomeExpenseEditing] = useState(false);
  const [incomeExpenseDraft, setIncomeExpenseDraft] = useState<Record<number, FreeCashRow>>({});
  const [loanEventLoanId, setLoanEventLoanId] = useState("");
  const [loanEventYear, setLoanEventYear] = useState("2026");
  const [loanEventType, setLoanEventType] = useState<ForecastLoanEvent["eventType"]>("principal_payment");
  const [loanEventAmount, setLoanEventAmount] = useState("");
  const [loanEventNote, setLoanEventNote] = useState("");
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const debounceSaveDb = useCallback((key: string, value: string, delay = 1500) => {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => { void saveDbSetting(key, value); }, delay);
  }, []);

  useEffect(() => {
    void (async () => {
      const [assetReturns, allocationRatios, investmentReturns] = await Promise.all([
        loadDbSetting(DB_KEYS.assetReturns),
        loadDbSetting(DB_KEYS.allocationRatios),
        loadDbSetting(DB_KEYS.investmentReturns),
      ]);
      if (assetReturns) {
        LS.set(DB_KEYS.assetReturns, assetReturns);
        try { setAssetReturnInputs(JSON.parse(assetReturns)); } catch { /* ignore */ }
      }
      if (allocationRatios) {
        LS.set(DB_KEYS.allocationRatios, allocationRatios);
        try { setAllocationInputs(JSON.parse(allocationRatios)); } catch { /* ignore */ }
      }
      if (investmentReturns) {
        LS.set(DB_KEYS.investmentReturns, investmentReturns);
        try {
          const parsed = JSON.parse(investmentReturns) as Record<string, string>;
          setInvestmentReturnInputs((prev) => ({ ...prev, ...parsed }));
        } catch { /* ignore */ }
      }
    })();
  }, []);

  const currentAssetQuery = useQuery({ queryKey: ["asset-forecast-current-asset"], queryFn: fetchCurrentAssetData });
  const freeCashQuery = useQuery({ queryKey: ["asset-forecast-free-cash-rows"], queryFn: fetchFreeCashRows });
  const forecastTradesQuery = useQuery({ queryKey: ["asset-forecast-trades"], queryFn: fetchForecastTrades });
  const forecastLoansQuery = useQuery({ queryKey: ["asset-forecast-loans"], queryFn: fetchForecastLoans });
  const forecastLoanEventsQuery = useQuery({ queryKey: ["asset-forecast-loan-events"], queryFn: fetchForecastLoanEvents });

  const currentAssetRows = useMemo(() => currentAssetQuery.data ?? [], [currentAssetQuery.data]);
  const freeCashRows = useMemo(() => freeCashQuery.data ?? [], [freeCashQuery.data]);
  const forecastTrades = useMemo(() => forecastTradesQuery.data ?? [], [forecastTradesQuery.data]);
  const forecastLoans = useMemo(() => forecastLoansQuery.data ?? [], [forecastLoansQuery.data]);
  const forecastLoanEvents = useMemo(() => forecastLoanEventsQuery.data ?? [], [forecastLoanEventsQuery.data]);

  const allocationRatios = useMemo(() => {
    return INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
      const input = allocationInputs[type] ?? String(DEFAULT_ALLOCATION_RATIOS[type]);
      acc[type] = parsePercentInput(input) / 100;
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

  const fixedAssetRows = useMemo<ForecastFixedAssetRow[]>(() => {
    const rows: ForecastFixedAssetRow[] = currentAssetRows.flatMap((holding) => {
      if (isUnallocatedFreeCash(holding)) return [];
      if (getInvestmentType(holding)) return [];
      const startValue = holding.currentValue ?? 0;
      const key = assetReturnKey(holding);
      const returnInput = assetReturnInputs[key] ?? returnRateInput;
      return [{
        key,
        symbol: holding.symbol,
        type: holding.type,
        startValue,
        returnRate: parsePercentInput(returnInput) / 100,
        returnInput,
        holding,
      }];
    });
    const existingKeys = new Set(rows.map((row) => row.key));
    for (const trade of forecastTrades) {
      if (trade.side !== "buy" || getTradeInvestmentType(trade)) continue;
      const key = fixedTradeKey(trade.assetType, trade.symbol);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const returnInput = assetReturnInputs[key] ?? returnRateInput;
      rows.push({
        key,
        symbol: trade.symbol,
        type: trade.assetType,
        startValue: 0,
        returnRate: parsePercentInput(returnInput) / 100,
        returnInput,
        holding: null,
      });
    }
    return rows;
  }, [assetReturnInputs, currentAssetRows, forecastTrades, returnRateInput]);

  const selectedTradeYear = FORECAST_YEARS.includes(Number(tradeYear)) ? Number(tradeYear) : 2026;
  const currentYear = new Date().getFullYear();

  const tradeDialogFixedStartByKey = useMemo(() => {
    const values = fixedAssetRows.map((row) => ({ ...row }));
    const result = new Map<string, number>();
    const tradesForDialog = forecastTrades.filter((trade) => trade.id !== editingTrade?.id);

    for (const forecastYear of FORECAST_YEARS) {
      for (const row of values) {
        const startValue = row.startValue;
        if (forecastYear === selectedTradeYear) {
          result.set(row.key, startValue);
        }

        const buyAmount = tradesForDialog
          .filter((trade) =>
            trade.side === "buy" &&
            trade.year === forecastYear &&
            !getTradeInvestmentType(trade) &&
            fixedTradeKey(trade.assetType, trade.symbol) === row.key
          )
          .reduce((sum, trade) => sum + trade.amount, 0);
        const sellAmount = tradesForDialog
          .filter((trade) =>
            trade.side === "sell" &&
            trade.year === forecastYear &&
            !getTradeInvestmentType(trade) &&
            fixedTradeKey(trade.assetType, trade.symbol) === row.key
          )
          .reduce((sum, trade) => sum + trade.amount, 0);
        const effectiveSell = Math.min(Math.max(0, startValue + buyAmount), sellAmount);
        const valueBeforeReturn = Math.max(0, startValue + buyAmount - effectiveSell);
        row.startValue = valueBeforeReturn + (valueBeforeReturn * row.returnRate);
      }
    }

    return result;
  }, [editingTrade?.id, fixedAssetRows, forecastTrades, selectedTradeYear]);

  // Only fixed (non-investment) assets can be sold via trade dialog.
  const tradeAssetOptions = useMemo(() =>
    fixedAssetRows.map((row) => {
      const isCurrentYearTrade = selectedTradeYear === currentYear;
      const currentMonthValue = row.startValue * ((1 + row.returnRate) ** (elapsedMonthsFromBaseYear(2026) / 12));
      const boughtByOtherTrades = isCurrentYearTrade
        ? forecastTrades
          .filter((trade) =>
            trade.id !== editingTrade?.id &&
            trade.side === "buy" &&
            trade.year === selectedTradeYear &&
            !getTradeInvestmentType(trade) &&
            fixedTradeKey(trade.assetType, trade.symbol) === row.key
          )
          .reduce((sum, trade) => sum + trade.amount, 0)
        : 0;
      const forecastStartValue = isCurrentYearTrade
        ? currentMonthValue + boughtByOtherTrades
        : tradeDialogFixedStartByKey.get(row.key) ?? row.startValue;
      const soldByOtherTrades = forecastTrades
        .filter((trade) =>
          trade.id !== editingTrade?.id &&
          trade.side === "sell" &&
          trade.year === selectedTradeYear &&
          !getTradeInvestmentType(trade) &&
          fixedTradeKey(trade.assetType, trade.symbol) === row.key
        )
        .reduce((sum, trade) => sum + trade.amount, 0);

      return {
        key: `fixed::${row.key}`,
        label: `${row.symbol} (${formatTypeLabel(row.type)})`,
        assetType: row.type,
        symbol: row.symbol,
        forecastStartValue,
        soldByOtherTrades,
        currentValue: Math.max(0, forecastStartValue - soldByOtherTrades),
      };
    })
  , [currentYear, editingTrade?.id, fixedAssetRows, forecastTrades, selectedTradeYear, tradeDialogFixedStartByKey]);

  const buyAssetTypeOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const row of fixedAssetRows) {
      const type = row.type.trim();
      const key = normalizeAssetMatcher(type);
      if (!type || seen.has(key)) continue;
      seen.add(key);
      result.push(type);
    }
    if (result.length === 0) return ["Real Estate", "Business"];
    return result.sort((a, b) => a.localeCompare(b));
  }, [fixedAssetRows]);

  const fixedSellByYearAndKey = useMemo(() => {
    const result = new Map<string, number>();
    for (const trade of forecastTrades) {
      if (trade.side !== "sell" || getTradeInvestmentType(trade)) continue;
      const key = `${trade.year}::${fixedTradeKey(trade.assetType, trade.symbol)}`;
      result.set(key, (result.get(key) ?? 0) + trade.amount);
    }
    return result;
  }, [forecastTrades]);

  const sellCapacityByTradeId = useMemo(() => {
    const values = new Map(fixedAssetRows.map((row) => [row.key, row.startValue]));
    const result = new Map<number, SellCapacityRow>();

    for (const forecastYear of FORECAST_YEARS) {
      const yearTrades = forecastTrades
        .filter((trade) => !getTradeInvestmentType(trade) && trade.year === forecastYear)
        .sort((a, b) => a.id - b.id);

      for (const trade of yearTrades.filter((item) => item.side === "buy")) {
        const key = fixedTradeKey(trade.assetType, trade.symbol);
        values.set(key, (values.get(key) ?? 0) + trade.amount);
      }

      for (const trade of yearTrades.filter((item) => item.side === "sell")) {
        const key = fixedTradeKey(trade.assetType, trade.symbol);
        const availableBeforeSell = Math.max(0, values.get(key) ?? 0);
        const effectiveSell = Math.min(availableBeforeSell, trade.amount);
        result.set(trade.id, { tradeId: trade.id, availableBeforeSell, effectiveSell });
        values.set(key, Math.max(0, availableBeforeSell - effectiveSell));
      }

      for (const row of fixedAssetRows) {
        const startValue = values.get(row.key) ?? 0;
        values.set(row.key, startValue + (startValue * row.returnRate));
      }
    }

    return result;
  }, [fixedAssetRows, forecastTrades]);

  const fixedBuyByYearAndKey = useMemo(() => {
    const result = new Map<string, number>();
    for (const trade of forecastTrades) {
      if (trade.side !== "buy" || getTradeInvestmentType(trade)) continue;
      const key = `${trade.year}::${fixedTradeKey(trade.assetType, trade.symbol)}`;
      result.set(key, (result.get(key) ?? 0) + trade.amount);
    }
    return result;
  }, [forecastTrades]);

  const forecastLoansWithTradeBuys = useMemo(() => {
    const buyLoans: ForecastLoan[] = forecastTrades.flatMap((trade) => {
      if (trade.side !== "buy" || getTradeInvestmentType(trade)) return [];
      const loanRatio = Math.max(0, Math.min(1, trade.loanRatio ?? 0));
      const principalStart = trade.amount * loanRatio;
      if (principalStart <= 0) return [];
      return [{
        id: -trade.id,
        assetType: trade.assetType,
        assetSymbol: trade.symbol,
        loanName: `${trade.symbol} forecast loan`,
        principalStart,
        interestRate: trade.loanInterestRate ?? 0,
        startYear: trade.year,
        endYear: null,
        repaymentType: trade.loanRepaymentType ?? "interest_only",
        annualPrincipalPayment: trade.loanAnnualPrincipalPayment ?? 0,
        annualInterestPayment: trade.loanAnnualInterestPayment ?? 0,
        settleOnAssetSell: trade.settleLoanOnSell ?? true,
        status: "active",
        note: `Auto loan from buy trade #${trade.id}`,
      }];
    });
    return [...forecastLoans, ...buyLoans];
  }, [forecastLoans, forecastTrades]);

  const loanEventsWithTradeSettlements = useMemo(() => {
    const derivedEvents: ForecastLoanEvent[] = [];
    const settlementByTradeId = new Map<number, number>();
    const settlementByYear = new Map<number, number>();
    const netCashByYear = new Map<number, number>();
    for (const trade of forecastTrades) {
      if (trade.side !== "buy" || getTradeInvestmentType(trade)) continue;
      if (isExecutedForecastTrade(trade)) continue;
      const loanRatio = Math.max(0, Math.min(1, trade.loanRatio ?? 0));
      const cashOut = trade.amount * (1 - loanRatio);
      netCashByYear.set(trade.year, (netCashByYear.get(trade.year) ?? 0) - cashOut);
    }
    const sortedTrades = [...forecastTrades]
      .filter((trade) => trade.side === "sell" && !getTradeInvestmentType(trade))
      .sort((a, b) => a.year - b.year || a.id - b.id);

    for (const trade of sortedTrades) {
      const effectiveTradeAmount = sellCapacityByTradeId.get(trade.id)?.effectiveSell ?? trade.amount;
      let remainingCash = Math.max(0, effectiveTradeAmount);
      let tradeSettlement = 0;
      const normalizedTradeAsset = normalizeAssetMatcher(trade.symbol);
      const matchedLoans = forecastLoansWithTradeBuys.filter((loan) =>
        loan.status === "active" &&
        loan.settleOnAssetSell &&
        normalizeAssetMatcher(loan.assetSymbol) === normalizedTradeAsset
      );

      for (const loan of matchedLoans) {
        if (remainingCash <= 0) break;
        // Rebuild with prior derived settlements so later trades cannot repay debt that was already cleared.
        const scheduleWithDerived = buildForecastLoanDetailSchedule(forecastLoansWithTradeBuys, [
          ...forecastLoanEvents,
          ...derivedEvents,
        ]);
        const loanRow = scheduleWithDerived.find((row) => row.loanId === loan.id && row.year === trade.year);
        const outstandingDebt = loanRow?.endingDebt ?? 0;
        const settlementAmount = Math.min(remainingCash, Math.max(0, outstandingDebt));
        if (settlementAmount <= 0) continue;

        derivedEvents.push({
          id: -((trade.id * 1000) + loan.id),
          loanId: loan.id,
          year: trade.year,
          eventType: "settlement",
          amount: settlementAmount,
          source: "trade_sell",
          tradeId: trade.id,
          note: `Auto settle from sell ${trade.symbol}`,
        });
        remainingCash -= settlementAmount;
        tradeSettlement += settlementAmount;
      }

      settlementByTradeId.set(trade.id, tradeSettlement);
      settlementByYear.set(trade.year, (settlementByYear.get(trade.year) ?? 0) + tradeSettlement);
      if (!isExecutedForecastTrade(trade)) {
        netCashByYear.set(trade.year, (netCashByYear.get(trade.year) ?? 0) + remainingCash);
      }
    }

    return {
      events: [...forecastLoanEvents, ...derivedEvents],
      netCashByYear,
      settlementByTradeId,
      settlementByYear,
    };
  }, [forecastLoanEvents, forecastLoansWithTradeBuys, forecastTrades, sellCapacityByTradeId]);

  const tradeCashByYear = loanEventsWithTradeSettlements.netCashByYear;
  const tradeSettlementByYear = loanEventsWithTradeSettlements.settlementByYear;
  const tradeSettlementByTradeId = loanEventsWithTradeSettlements.settlementByTradeId;

  const loanScheduleRows = useMemo(() => (
    buildForecastLoanSchedule(forecastLoansWithTradeBuys, loanEventsWithTradeSettlements.events)
  ), [forecastLoansWithTradeBuys, loanEventsWithTradeSettlements.events]);

  const loanDetailScheduleRows = useMemo(() => (
    buildForecastLoanDetailSchedule(forecastLoansWithTradeBuys, loanEventsWithTradeSettlements.events)
  ), [forecastLoansWithTradeBuys, loanEventsWithTradeSettlements.events]);

  const debtPrincipalPaymentByYear = useMemo(() => {
    return new Map(loanScheduleRows.map((row) => [
      row.year,
      Math.max(0, row.principalPayment + row.settlement - (tradeSettlementByYear.get(row.year) ?? 0)),
    ]));
  }, [loanScheduleRows, tradeSettlementByYear]);

  const debtInterestByYear = useMemo(() => {
    return new Map(loanScheduleRows.map((row) => [row.year, row.interest]));
  }, [loanScheduleRows]);

  const debtEndByYear = useMemo(() => {
    return new Map(loanScheduleRows.map((row) => [row.year, row.endingDebt]));
  }, [loanScheduleRows]);

  const baseFreeCashByYear = useMemo(() => {
    return new Map(freeCashRows.map((row) => [row.year, row.freeCash + row.totalInterest]));
  }, [freeCashRows]);

  const finalFreeCashByYear = useMemo(() => {
    return new Map(FORECAST_YEARS.map((year) => [
      year,
      (baseFreeCashByYear.get(year) ?? 0) +
        (tradeCashByYear.get(year) ?? 0) -
        (debtInterestByYear.get(year) ?? 0) -
        (debtPrincipalPaymentByYear.get(year) ?? 0),
    ]));
  }, [baseFreeCashByYear, debtInterestByYear, debtPrincipalPaymentByYear, tradeCashByYear]);

  const allocationRows = useMemo(() => {
    const rows = new Map<number, number>();
    rows.set(2026, INITIAL_2026_FREE_CASH);
    for (const row of freeCashRows) {
      const allocationYear = row.year + 1;
      if (FORECAST_YEARS.includes(allocationYear)) {
        rows.set(allocationYear, finalFreeCashByYear.get(row.year) ?? 0);
      }
    }
    return FORECAST_YEARS.map((year) => ({
      year,
      freeCash: rows.get(year) ?? 0,
      byType: INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
        acc[type] = (rows.get(year) ?? 0) * allocationRatios[type];
        return acc;
      }, {} as Record<InvestType, number>),
    }));
  }, [allocationRatios, finalFreeCashByYear, freeCashRows]);

  const forecastRows = useMemo(() => {
    const investmentValues = INVEST_TYPES.reduce<Record<InvestType, number>>((acc, type) => {
      acc[type] = investmentStartRows.find((row) => row.type === type)?.startValue ?? 0;
      return acc;
    }, {} as Record<InvestType, number>);
    const fixedValues = fixedAssetRows.map((row) => ({ ...row }));

    return FORECAST_YEARS.map((forecastYear) => {
      const allocation = allocationRows.find((row) => row.year === forecastYear);
      const endYearFreeCash = finalFreeCashByYear.get(forecastYear) ?? 0;
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
        const sellAmount = fixedSellByYearAndKey.get(`${forecastYear}::${row.key}`) ?? 0;
        const buyAmount = fixedBuyByYearAndKey.get(`${forecastYear}::${row.key}`) ?? 0;
        const effectiveSell = Math.min(Math.max(0, startValue + buyAmount), sellAmount);
        const valueBeforeReturn = Math.max(0, startValue + buyAmount - effectiveSell);
        const gain = valueBeforeReturn * row.returnRate;
        const endValue = valueBeforeReturn + gain;
        row.startValue = endValue;
        return { ...row, startValue, buyAmount, sellAmount: effectiveSell, valueBeforeReturn, gain, endValue };
      });

      const investmentStart = investmentDetails.reduce((sum, row) => sum + row.startValue, 0);
      const investmentAllocation = investmentDetails.reduce((sum, row) => sum + row.allocationValue, 0);
      const investmentGain = investmentDetails.reduce((sum, row) => sum + row.gain, 0);
      const investmentEnd = investmentDetails.reduce((sum, row) => sum + row.endValue, 0);
      const fixedStart = fixedDetails.reduce((sum, row) => sum + row.startValue, 0);
      const fixedGain = fixedDetails.reduce((sum, row) => sum + row.gain, 0);
      const fixedEnd = fixedDetails.reduce((sum, row) => sum + row.endValue, 0);
      const totalStart = investmentStart + fixedStart;
      const totalEnd = investmentEnd + fixedEnd + endYearFreeCash;
      const debtEnd = debtEndByYear.get(forecastYear) ?? 0;
      const netAssetEnd = totalEnd - debtEnd;

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
        endYearFreeCash,
        debtEnd,
        netAssetEnd,
        totalStart,
        totalEnd,
        totalIncrease: totalEnd - totalStart,
      };
    });
  }, [allocationRows, debtEndByYear, finalFreeCashByYear, fixedAssetRows, fixedBuyByYearAndKey, fixedSellByYearAndKey, investmentStartRows]);

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
    {
      key: "end-year-free-cash",
      label: "Free cash cuối năm",
      values: FORECAST_YEARS.map((forecastYear) => (
        forecastRows.find((row) => row.year === forecastYear)?.endYearFreeCash ?? 0
      )),
    },
  ];
  const totalAssetValues = FORECAST_YEARS.map((_, index) => (
    totalAssetForecastRows.reduce((sum, row) => sum + row.values[index], 0)
  ));
  const netAssetValues = FORECAST_YEARS.map((forecastYear, index) => (
    totalAssetValues[index] - (debtEndByYear.get(forecastYear) ?? 0)
  ));
  const totalAssetChartData = FORECAST_YEARS.map((forecastYear, index) => ({
    year: String(forecastYear),
    value: netAssetValues[index],
  }));

  const saveAllocationInput = (type: InvestType, value: string) => {
    setAllocationInputs((current) => {
      const next = { ...current, [type]: value };
      const json = JSON.stringify(next);
      LS.set(DB_KEYS.allocationRatios, json);
      debounceSaveDb(DB_KEYS.allocationRatios, json);
      return next;
    });
  };

  const saveInvestmentReturnInput = (type: InvestType, value: string) => {
    setInvestmentReturnInputs((current) => {
      const next = { ...current, [type]: value };
      const json = JSON.stringify(next);
      LS.set(DB_KEYS.investmentReturns, json);
      debounceSaveDb(DB_KEYS.investmentReturns, json);
      return next;
    });
  };

  const saveAssetReturnInput = (holding: HoldingItem, value: string) => {
    saveFixedAssetReturnInput(assetReturnKey(holding), value);
  };

  const saveFixedAssetReturnInput = (key: string, value: string) => {
    setAssetReturnInputs((current) => {
      const next = { ...current, [key]: value };
      const json = JSON.stringify(next);
      LS.set(DB_KEYS.assetReturns, json);
      debounceSaveDb(DB_KEYS.assetReturns, json);
      return next;
    });
  };

  const closeTradeDialog = () => {
    setTradeDialogOpen(false);
    setEditingTrade(null);
    setTradeSide("sell");
    setTradeAmount("");
    setTradeBuyAssetType("Real Estate");
    setTradeBuyAssetTypeMode("existing");
    setTradeBuySymbol("");
    setTradeLoanRatio("0");
    setTradeLoanRate("0");
    setTradeLoanPrincipal("0");
    setTradeLoanInterest("0");
    setTradeLoanRepaymentType("interest_only");
    setTradeSettleLoanOnSell(true);
    setTradeNote("");
  };

  const createTradeMutation = useMutation({
    mutationFn: createForecastTrade,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-forecast-trades"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-cash-flows"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-investment"] });
      queryClient.invalidateQueries({ queryKey: ["wealth-allocation-holdings"] });
      queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
      closeTradeDialog();
    },
  });

  const updateTradeMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: ForecastTradeInput }) => updateForecastTrade(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-forecast-trades"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-cash-flows"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-investment"] });
      queryClient.invalidateQueries({ queryKey: ["wealth-allocation-holdings"] });
      queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
      closeTradeDialog();
    },
  });

  const deleteTradeMutation = useMutation({
    mutationFn: deleteForecastTrade,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-forecast-trades"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-cash-flows"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-investment"] });
      queryClient.invalidateQueries({ queryKey: ["wealth-allocation-holdings"] });
      queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() });
    },
  });

  const saveIncomeExpenseMutation = useMutation({
    mutationFn: (rows: FreeCashRow[]) => saveIncomeExpenseRows(rows),
    onSuccess: () => {
      setIncomeExpenseEditing(false);
      queryClient.invalidateQueries({ queryKey: ["asset-forecast-free-cash-rows"] });
    },
  });

  const updateLoanMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: Partial<ForecastLoan> }) => updateForecastLoan(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["asset-forecast-loans"] }),
  });

  const createLoanEventMutation = useMutation({
    mutationFn: createForecastLoanEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset-forecast-loan-events"] });
      setLoanEventAmount("");
      setLoanEventNote("");
    },
  });

  const deleteLoanEventMutation = useMutation({
    mutationFn: deleteForecastLoanEvent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["asset-forecast-loan-events"] }),
  });

  const openTradeDialog = () => {
    setEditingTrade(null);
    setTradeSide("sell");
    setTradeYear("2026");
    setTradeAssetKey((current) => current || tradeAssetOptions[0]?.key || "");
    setTradeBuyAssetType(buyAssetTypeOptions[0] ?? "Real Estate");
    setTradeBuyAssetTypeMode("existing");
    setTradeBuySymbol("");
    setTradeAmount("");
    setTradeLoanRatio("0");
    setTradeLoanRate("0");
    setTradeLoanPrincipal("0");
    setTradeLoanInterest("0");
    setTradeLoanRepaymentType("interest_only");
    setTradeSettleLoanOnSell(true);
    setTradeNote("");
    setTradeDialogOpen(true);
  };

  const openEditTradeDialog = (trade: ForecastTrade) => {
    setEditingTrade(trade);
    setTradeSide(trade.side);
    setTradeYear(String(trade.year));
    const assetKey = `fixed::${fixedTradeKey(trade.assetType, trade.symbol)}`;
    setTradeAssetKey(assetKey);
    setTradeBuyAssetType(trade.assetType);
    setTradeBuyAssetTypeMode(buyAssetTypeOptions.some((type) => normalizeAssetMatcher(type) === normalizeAssetMatcher(trade.assetType)) ? "existing" : "new");
    setTradeBuySymbol(trade.symbol);
    setTradeAmount(String(trade.amount));
    setTradeLoanRatio(String((trade.loanRatio ?? 0) * 100));
    setTradeLoanRate(String((trade.loanInterestRate ?? 0) * 100));
    setTradeLoanPrincipal(String(trade.loanAnnualPrincipalPayment ?? 0));
    setTradeLoanInterest(String(trade.loanAnnualInterestPayment ?? 0));
    setTradeLoanRepaymentType(trade.loanRepaymentType ?? "interest_only");
    setTradeSettleLoanOnSell(trade.settleLoanOnSell ?? true);
    setTradeNote(trade.note ?? "");
    setTradeDialogOpen(true);
  };

  const selectedTradeOption = tradeAssetOptions.find((item) => item.key === tradeAssetKey) ?? null;
  const tradeAmountNum = parseAmountInput(tradeAmount);
  const selectedTradeCurrentValue = selectedTradeOption ? roundVND(selectedTradeOption.currentValue) : 0;
  const tradeAmountExceedsValue = tradeSide === "sell" && selectedTradeOption != null && roundVND(tradeAmountNum) > selectedTradeCurrentValue;
  const tradeLoanRatioNum = Math.max(0, Math.min(100, parsePercentInput(tradeLoanRatio))) / 100;
  const tradeLoanRateNum = Math.max(0, parsePercentInput(tradeLoanRate)) / 100;
  const tradeCashPortion = tradeSide === "buy" ? tradeAmountNum * (1 - tradeLoanRatioNum) : 0;
  const tradeLoanPrincipalAmount = tradeSide === "buy" ? tradeAmountNum * tradeLoanRatioNum : 0;
  const fillFullSellAmount = () => {
    if (!selectedTradeOption) return;
    setTradeAmount(String(selectedTradeCurrentValue));
  };

  const submitSellTrade = () => {
    const amount = tradeAmountNum;
    const year = Number(tradeYear);
    if (!Number.isInteger(year) || amount <= 0) return;
    if (tradeSide === "sell" && (!selectedTradeOption || roundVND(amount) > selectedTradeCurrentValue)) return;
    const assetType = tradeSide === "sell" ? selectedTradeOption!.assetType : tradeBuyAssetType.trim();
    const symbol = tradeSide === "sell" ? selectedTradeOption!.symbol : tradeBuySymbol.trim();
    if (!assetType || !symbol) return;

    const input: ForecastTradeInput = {
      side: tradeSide,
      year,
      assetType,
      symbol,
      amount,
      loanRatio: tradeSide === "buy" ? tradeLoanRatioNum : 0,
      loanInterestRate: tradeSide === "buy" ? tradeLoanRateNum : 0,
      loanAnnualPrincipalPayment: tradeSide === "buy" ? parseAmountInput(tradeLoanPrincipal) : 0,
      loanAnnualInterestPayment: tradeSide === "buy" ? parseAmountInput(tradeLoanInterest) : 0,
      loanRepaymentType: tradeSide === "buy" ? tradeLoanRepaymentType : "interest_only",
      settleLoanOnSell: tradeSide === "buy" ? tradeSettleLoanOnSell : true,
      note: tradeNote.trim() || null,
    };

    if (editingTrade) {
      updateTradeMutation.mutate({ id: editingTrade.id, input });
    } else {
      createTradeMutation.mutate(input);
    }
  };

  const beginIncomeExpenseEdit = () => {
    const draft = new Map(freeCashRows.map((row) => [row.year, row]));
    setIncomeExpenseDraft(Object.fromEntries(FORECAST_YEARS.map((year) => {
      const row = draft.get(year) ?? {
        year,
        income: 0,
        otherIncome: 0,
        expense: 0,
        otherExpense: 0,
        totalInterest: 0,
        totalIncome: 0,
        totalExpense: 0,
        freeCash: 0,
      };
      return [year, row];
    })));
    setIncomeExpenseEditing(true);
  };

  const updateIncomeExpenseDraft = (year: number, key: keyof Pick<FreeCashRow, "income" | "otherIncome" | "expense" | "otherExpense" | "totalInterest">, value: string) => {
    setIncomeExpenseDraft((current) => {
      const previous = current[year] ?? {
        year,
        income: 0,
        otherIncome: 0,
        expense: 0,
        otherExpense: 0,
        totalInterest: 0,
        totalIncome: 0,
        totalExpense: 0,
        freeCash: 0,
      };
      const next = { ...previous, [key]: Math.abs(parseAmountInput(value)) };
      const totalIncome = next.income + next.otherIncome;
      const totalExpense = next.expense + next.otherExpense + next.totalInterest;
      return { ...current, [year]: { ...next, totalIncome, totalExpense, freeCash: totalIncome - totalExpense } };
    });
  };

  const saveIncomeExpenseDraft = () => {
    const rows = FORECAST_YEARS.map((year) => incomeExpenseDraft[year]).filter((row): row is FreeCashRow => Boolean(row));
    saveIncomeExpenseMutation.mutate(rows);
  };

  const submitLoanEvent = () => {
    const loanId = Number(loanEventLoanId || forecastLoans[0]?.id);
    const year = Number(loanEventYear);
    const amount = parseAmountInput(loanEventAmount);
    if (!Number.isInteger(loanId) || loanId <= 0 || !Number.isInteger(year) || amount <= 0) return;

    createLoanEventMutation.mutate({
      loanId,
      year,
      eventType: loanEventType,
      amount,
      source: "manual",
      note: loanEventNote.trim() || null,
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Dự báo tài sản"
        subtitle="Ước tính tài sản cuối năm từ tài sản đầu năm, tăng trưởng giả định và free cash"
        inlineRight={
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={openTradeDialog}>
            Trade
          </Button>
        }
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-6">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Biểu đồ forecast tài sản</p>
            <p className="text-[10px] text-muted-foreground">2026-2044</p>
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
                    formatter={(value: number) => [formatVNDFull(value), "Net asset"]}
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
              <table className="w-full min-w-[1280px] text-xs">
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
                    <th className="py-2 px-4 text-right font-medium">Gross end</th>
                    <th className="py-2 px-4 text-right font-medium">Debt end</th>
                    <th className="py-2 pl-4 text-right font-medium">Net end</th>
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
                      <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(row.totalEnd)}</td>
                      <td className="py-2 px-4 text-right tabular-nums text-amber-300 whitespace-nowrap">{formatVNDFull(row.debtEnd)}</td>
                      <td className="py-2 pl-4 text-right tabular-nums font-bold whitespace-nowrap">{formatVNDFull(row.netAssetEnd)}</td>
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
              Income / expense từ DB
            </p>
            <div className="flex items-center gap-2">
              <p className="text-[10px] text-muted-foreground">2026-2044</p>
              {incomeExpenseEditing ? (
                <>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setIncomeExpenseEditing(false)}>
                    Hủy
                  </Button>
                  <Button size="sm" className="h-8 text-xs" disabled={saveIncomeExpenseMutation.isPending} onClick={saveIncomeExpenseDraft}>
                    Lưu
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={beginIncomeExpenseEdit}>
                  Edit
                </Button>
              )}
            </div>
          </div>
          <Card className="p-4 md:p-5">
            {freeCashQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((row) => (
                  <div key={row} className="h-8 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : freeCashRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có dữ liệu income/expense.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] text-xs">
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
                      <th className="py-2 px-4 text-right font-medium">Mua/bán tài sản net</th>
                      <th className="py-2 px-4 text-right font-medium">Tất toán từ bán</th>
                      <th className="py-2 px-4 text-right font-medium">Trả gốc vay</th>
                      <th className="py-2 pl-4 text-right font-medium">Free cash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {FORECAST_YEARS.map((year) => {
                      const row = freeCashRows.find((item) => item.year === year) ?? {
                        year,
                        income: 0,
                        otherIncome: 0,
                        expense: 0,
                        otherExpense: 0,
                        totalInterest: 0,
                        totalIncome: 0,
                        totalExpense: 0,
                        freeCash: 0,
                      };
                      const editRow = incomeExpenseEditing ? incomeExpenseDraft[year] ?? row : row;
                      const tradeCash = tradeCashByYear.get(year) ?? 0;
                      const tradeSettlement = tradeSettlementByYear.get(year) ?? 0;
                      const principalPayment = debtPrincipalPaymentByYear.get(year) ?? 0;
                      const loanInterest = debtInterestByYear.get(year) ?? 0;
                      const totalIncome = editRow.income + editRow.otherIncome;
                      const totalExpense = editRow.expense + editRow.otherExpense + loanInterest;
                      const freeCash = finalFreeCashByYear.get(year) ?? 0;
                      const inputClass = "h-8 w-32 ml-auto text-right text-xs tabular-nums";
                      return (
                        <tr key={row.year}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.year}</td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                            {incomeExpenseEditing ? <Input defaultValue={String(editRow.income)} inputMode="decimal" className={inputClass} onChange={(event) => updateIncomeExpenseDraft(year, "income", event.target.value)} /> : formatVNDFull(row.income)}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                            {incomeExpenseEditing ? <Input defaultValue={String(editRow.otherIncome)} inputMode="decimal" className={inputClass} onChange={(event) => updateIncomeExpenseDraft(year, "otherIncome", event.target.value)} /> : formatVNDFull(row.otherIncome)}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                            {incomeExpenseEditing ? <Input defaultValue={String(editRow.expense)} inputMode="decimal" className={inputClass} onChange={(event) => updateIncomeExpenseDraft(year, "expense", event.target.value)} /> : formatVNDFull(row.expense)}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                            {incomeExpenseEditing ? <Input defaultValue={String(editRow.otherExpense)} inputMode="decimal" className={inputClass} onChange={(event) => updateIncomeExpenseDraft(year, "otherExpense", event.target.value)} /> : formatVNDFull(row.otherExpense)}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatVNDFull(loanInterest)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium whitespace-nowrap">{formatVNDFull(totalIncome)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium whitespace-nowrap">{formatVNDFull(totalExpense)}</td>
                          <td className={`py-2 px-4 text-right tabular-nums font-medium whitespace-nowrap ${tradeCash >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                            {tradeCash ? formatVNDFull(tradeCash) : "—"}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium text-amber-300 whitespace-nowrap">
                            {tradeSettlement ? formatVNDFull(tradeSettlement) : "—"}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium text-red-300 whitespace-nowrap">
                            {principalPayment ? formatVNDFull(principalPayment) : "—"}
                          </td>
                          <td className={`py-2 pl-4 text-right tabular-nums font-semibold whitespace-nowrap ${freeCash >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                            {formatVNDFull(freeCash)}
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
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Buy/Sell forecast</p>
            <p className="text-[10px] text-muted-foreground">Buy thêm fixed asset, Sell tất toán vay gắn tài sản trước khi vào free cash</p>
          </div>
          <Card className="p-4 md:p-5">
            {forecastTradesQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((row) => (
                  <div key={row} className="h-8 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : forecastTrades.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có giao dịch forecast.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1120px] text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4 text-left font-medium">Year</th>
                      <th className="py-2 px-4 text-left font-medium">Side</th>
                      <th className="py-2 px-4 text-left font-medium">Status</th>
                      <th className="py-2 px-4 text-left font-medium">Asset</th>
                      <th className="py-2 px-4 text-right font-medium">Amount</th>
                      <th className="py-2 px-4 text-right font-medium">Applied</th>
                      <th className="py-2 px-4 text-right font-medium">Vay</th>
                      <th className="py-2 px-4 text-right font-medium">Tất toán vay</th>
                      <th className="py-2 px-4 text-right font-medium">Net cash</th>
                      <th className="py-2 px-4 text-left font-medium">Note</th>
                      <th className="py-2 pl-4 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {forecastTrades.map((trade) => {
                      const settlement = tradeSettlementByTradeId.get(trade.id) ?? 0;
                      const loanAmount = trade.side === "buy" ? trade.amount * Math.max(0, Math.min(1, trade.loanRatio ?? 0)) : 0;
                      const appliedAmount = trade.side === "sell" ? sellCapacityByTradeId.get(trade.id)?.effectiveSell ?? trade.amount : trade.amount;
                      const netCash = trade.side === "buy" ? -(trade.amount - loanAmount) : Math.max(0, appliedAmount - settlement);
                      return (
                        <tr key={trade.id}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">{trade.year}</td>
                          <td className="py-2 px-4 uppercase text-muted-foreground whitespace-nowrap">{trade.side}</td>
                          <td className="py-2 px-4 uppercase text-muted-foreground whitespace-nowrap">
                            {isExecutedForecastTrade(trade) ? "executed" : "planned"}
                          </td>
                          <td className="py-2 px-4 whitespace-nowrap">{trade.symbol} <span className="text-muted-foreground">({formatTypeLabel(trade.assetType)})</span></td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(trade.amount)}</td>
                          <td className={`py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap ${appliedAmount < trade.amount ? "text-amber-300" : ""}`}>
                            {formatVNDFull(appliedAmount)}
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium text-amber-300 whitespace-nowrap">{loanAmount ? formatVNDFull(loanAmount) : "—"}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium text-amber-300 whitespace-nowrap">{settlement ? formatVNDFull(settlement) : "—"}</td>
                          <td className={`py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap ${netCash >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                            {isExecutedForecastTrade(trade) ? "Investment CASH" : formatVNDFull(netCash)}
                          </td>
                          <td className="py-2 px-4 text-muted-foreground">{trade.note || "—"}</td>
                          <td className="py-2 pl-4 text-right whitespace-nowrap space-x-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              onClick={() => openEditTradeDialog(trade)}
                            >
                              Sửa
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              disabled={deleteTradeMutation.isPending}
                              onClick={() => deleteTradeMutation.mutate(trade.id)}
                            >
                              Xóa
                            </Button>
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
              Fixed asset từ DB base assets
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
              <p className="text-xs text-muted-foreground">Chưa đọc được dữ liệu base assets.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[2200px] text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4 text-left font-medium">Asset</th>
                      <th className="w-20 py-2 px-2 text-left font-medium">Type</th>
                      <th className="w-24 py-2 px-2 text-right font-medium">Assumed return</th>
                      <th className="py-2 px-4 text-right font-medium">Đầu 2026</th>
                      {FORECAST_YEARS.map((forecastYear, index) => (
                        <th
                          key={forecastYear}
                          className={`${index === FORECAST_YEARS.length - 1 ? "pl-4" : "px-4"} py-2 text-right font-medium`}
                        >
                          {forecastYear}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {fixedAssetRows.map((row) => {
                      const fixedEndValues = forecastRows.map((forecastRow, index) => (
                        forecastRow.fixedDetails.find((detail) => detail.key === row.key)?.endValue ??
                        row.startValue * (1 + row.returnRate) ** (index + 1)
                      ));

                      return (
                        <tr key={row.key}>
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.symbol}</td>
                          <td className="w-20 py-2 px-2 text-muted-foreground whitespace-normal leading-tight">{formatTypeLabel(row.type)}</td>
                          <td className="w-24 py-2 px-2 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                              <input
                                value={row.returnInput}
                                onChange={(event) => {
                                  if (row.holding) {
                                    saveAssetReturnInput(row.holding, event.target.value);
                                  } else {
                                    saveFixedAssetReturnInput(row.key, event.target.value);
                                  }
                                }}
                                inputMode="decimal"
                                className="w-10 bg-transparent text-right text-[11px] tabular-nums outline-none"
                              />
                              <span className="text-[10px] text-muted-foreground">%</span>
                            </div>
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(row.startValue)}</td>
                          {fixedEndValues.map((value, index) => (
                            <td
                              key={`${row.key}-${FORECAST_YEARS[index]}`}
                              className={`${index === fixedEndValues.length - 1 ? "pl-4" : "px-4"} py-2 text-right tabular-nums font-semibold whitespace-nowrap`}
                            >
                              {formatVNDFull(value)}
                            </td>
                          ))}
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
                      {FORECAST_YEARS.map((forecastYear, index) => (
                        <td
                          key={`fixed-total-${forecastYear}`}
                          className={`${index === FORECAST_YEARS.length - 1 ? "pl-4" : "px-4"} pt-3 text-right tabular-nums font-semibold whitespace-nowrap`}
                        >
                          {formatVNDFull(forecastRows[index]?.fixedEnd ?? initialFixedTotal)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Investment forecast 2026-2044</p>
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
            <p className="text-[10px] text-muted-foreground">Gross asset - debt = net asset</p>
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
                  <tr>
                    <td className="py-2.5 px-4 font-medium text-amber-300 whitespace-nowrap">Debt cuối năm</td>
                    {FORECAST_YEARS.map((forecastYear) => (
                      <td key={`debt-${forecastYear}`} className="py-2.5 px-4 text-right tabular-nums text-amber-300 whitespace-nowrap">
                        {formatVNDFull(debtEndByYear.get(forecastYear) ?? 0)}
                      </td>
                    ))}
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="pt-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">Gross asset</td>
                    {totalAssetValues.map((value, index) => (
                      <td key={`gross-${FORECAST_YEARS[index]}`} className="pt-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">
                        {formatVNDFull(value)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="pt-2 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">Net asset</td>
                    {netAssetValues.map((value, index) => (
                      <td key={`net-${FORECAST_YEARS[index]}`} className="pt-2 px-4 text-right tabular-nums font-bold whitespace-nowrap">
                        {formatVNDFull(value)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Chi tiết khoản vay forecast</p>
            <p className="text-[10px] text-muted-foreground">Chưa nối vào free cash</p>
          </div>
          <Card className="p-4 md:p-5 space-y-5">
            {forecastLoansQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((row) => (
                  <div key={row} className="h-8 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : forecastLoansWithTradeBuys.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có khoản vay forecast.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                        <th className="py-2 pr-4 text-left font-medium">Tài sản</th>
                        <th className="py-2 px-4 text-left font-medium">Khoản vay</th>
                        <th className="py-2 px-4 text-right font-medium">Gốc đầu kỳ</th>
                        <th className="py-2 px-4 text-right font-medium">Rate / năm</th>
                        <th className="py-2 px-4 text-right font-medium">Gốc định kỳ</th>
                        <th className="py-2 px-4 text-right font-medium">Lãi định kỳ</th>
                        <th className="py-2 px-4 text-center font-medium">Tất toán khi bán</th>
                        <th className="py-2 pl-4 text-left font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {forecastLoansWithTradeBuys.map((loan) => {
                        const isTradeLoan = loan.id < 0;
                        return (
                          <tr key={loan.id}>
                            <td className="py-2 pr-4 font-medium whitespace-nowrap">{loan.assetSymbol}</td>
                            <td className="py-2 px-4 text-muted-foreground whitespace-nowrap">
                              {loan.loanName}
                              {isTradeLoan && <span className="ml-2 text-[10px] text-amber-300">Trade</span>}
                            </td>
                            <td className="py-2 px-4 text-right whitespace-nowrap">
                              <Input
                                defaultValue={String(loan.principalStart)}
                                inputMode="decimal"
                                disabled={isTradeLoan}
                                className="h-8 w-32 ml-auto text-right text-xs tabular-nums"
                                onBlur={(event) => {
                                  if (!isTradeLoan) updateLoanMutation.mutate({ id: loan.id, input: { principalStart: parseAmountInput(event.target.value) } });
                                }}
                              />
                            </td>
                            <td className="py-2 px-4 text-right whitespace-nowrap">
                              <div className={`inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 ${isTradeLoan ? "opacity-70" : "focus-within:ring-1 focus-within:ring-primary"}`}>
                                <input
                                  defaultValue={String(loan.interestRate * 100)}
                                  inputMode="decimal"
                                  disabled={isTradeLoan}
                                  className="w-14 bg-transparent text-right text-[11px] tabular-nums outline-none disabled:cursor-not-allowed"
                                  onBlur={(event) => {
                                    if (!isTradeLoan) updateLoanMutation.mutate({ id: loan.id, input: { interestRate: parsePercentInput(event.target.value) / 100 } });
                                  }}
                                />
                                <span className="text-[10px] text-muted-foreground">%</span>
                              </div>
                            </td>
                            <td className="py-2 px-4 text-right whitespace-nowrap">
                              <Input
                                defaultValue={String(loan.annualPrincipalPayment)}
                                inputMode="decimal"
                                disabled={isTradeLoan}
                                className="h-8 w-32 ml-auto text-right text-xs tabular-nums"
                                onBlur={(event) => {
                                  if (!isTradeLoan) updateLoanMutation.mutate({ id: loan.id, input: { annualPrincipalPayment: parseAmountInput(event.target.value) } });
                                }}
                              />
                            </td>
                            <td className="py-2 px-4 text-right whitespace-nowrap">
                              <Input
                                defaultValue={String(loan.annualInterestPayment)}
                                inputMode="decimal"
                                disabled={isTradeLoan}
                                className="h-8 w-32 ml-auto text-right text-xs tabular-nums"
                                onBlur={(event) => {
                                  if (!isTradeLoan) updateLoanMutation.mutate({ id: loan.id, input: { annualInterestPayment: parseAmountInput(event.target.value) } });
                                }}
                              />
                            </td>
                            <td className="py-2 px-4 text-center">
                              <input
                                type="checkbox"
                                defaultChecked={loan.settleOnAssetSell}
                                disabled={isTradeLoan}
                                onChange={(event) => {
                                  if (!isTradeLoan) updateLoanMutation.mutate({ id: loan.id, input: { settleOnAssetSell: event.target.checked } });
                                }}
                              />
                            </td>
                            <td className="py-2 pl-4 text-muted-foreground min-w-[180px]">
                              {isTradeLoan ? "Tự tạo từ Buy trade, sửa trong Trade." : loan.note || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-3 md:grid-cols-[1.2fr_0.8fr_1fr_1fr_1.5fr_auto] items-end border-t border-border/40 pt-4">
                  <label className="space-y-1.5 text-xs">
                      <span className="text-muted-foreground">Khoản vay</span>
                      <select
                        value={loanEventLoanId || String(forecastLoans[0]?.id ?? "")}
                        onChange={(event) => setLoanEventLoanId(event.target.value)}
                      className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      {forecastLoans.map((loan) => (
                        <option key={loan.id} value={String(loan.id)}>{loan.assetSymbol}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-foreground">Event thủ công chỉ áp dụng cho khoản vay DB.</span>
                  </label>
                  <label className="space-y-1.5 text-xs">
                    <span className="text-muted-foreground">Year</span>
                    <select
                      value={loanEventYear}
                      onChange={(event) => setLoanEventYear(event.target.value)}
                      className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      {FORECAST_YEARS.map((year) => (
                        <option key={year} value={String(year)}>{year}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-xs">
                    <span className="text-muted-foreground">Loại</span>
                    <select
                      value={loanEventType}
                      onChange={(event) => setLoanEventType(event.target.value as ForecastLoanEvent["eventType"])}
                      className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      {(["principal_payment", "interest", "drawdown", "settlement"] as const).map((type) => (
                        <option key={type} value={type}>{formatLoanEventType(type)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-xs">
                    <span className="text-muted-foreground">Amount</span>
                    <Input
                      value={loanEventAmount}
                      onChange={(event) => setLoanEventAmount(event.target.value)}
                      inputMode="decimal"
                      className="h-9 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5 text-xs">
                    <span className="text-muted-foreground">Note</span>
                    <Input
                      value={loanEventNote}
                      onChange={(event) => setLoanEventNote(event.target.value)}
                      className="h-9 text-xs"
                    />
                  </label>
                  <Button size="sm" className="h-9" onClick={submitLoanEvent} disabled={createLoanEventMutation.isPending || parseAmountInput(loanEventAmount) <= 0}>
                    Thêm
                  </Button>
                </div>

                {forecastLoanEvents.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-xs">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                          <th className="py-2 pr-4 text-left font-medium">Year</th>
                          <th className="py-2 px-4 text-left font-medium">Loan</th>
                          <th className="py-2 px-4 text-left font-medium">Type</th>
                          <th className="py-2 px-4 text-right font-medium">Amount</th>
                          <th className="py-2 px-4 text-left font-medium">Note</th>
                          <th className="py-2 pl-4 text-right font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {forecastLoanEvents.map((event) => {
                          const loan = forecastLoans.find((item) => item.id === event.loanId);
                          return (
                            <tr key={event.id}>
                              <td className="py-2 pr-4 font-medium whitespace-nowrap">{event.year}</td>
                              <td className="py-2 px-4 whitespace-nowrap">{loan?.assetSymbol ?? event.loanId}</td>
                              <td className="py-2 px-4 text-muted-foreground whitespace-nowrap">{formatLoanEventType(event.eventType)}</td>
                              <td className="py-2 px-4 text-right tabular-nums font-semibold whitespace-nowrap">{formatVNDFull(event.amount)}</td>
                              <td className="py-2 px-4 text-muted-foreground">{event.note || "—"}</td>
                              <td className="py-2 pl-4 text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-muted-foreground"
                                  onClick={() => deleteLoanEventMutation.mutate(event.id)}
                                  disabled={deleteLoanEventMutation.isPending}
                                >
                                  Xóa
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Card>
        </section>

        {/* ── Theo dõi khoản vay ───────────────────────────────────────── */}
        {(() => {
          const debtRows = loanScheduleRows.filter((row) =>
            row.openingDebt > 0 || row.drawdown > 0 || row.principalPayment > 0 || row.endingDebt > 0
          );
          const detailRows = loanDetailScheduleRows.filter((row) =>
            row.openingDebt > 0 || row.drawdown > 0 || row.principalPayment > 0 || row.settlement > 0 || row.endingDebt > 0
          );
          if (debtRows.length === 0) return null;
          return (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Loan forecast</p>
                <p className="text-[10px] text-muted-foreground">Trade sell tự tất toán khoản vay gắn tài sản khi bật settle</p>
              </div>
              <Card className="overflow-hidden">
                <div className="border-b border-border/40 px-4 py-3 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Khoản vay đầu 2026: {formatVNDFull(forecastLoansWithTradeBuys.reduce((sum, loan) => sum + (loan.startYear <= 2026 ? loan.principalStart : 0), 0))}
                  </span>
                  <span className="ml-2">
                    ({forecastLoansWithTradeBuys.map((loan) => `${loan.assetSymbol}${loan.startYear > 2026 ? ` ${loan.startYear}` : ""}: ${formatVNDFull(loan.principalStart)}`).join(" · ")})
                  </span>
                </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[2200px] text-xs">
                      <thead>
                        <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                          <th className="sticky left-0 z-[1] bg-card py-2 px-4 text-left font-normal">Nội dung</th>
                          {debtRows.map((row) => (
                            <th
                              key={`loan-total-year-${row.year}`}
                              className={`py-2 px-4 text-right font-normal ${row.year === new Date().getFullYear() ? "text-primary" : ""}`}
                            >
                              {row.year}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {[
                          { key: "openingDebt", label: "Nợ đầu năm", tone: "muted" },
                          { key: "drawdown", label: "Vay thêm", tone: "positive" },
                          { key: "interest", label: "Lãi vay", tone: "negative" },
                          { key: "principalPayment", label: "Trả gốc", tone: "negative" },
                          { key: "settlement", label: "Tất toán", tone: "negative" },
                          { key: "endingDebt", label: "Nợ cuối năm", tone: "debt" },
                        ].map((metric) => (
                          <tr key={metric.key}>
                            <td className="sticky left-0 z-[1] bg-card py-2.5 px-4 font-medium whitespace-nowrap">{metric.label}</td>
                            {debtRows.map((row) => {
                              const value = row[metric.key as keyof typeof row] as number;
                              const className =
                                metric.tone === "positive"
                                  ? value > 0 ? "text-emerald-400" : "text-muted-foreground"
                                  : metric.tone === "negative"
                                    ? value > 0 ? "text-red-300" : "text-muted-foreground"
                                    : metric.tone === "debt"
                                      ? value > 0 ? "text-amber-400 font-semibold" : "text-emerald-400 font-semibold"
                                      : "text-muted-foreground";
                              return (
                                <td key={`${metric.key}-${row.year}`} className={`py-2.5 px-4 text-right tabular-nums whitespace-nowrap ${className}`}>
                                  {value > 0 ? formatVNDFull(value) : metric.key === "endingDebt" ? "Đã trả hết" : "—"}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-border/40 px-4 py-3">
                    <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">Chi tiết theo từng khoản vay</p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[2200px] text-xs">
                        <thead>
                          <tr className="text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border">
                            <th className="sticky left-0 z-[1] bg-card py-2 pr-4 text-left font-normal">Khoản vay / nội dung</th>
                            {debtRows.map((row) => (
                              <th
                                key={`loan-detail-year-${row.year}`}
                                className={`py-2 px-4 text-right font-normal ${row.year === new Date().getFullYear() ? "text-primary" : ""}`}
                              >
                                {row.year}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {forecastLoansWithTradeBuys.flatMap((loan) => {
                            const rowsByYear = new Map(detailRows.filter((row) => row.loanId === loan.id).map((row) => [row.year, row]));
                            return [
                              <tr key={`loan-${loan.id}`} className="bg-muted/20">
                                <td colSpan={debtRows.length + 1} className="py-2 pr-4 font-semibold text-foreground">{loan.assetSymbol}</td>
                              </tr>,
                              ...[
                                { key: "openingDebt", label: "Nợ đầu năm", tone: "muted" },
                                { key: "drawdown", label: "Vay thêm", tone: "positive" },
                                { key: "interest", label: "Lãi vay", tone: "negative" },
                                { key: "principalPayment", label: "Trả gốc", tone: "negative" },
                                { key: "settlement", label: "Tất toán", tone: "negative" },
                                { key: "endingDebt", label: "Nợ cuối năm", tone: "debt" },
                              ].map((metric) => (
                                <tr key={`loan-${loan.id}-${metric.key}`}>
                                  <td className="sticky left-0 z-[1] bg-card py-2.5 pr-4 pl-6 font-medium whitespace-nowrap">{metric.label}</td>
                                  {debtRows.map((yearRow) => {
                                    const row = rowsByYear.get(yearRow.year);
                                    const value = row ? row[metric.key as keyof typeof row] as number : 0;
                                    const className =
                                      metric.tone === "positive"
                                        ? value > 0 ? "text-emerald-400" : "text-muted-foreground"
                                        : metric.tone === "negative"
                                          ? value > 0 ? "text-red-300" : "text-muted-foreground"
                                          : metric.tone === "debt"
                                            ? value > 0 ? "text-amber-400 font-semibold" : "text-emerald-400 font-semibold"
                                            : "text-muted-foreground";
                                    return (
                                      <td key={`loan-${loan.id}-${metric.key}-${yearRow.year}`} className={`py-2.5 px-4 text-right tabular-nums whitespace-nowrap ${className}`}>
                                        {value > 0 ? formatVNDFull(value) : metric.key === "endingDebt" ? "Đã trả hết" : "—"}
                                      </td>
                                    );
                                  })}
                                </tr>
                              )),
                            ];
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
              </Card>
            </section>
          );
        })()}

      </main>

      <Dialog open={tradeDialogOpen} onOpenChange={(open) => { if (!open) closeTradeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingTrade ? "Sửa trade forecast" : "Trade forecast"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">Side</span>
                <select
                  value={tradeSide}
                  onChange={(event) => setTradeSide(event.target.value as ForecastTrade["side"])}
                  className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="sell">Sell</option>
                  <option value="buy">Buy</option>
                </select>
              </label>
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">Year</span>
                <select
                  value={tradeYear}
                  onChange={(event) => setTradeYear(event.target.value)}
                  className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                >
                  {FORECAST_YEARS.map((year) => (
                    <option key={year} value={String(year)}>{year}</option>
                  ))}
                </select>
              </label>
            </div>

            {tradeSide === "sell" ? (
              <>
                <label className="space-y-1.5 text-xs block">
                  <span className="text-muted-foreground">Asset</span>
                  <select
                    value={tradeAssetKey}
                    onChange={(event) => setTradeAssetKey(event.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  >
                    {tradeAssetOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </label>

                {selectedTradeOption && (
                  <div className="rounded-md bg-muted/30 px-3 py-2 text-xs space-y-0.5">
                    <p className="text-muted-foreground">
                      {selectedTradeYear === currentYear ? "Giá trị current theo đầu tháng" : `Giá trị đầu năm ${selectedTradeYear} theo forecast`}
                    </p>
                    <p className="font-semibold tabular-nums">{formatVNDFull(selectedTradeOption.forecastStartValue)}</p>
                    {selectedTradeOption.soldByOtherTrades > 0 && (
                      <p className="text-[10px] text-muted-foreground">
                        Đã bán trong năm này: {formatVNDFull(selectedTradeOption.soldByOtherTrades)} · Còn có thể bán: {formatVNDFull(selectedTradeOption.currentValue)}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5 text-xs">
                  <span className="text-muted-foreground">Asset type</span>
                  <select
                    value={tradeBuyAssetTypeMode === "new" ? "__new__" : tradeBuyAssetType}
                    onChange={(event) => {
                      if (event.target.value === "__new__") {
                        setTradeBuyAssetTypeMode("new");
                        setTradeBuyAssetType("");
                      } else {
                        setTradeBuyAssetTypeMode("existing");
                        setTradeBuyAssetType(event.target.value);
                      }
                    }}
                    className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  >
                    {buyAssetTypeOptions.map((type) => (
                      <option key={type} value={type}>{formatTypeLabel(type)}</option>
                    ))}
                    <option value="__new__">Tạo mới</option>
                  </select>
                  {tradeBuyAssetTypeMode === "new" && (
                    <Input
                      value={tradeBuyAssetType}
                      onChange={(event) => setTradeBuyAssetType(event.target.value)}
                      placeholder="Nhập danh mục mới"
                      className="h-9 text-xs"
                    />
                  )}
                </label>
                <label className="space-y-1.5 text-xs">
                  <span className="text-muted-foreground">Asset name</span>
                  <Input
                    value={tradeBuySymbol}
                    onChange={(event) => setTradeBuySymbol(event.target.value)}
                    placeholder="Tên tài sản"
                    className="h-9 text-xs"
                  />
                </label>
              </div>
            )}

            <label className="space-y-1.5 text-xs block">
              <span className="flex items-center justify-between gap-3 text-muted-foreground">
                <span>{tradeSide === "buy" ? "Giá trị mua" : "Giá trị bán"}</span>
                {tradeSide === "sell" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={!selectedTradeOption || selectedTradeOption.currentValue <= 0}
                    onClick={fillFullSellAmount}
                  >
                    Bán hết
                  </Button>
                )}
              </span>
              <Input
                value={tradeAmount}
                onChange={(event) => setTradeAmount(event.target.value)}
                inputMode="decimal"
                placeholder="VD: 1000000000"
                className={`h-9 text-xs tabular-nums ${tradeAmountExceedsValue ? "border-red-400 focus-visible:ring-red-400" : ""}`}
              />
                  {tradeAmountExceedsValue && (
                  <p className="text-[10px] text-red-400 mt-1">
                  Giá bán ({formatVNDFull(roundVND(tradeAmountNum))}) vượt giá trị có thể bán năm {selectedTradeYear} ({formatVNDFull(selectedTradeCurrentValue)})
                </p>
              )}
            </label>

            {tradeSide === "buy" && (
              <div className="rounded-md border border-border p-3 text-xs space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-muted-foreground">Tỷ lệ vay</span>
                    <div className="flex h-9 items-center rounded-lg border border-input bg-background/50 px-3 focus-within:ring-2 focus-within:ring-ring">
                      <input
                        value={tradeLoanRatio}
                        onChange={(event) => setTradeLoanRatio(event.target.value)}
                        inputMode="decimal"
                        className="w-full bg-transparent text-right text-xs tabular-nums outline-none"
                      />
                      <span className="ml-1 text-muted-foreground">%</span>
                    </div>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-muted-foreground">Lãi suất vay/năm</span>
                    <div className="flex h-9 items-center rounded-lg border border-input bg-background/50 px-3 focus-within:ring-2 focus-within:ring-ring">
                      <input
                        value={tradeLoanRate}
                        onChange={(event) => setTradeLoanRate(event.target.value)}
                        inputMode="decimal"
                        className="w-full bg-transparent text-right text-xs tabular-nums outline-none"
                      />
                      <span className="ml-1 text-muted-foreground">%</span>
                    </div>
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-muted-foreground">Trả gốc/năm</span>
                    <Input
                      value={tradeLoanPrincipal}
                      onChange={(event) => setTradeLoanPrincipal(event.target.value)}
                      inputMode="decimal"
                      className="h-9 text-xs tabular-nums"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-muted-foreground">Lãi cố định/năm</span>
                    <Input
                      value={tradeLoanInterest}
                      onChange={(event) => setTradeLoanInterest(event.target.value)}
                      inputMode="decimal"
                      className="h-9 text-xs tabular-nums"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-muted-foreground">Kiểu trả nợ</span>
                    <select
                      value={tradeLoanRepaymentType}
                      onChange={(event) => setTradeLoanRepaymentType(event.target.value as ForecastLoan["repaymentType"])}
                      className="h-9 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="interest_only">Interest only</option>
                      <option value="principal_interest">Principal + interest</option>
                      <option value="bullet">Bullet</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={tradeSettleLoanOnSell}
                      onChange={(event) => setTradeSettleLoanOnSell(event.target.checked)}
                    />
                    <span className="text-muted-foreground">Tất toán vay khi bán</span>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-border/40 pt-3">
                  <p className="text-muted-foreground">Cash bỏ ra: <span className="font-semibold text-red-300 tabular-nums">{formatVNDFull(tradeCashPortion)}</span></p>
                  <p className="text-muted-foreground">Khoản vay tạo mới: <span className="font-semibold text-amber-300 tabular-nums">{formatVNDFull(tradeLoanPrincipalAmount)}</span></p>
                </div>
              </div>
            )}

            <label className="space-y-1.5 text-xs block">
              <span className="text-muted-foreground">Note</span>
              <Input
                value={tradeNote}
                onChange={(event) => setTradeNote(event.target.value)}
                placeholder="Tùy chọn"
                className="h-9 text-xs"
              />
            </label>

            {(createTradeMutation.isError || updateTradeMutation.isError) && (
              <p className="text-xs text-red-300">Không lưu được forecast trade.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeTradeDialog}>
              Hủy
            </Button>
            <Button
              size="sm"
              onClick={submitSellTrade}
              disabled={
                createTradeMutation.isPending ||
                updateTradeMutation.isPending ||
                tradeAmountNum <= 0 ||
                tradeAmountExceedsValue ||
                (tradeSide === "buy" && (!tradeBuyAssetType.trim() || !tradeBuySymbol.trim()))
              }
            >
              {editingTrade ? "Cập nhật" : tradeSide === "buy" ? "Lưu buy" : "Lưu sell"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
