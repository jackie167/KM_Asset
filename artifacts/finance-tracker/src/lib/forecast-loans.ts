import { FORECAST_YEARS } from "@/lib/asset-forecast";

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
