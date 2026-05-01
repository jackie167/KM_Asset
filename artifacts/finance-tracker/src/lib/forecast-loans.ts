import { FORECAST_YEARS } from "@/lib/asset-forecast";
import type { ForecastTrade } from "@/lib/asset-forecast";

export type ForecastLoan = {
  id: number;
  assetType: string;
  assetSymbol: string;
  loanName: string;
  principalStart: number;
  interestRate: number;
  startYear: number;
  endYear: number | null;
  repaymentType: "interest_only" | "principal_interest" | "bullet" | "custom";
  annualPrincipalPayment: number;
  annualInterestPayment: number;
  settleOnAssetSell: boolean;
  status: "active" | "settled";
  note: string | null;
};

export type ForecastLoanEvent = {
  id: number;
  loanId: number;
  year: number;
  eventType: "drawdown" | "interest" | "principal_payment" | "settlement";
  amount: number;
  source: string;
  tradeId: number | null;
  note: string | null;
};

export type ForecastLoanEventInput = Omit<ForecastLoanEvent, "id" | "tradeId"> & { tradeId?: number | null };

export type ForecastLoanScheduleRow = {
  year: number;
  loanId?: number;
  loanName?: string;
  assetSymbol?: string;
  openingDebt: number;
  drawdown: number;
  interest: number;
  principalPayment: number;
  settlement: number;
  endingDebt: number;
};

function normalizeAssetMatcher(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

function isFinancialTrade(trade: Pick<ForecastTrade, "assetType" | "symbol">) {
  const financialTypes = new Set(["cash", "stock", "gold", "fund", "crypto"]);
  return financialTypes.has(trade.assetType.trim().toLowerCase()) ||
    financialTypes.has(trade.symbol.trim().toLowerCase());
}

function isExecutedForecastTrade(trade: Pick<ForecastTrade, "side" | "year" | "status">) {
  return trade.status === "executed" || (trade.side === "sell" && trade.year <= new Date().getFullYear());
}

export async function fetchForecastLoans(): Promise<ForecastLoan[]> {
  const res = await fetch("/api/asset-forecast/loans");
  if (!res.ok) throw new Error("Không đọc được forecast loans.");
  return res.json();
}

export async function updateForecastLoan(id: number, input: Partial<ForecastLoan>): Promise<ForecastLoan> {
  const res = await fetch(`/api/asset-forecast/loans/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Không cập nhật được forecast loan.");
  return res.json();
}

export async function fetchForecastLoanEvents(): Promise<ForecastLoanEvent[]> {
  const res = await fetch("/api/asset-forecast/loan-events");
  if (!res.ok) throw new Error("Không đọc được forecast loan events.");
  return res.json();
}

export async function createForecastLoanEvent(input: ForecastLoanEventInput): Promise<ForecastLoanEvent> {
  const res = await fetch("/api/asset-forecast/loan-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Không lưu được forecast loan event.");
  return res.json();
}

export async function deleteForecastLoanEvent(id: number): Promise<void> {
  const res = await fetch(`/api/asset-forecast/loan-events/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Không xóa được forecast loan event.");
}

export function buildForecastLoanSchedule(
  loans: ForecastLoan[],
  events: ForecastLoanEvent[],
  years = FORECAST_YEARS,
): ForecastLoanScheduleRow[] {
  const detailRows = buildForecastLoanDetailSchedule(loans, events, years);
  return years.map((year) => {
    const yearRows = detailRows.filter((row) => row.year === year);
    return {
      year,
      openingDebt: yearRows.reduce((sum, row) => sum + row.openingDebt, 0),
      drawdown: yearRows.reduce((sum, row) => sum + row.drawdown, 0),
      interest: yearRows.reduce((sum, row) => sum + row.interest, 0),
      principalPayment: yearRows.reduce((sum, row) => sum + row.principalPayment, 0),
      settlement: yearRows.reduce((sum, row) => sum + row.settlement, 0),
      endingDebt: yearRows.reduce((sum, row) => sum + row.endingDebt, 0),
    };
  });
}

export function buildForecastLoanEventsWithTradeSettlements(
  loans: ForecastLoan[],
  events: ForecastLoanEvent[],
  trades: ForecastTrade[],
): ForecastLoanEvent[] {
  const derivedEvents: ForecastLoanEvent[] = [];
  const sortedTrades = [...trades]
    .filter((trade) => trade.side === "sell" && !isFinancialTrade(trade))
    .sort((left, right) => left.year - right.year || left.id - right.id);

  for (const trade of sortedTrades) {
    let remainingCash = Math.max(0, trade.amount);
    const tradeAsset = normalizeAssetMatcher(trade.symbol);
    const matchedLoans = loans.filter((loan) =>
      loan.status === "active" &&
      loan.settleOnAssetSell &&
      normalizeAssetMatcher(loan.assetSymbol) === tradeAsset
    );

    for (const loan of matchedLoans) {
      if (remainingCash <= 0) break;
      const scheduleWithDerived = buildForecastLoanDetailSchedule(loans, [...events, ...derivedEvents]);
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
        source: isExecutedForecastTrade(trade) ? "executed_trade_sell" : "trade_sell",
        tradeId: trade.id,
        note: `Auto settle from sell ${trade.symbol}`,
      });
      remainingCash -= settlementAmount;
    }
  }

  return [...events, ...derivedEvents];
}

export function buildForecastLoanDetailSchedule(
  loans: ForecastLoan[],
  events: ForecastLoanEvent[],
  years = FORECAST_YEARS,
): ForecastLoanScheduleRow[] {
  const eventsByLoanYear = new Map<string, ForecastLoanEvent[]>();
  for (const event of events) {
    const key = `${event.loanId}::${event.year}`;
    eventsByLoanYear.set(key, [...(eventsByLoanYear.get(key) ?? []), event]);
  }

  const loanState = new Map(loans.map((loan) => [loan.id, loan.principalStart]));
  const rows: ForecastLoanScheduleRow[] = [];

  for (const year of years) {
    for (const loan of loans) {
      const starts = year >= loan.startYear;
      const ended = loan.endYear != null && year > loan.endYear;
      const startPrincipal = starts && !ended ? (loanState.get(loan.id) ?? loan.principalStart) : 0;
      let row: ForecastLoanScheduleRow = {
        year,
        loanId: loan.id,
        loanName: loan.loanName,
        assetSymbol: loan.assetSymbol,
        openingDebt: startPrincipal,
        drawdown: 0,
        interest: 0,
        principalPayment: 0,
        settlement: 0,
        endingDebt: startPrincipal,
      };

      if (!starts || ended || loan.status === "settled") {
        rows.push(row);
        continue;
      }

      const loanEvents = eventsByLoanYear.get(`${loan.id}::${year}`) ?? [];
      const eventDrawdown = loanEvents.filter((event) => event.eventType === "drawdown").reduce((sum, event) => sum + event.amount, 0);
      const eventPrincipal = loanEvents.filter((event) => event.eventType === "principal_payment").reduce((sum, event) => sum + event.amount, 0);
      const eventSettlement = loanEvents.filter((event) => event.eventType === "settlement").reduce((sum, event) => sum + event.amount, 0);
      const eventInterest = loanEvents.filter((event) => event.eventType === "interest").reduce((sum, event) => sum + event.amount, 0);
      const scheduledPrincipal = loan.repaymentType === "custom" ? 0 : loan.annualPrincipalPayment;
      const scheduledInterest = loan.annualInterestPayment || startPrincipal * loan.interestRate;
      const paidPrincipal = Math.min(Math.max(0, startPrincipal + eventDrawdown), scheduledPrincipal + eventPrincipal + eventSettlement);
      const endingPrincipal = Math.max(0, startPrincipal + eventDrawdown - paidPrincipal);
      const requestedPrincipal = scheduledPrincipal + eventPrincipal;
      const actualSettlement = Math.min(eventSettlement, paidPrincipal);
      const actualPrincipal = Math.max(0, paidPrincipal - actualSettlement);

      row = {
        ...row,
        drawdown: eventDrawdown,
        interest: scheduledInterest + eventInterest,
        principalPayment: Math.min(requestedPrincipal, actualPrincipal),
        settlement: actualSettlement,
        endingDebt: endingPrincipal,
      };
      loanState.set(loan.id, endingPrincipal);
      rows.push(row);
    }
  }

  return rows;
}

export function getForecastDebtForYear(loans: ForecastLoan[], events: ForecastLoanEvent[], year = new Date().getFullYear()) {
  const schedule = buildForecastLoanSchedule(loans, events);
  return schedule.find((row) => row.year === year)?.endingDebt ?? 0;
}
