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
  const eventsByLoanYear = new Map<string, ForecastLoanEvent[]>();
  for (const event of events) {
    const key = `${event.loanId}::${event.year}`;
    eventsByLoanYear.set(key, [...(eventsByLoanYear.get(key) ?? []), event]);
  }

  const loanState = new Map(loans.map((loan) => [loan.id, loan.principalStart]));

  return years.map((year) => {
    let openingDebt = 0;
    let drawdown = 0;
    let principalPayment = 0;
    let settlement = 0;
    let interest = 0;

    for (const loan of loans) {
      const starts = year >= loan.startYear;
      const ended = loan.endYear != null && year > loan.endYear;
      const startPrincipal = starts && !ended ? (loanState.get(loan.id) ?? loan.principalStart) : 0;
      openingDebt += startPrincipal;
      if (!starts || ended || loan.status === "settled") continue;

      const loanEvents = eventsByLoanYear.get(`${loan.id}::${year}`) ?? [];
      const eventDrawdown = loanEvents.filter((event) => event.eventType === "drawdown").reduce((sum, event) => sum + event.amount, 0);
      const eventPrincipal = loanEvents.filter((event) => event.eventType === "principal_payment").reduce((sum, event) => sum + event.amount, 0);
      const eventSettlement = loanEvents.filter((event) => event.eventType === "settlement").reduce((sum, event) => sum + event.amount, 0);
      const eventInterest = loanEvents.filter((event) => event.eventType === "interest").reduce((sum, event) => sum + event.amount, 0);
      const scheduledPrincipal = loan.repaymentType === "custom" ? 0 : loan.annualPrincipalPayment;
      const scheduledInterest = loan.annualInterestPayment || startPrincipal * loan.interestRate;
      const paidPrincipal = Math.min(Math.max(0, startPrincipal + eventDrawdown), scheduledPrincipal + eventPrincipal + eventSettlement);
      const endingPrincipal = Math.max(0, startPrincipal + eventDrawdown - paidPrincipal);

      drawdown += eventDrawdown;
      principalPayment += scheduledPrincipal + eventPrincipal;
      settlement += eventSettlement;
      interest += scheduledInterest + eventInterest;
      loanState.set(loan.id, endingPrincipal);
    }

    return {
      year,
      openingDebt,
      drawdown,
      interest,
      principalPayment,
      settlement,
      endingDebt: Math.max(0, openingDebt + drawdown - principalPayment - settlement),
    };
  });
}

export function getForecastDebtForYear(loans: ForecastLoan[], events: ForecastLoanEvent[], year = new Date().getFullYear()) {
  const schedule = buildForecastLoanSchedule(loans, events);
  return schedule.find((row) => row.year === year)?.endingDebt ?? 0;
}
