import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useGetPortfolioSummary } from "@workspace/api-client-react";
import PageHeader from "@/pages/PageHeader";
import { Card } from "@/components/ui/card";
import type { HoldingItem } from "@/pages/assets/types";
import { formatVND, formatVNDFull } from "@/pages/assets/utils";
import { CASHFLOW_SOURCE_SHEET, fetchCashflowData, fetchTotalAssetData } from "@/lib/excel-sheets";
import { fetchWealthAllocationHoldings } from "@/pages/wealthAllocationData";

// ─── helpers ────────────────────────────────────────────────────────────────

const STOCK_RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");

function formatPercent(v: number | null | undefined, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
}

function pctOf(part: number, total: number) {
  return total > 0 ? part / total : null;
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

type DashboardTransaction = {
  side: string;
  status: string;
  fundingSource: string;
  symbol: string;
  totalValue: number;
  netAmount?: number | null;
  realizedInterest?: number | null;
  realizedPnl?: number | null;
};

type CashFlow = {
  kind: string;
  amount: number;
  occurredAt: string;
};

function buildRealizedPnLBySymbol(transactions: DashboardTransaction[] | undefined) {
  const realized = new Map<string, number>();
  for (const transaction of transactions ?? []) {
    if (transaction.side !== "sell" || transaction.status !== "applied") continue;
    const value = transaction.realizedPnl ?? transaction.realizedInterest ?? 0;
    if (!Number.isFinite(value)) continue;
    const symbol = normalizeSymbol(transaction.symbol);
    realized.set(symbol, (realized.get(symbol) ?? 0) + value);
  }
  return realized;
}

async function fetchCashFlows(): Promise<CashFlow[]> {
  const res = await fetch("/api/portfolio/cash-flows");
  if (!res.ok) return [];
  return res.json();
}

function calculateNetExternalCashFlow(cashFlows: CashFlow[] | undefined) {
  return (cashFlows ?? []).reduce((sum, flow) => {
    const occurredAt = new Date(flow.occurredAt);
    if (occurredAt < STOCK_RETURN_INITIAL_AT || occurredAt > new Date()) return sum;

    const kind = flow.kind.trim().toLowerCase();
    if (kind === "deposit" || kind === "contribution") return sum + flow.amount;
    if (kind === "withdrawal") return sum - flow.amount;
    return sum;
  }, 0);
}

function calculateCashCostBasis(transactions: DashboardTransaction[] | undefined, cashHolding: HoldingItem | undefined, cashFlows: CashFlow[] | undefined) {
  if (!cashHolding || cashHolding.costOfCapital == null) return null;

  const totalBuyFromCash = (transactions ?? []).reduce((sum, transaction) => {
    if (transaction.side !== "buy") return sum;
    if (transaction.status !== "applied") return sum;
    if (transaction.fundingSource.trim().toUpperCase() !== "CASH") return sum;
    return sum + (transaction.netAmount ?? transaction.totalValue);
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
    return (holding.currentValue ?? 0) - costBasis;
  }
  const costBasis = holding.costBasisRemaining ?? holding.costOfCapital ?? 0;
  const currentValue = holding.currentValue ?? 0;
  return currentValue - costBasis + resolveRealizedPnL(holding, realizedPnLBySymbol);
}

type Tone = "positive" | "negative" | "neutral" | "warn";
function tone(v: number | null | undefined, positiveThreshold = 0): Tone {
  if (v == null) return "neutral";
  return v >= positiveThreshold ? "positive" : "negative";
}

const TONE_CLASS: Record<Tone, string> = {
  positive: "text-emerald-400",
  negative: "text-red-400",
  warn: "text-amber-400",
  neutral: "text-foreground",
};

// ─── fetchers ────────────────────────────────────────────────────────────────

async function fetchXirr() {
  const res = await fetch("/api/portfolio/xirr");
  const data = await res.json().catch(() => null);
  return {
    xirrAnnual: typeof data?.xirrAnnual === "number" ? data.xirrAnnual : null,
    xirrMonthly: typeof data?.xirrMonthly === "number" ? data.xirrMonthly : null,
  };
}

async function fetchTransactions() {
  const res = await fetch("/api/transactions");
  if (!res.ok) return [];
  return res.json() as Promise<DashboardTransaction[]>;
}


// ─── sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  tone: t = "neutral",
  loading = false,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  loading?: boolean;
  href?: string;
}) {
  const content = (
    <Card className={`p-4 space-y-1 ${href ? "hover:border-primary/60 hover:shadow-[0_0_0_1px_hsl(var(--primary))] transition cursor-pointer" : ""}`}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</p>
      {loading ? (
        <div className="h-7 w-28 rounded bg-muted animate-pulse" />
      ) : (
        <p className={`text-base md:text-xl font-bold tabular-nums break-all leading-snug ${TONE_CLASS[t]}`}>{value}</p>
      )}
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

type HealthRowProps = {
  label: string;
  value: string;
  pct: number | null;
  low: number;
  high: number;
  hint: string;
};

function HealthRow({ label, value, pct, low, high, hint }: HealthRowProps) {
  const status: Tone =
    pct == null ? "neutral" : pct < low ? "warn" : pct > high ? "warn" : "positive";
  const barPct = pct != null ? Math.min(Math.round(pct * 100), 100) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground font-medium">{label}</span>
        <span className={TONE_CLASS[status]}>{value}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            status === "positive" ? "bg-emerald-500" : status === "warn" ? "bg-amber-400" : "bg-red-400"
          }`}
          style={{ width: `${barPct}%` }}
        />
        {/* target band markers */}
        <div
          className="absolute top-0 h-full w-px bg-white/30"
          style={{ left: `${low * 100}%` }}
        />
        <div
          className="absolute top-0 h-full w-px bg-white/30"
          style={{ left: `${high * 100}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

// ─── main page ───────────────────────────────────────────────────────────────

export default function FinancialDashboardPage() {
  const [hideValues, setHideValues] = useState(() => localStorage.getItem("hide_values") === "1");

  const [wealthHoldings, setWealthHoldings] = useState<HoldingItem[]>([]);
  const [wealthLoading, setWealthLoading] = useState(false);

  const loadWealth = useCallback(async () => {
    setWealthLoading(true);
    try { setWealthHoldings(await fetchWealthAllocationHoldings()); }
    catch { /* silently ignore */ }
    finally { setWealthLoading(false); }
  }, []);

  useEffect(() => { loadWealth(); }, [loadWealth]);

  const investmentQuery = useGetPortfolioSummary();
  const xirrQuery = useQuery({ queryKey: ["portfolio-xirr"], queryFn: fetchXirr });
  const transactionsQuery = useQuery({ queryKey: ["transactions"], queryFn: fetchTransactions });
  const portfolioCashFlowsQuery = useQuery({ queryKey: ["portfolio-cash-flows"], queryFn: fetchCashFlows });
  const cashflowQuery = useQuery({ queryKey: ["excel-function-cashflow"], queryFn: fetchCashflowData });
  const totalAssetQuery = useQuery({ queryKey: ["excel-total-asset"], queryFn: fetchTotalAssetData });

  // ── derived values ─────────────────────────────────────────────────────────

  const netWorth = useMemo(
    () => wealthHoldings.reduce((s, h) => s + (h.currentValue ?? 0), 0),
    [wealthHoldings]
  );

  const investmentHoldings: HoldingItem[] = useMemo(
    () => investmentQuery.data?.holdings ?? [],
    [investmentQuery.data]
  );

  const financialTotal = useMemo(
    () => investmentHoldings.reduce((s, h) => s + (h.currentValue ?? 0), 0),
    [investmentHoldings]
  );

  const realizedPnLBySymbol = useMemo(
    () => buildRealizedPnLBySymbol(transactionsQuery.data),
    [transactionsQuery.data]
  );

  const cashCostBasis = useMemo(
    () => calculateCashCostBasis(transactionsQuery.data, investmentHoldings.find(isCashHolding), portfolioCashFlowsQuery.data),
    [investmentHoldings, portfolioCashFlowsQuery.data, transactionsQuery.data]
  );

  const costTotal = useMemo(
    () => investmentHoldings.reduce((sum, h) => {
      return sum + (isCashHolding(h)
        ? cashCostBasis ?? h.costOfCapital ?? 0
        : h.costBasisRemaining ?? h.costOfCapital ?? 0);
    }, 0),
    [cashCostBasis, investmentHoldings]
  );

  const pnl = useMemo(() => {
    const holdingSymbols = new Set(investmentHoldings.map((holding) => normalizeSymbol(holding.symbol)));
    const openHoldingPnL = investmentHoldings.reduce((sum, holding) => {
      return sum + calculateHoldingPnL(holding, realizedPnLBySymbol, cashCostBasis);
    }, 0);
    const closedPositionRealizedPnL = [...realizedPnLBySymbol.entries()].reduce((sum, [symbol, value]) => {
      return holdingSymbols.has(symbol) ? sum : sum + value;
    }, 0);
    return openHoldingPnL + closedPositionRealizedPnL;
  }, [cashCostBasis, investmentHoldings, realizedPnLBySymbol]);
  const pnlPct = pctOf(pnl, costTotal);
  const xirrAnnual = xirrQuery.data?.xirrAnnual ?? null;

  // Group investment by type for health ratios
  const byType = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of investmentHoldings) {
      const key = h.type.toLowerCase().trim();
      map.set(key, (map.get(key) ?? 0) + (h.currentValue ?? 0));
    }
    return map;
  }, [investmentHoldings]);

  const cashValue = byType.get("cash") ?? 0;
  const stockValue = byType.get("stock") ?? 0;
  const goldValue = byType.get("gold") ?? 0;
  const cryptoValue = byType.get("crypto") ?? 0;
  const fundValue = byType.get("fund") ?? byType.get("bond") ?? 0;

  const fmt = (v: number | null | undefined, full = false) =>
    hideValues ? "****" : full ? formatVNDFull(v) : formatVND(v);

  const investLoading = investmentQuery.isLoading;

  // ── health scores ──────────────────────────────────────────────────────────

  const cashRatio = pctOf(cashValue, financialTotal);       // target 15-30%
  const stockRatio = pctOf(stockValue, financialTotal);     // target 20-50%
  const goldRatio = pctOf(goldValue, financialTotal);       // target 5-20%
  const cryptoRatio = pctOf(cryptoValue, financialTotal);   // target <10%
  const financialRatio = pctOf(financialTotal, netWorth);   // target >20%

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Financial Dashboard"
        subtitle="Tổng quan sức khoẻ tài chính cá nhân"
        actions={[{
          kind: "item",
          label: hideValues ? "Hiện số liệu" : "Ẩn số liệu",
          onSelect: () => { const n = !hideValues; setHideValues(n); localStorage.setItem("hide_values", n ? "1" : "0"); },
        }]}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-6">

        {/* ── Tổng quan ─────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Tổng quan</p>
          <div className="grid grid-cols-2 gap-4">

            {/* Trái — Tài sản */}
            <div className="space-y-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Tài sản</p>
              <StatCard
                label="Tổng tài sản"
                value={fmt(netWorth, true)}
                sub="Tất cả danh mục"
                loading={wealthLoading}
                href="/wealth-allocation"
              />
              <StatCard
                label="Nợ"
                value={fmt(totalAssetQuery.data?.debt ?? null, true)}
                sub={netWorth > 0 && totalAssetQuery.data?.debt
                  ? `${formatPercent(totalAssetQuery.data.debt / netWorth)} tổng tài sản`
                  : undefined}
                tone="negative"
                loading={totalAssetQuery.isLoading}
              />
              <StatCard
                label="Tài sản ròng"
                value={fmt(netWorth > 0 ? netWorth - (totalAssetQuery.data?.debt ?? 0) : null, true)}
                sub="Sau khi trừ nợ"
                tone="positive"
                loading={wealthLoading || totalAssetQuery.isLoading}
              />
            </div>

            {/* Phải — Đầu tư */}
            <div className="space-y-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Đầu tư</p>
              <StatCard
                label="Tổng đầu tư"
                value={fmt(financialTotal, true)}
                sub={`${formatPercent(financialRatio)} tổng tài sản`}
                loading={investLoading}
                href="/assets"
              />
            <StatCard
              label="Lợi nhuận P/L"
              value={fmt(pnl, true)}
              sub={formatPercent(pnlPct)}
              tone={tone(pnl)}
              loading={investLoading}
            />
            <StatCard
              label="XIRR / Năm"
              value={formatPercent(xirrAnnual)}
              sub={xirrAnnual != null ? (xirrAnnual >= 0.1 ? "Trên mục tiêu 10%" : "Dưới mục tiêu 10%") : "Chưa có dữ liệu"}
              tone={xirrAnnual == null ? "neutral" : xirrAnnual >= 0.1 ? "positive" : xirrAnnual >= 0 ? "warn" : "negative"}
              loading={xirrQuery.isLoading}
            />
            </div>{/* end Đầu tư */}

          </div>{/* end grid cols-2 */}
        </section>

        {/* ── Chỉ báo sức khoẻ tài chính ──────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Chỉ báo sức khoẻ tài chính</p>
          <Card className="p-4 md:p-6 grid md:grid-cols-2 gap-6">

            {/* Cột trái — tỷ lệ phân bổ */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Cơ cấu tài chính</p>

              <HealthRow
                label="Tiền mặt"
                value={hideValues ? "****" : `${fmt(cashValue)} · ${formatPercent(cashRatio)}`}
                pct={cashRatio}
                low={0.15} high={0.30}
                hint="Mục tiêu 15–30% — quỹ dự phòng & thanh khoản"
              />
              <HealthRow
                label="Cổ phiếu"
                value={hideValues ? "****" : `${fmt(stockValue)} · ${formatPercent(stockRatio)}`}
                pct={stockRatio}
                low={0.20} high={0.50}
                hint="Mục tiêu 20–50% — tăng trưởng dài hạn"
              />
              <HealthRow
                label="Vàng"
                value={hideValues ? "****" : `${fmt(goldValue)} · ${formatPercent(goldRatio)}`}
                pct={goldRatio}
                low={0.05} high={0.20}
                hint="Mục tiêu 5–20% — phòng hộ lạm phát"
              />
              <HealthRow
                label="Quỹ đầu tư"
                value={hideValues ? "****" : `${fmt(fundValue)} · ${formatPercent(pctOf(fundValue, financialTotal))}`}
                pct={pctOf(fundValue, financialTotal)}
                low={0.05} high={0.30}
                hint="Mục tiêu 5–30% — đa dạng hoá thụ động"
              />
              <HealthRow
                label="Crypto"
                value={hideValues ? "****" : `${fmt(cryptoValue)} · ${formatPercent(cryptoRatio)}`}
                pct={cryptoRatio}
                low={0} high={0.10}
                hint="Nên dưới 10% — rủi ro cao"
              />
            </div>

            {/* Cột phải — chỉ số tổng quan */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Chỉ số tổng quan</p>

              <div className="space-y-3">
                {[
                  {
                    label: "Tỷ lệ tài sản tài chính / Tổng",
                    value: formatPercent(financialRatio),
                    tone: financialRatio != null && financialRatio >= 0.15 ? "positive" as Tone : "warn" as Tone,
                    desc: "Nên >15% tổng tài sản để có thanh khoản",
                  },
                  {
                    label: "Đa dạng hoá",
                    value: `${byType.size} loại tài sản`,
                    tone: byType.size >= 4 ? "positive" as Tone : byType.size >= 2 ? "warn" as Tone : "negative" as Tone,
                    desc: "Nên ≥4 loại để phân tán rủi ro",
                  },
                  {
                    label: "XIRR so với lạm phát (4%)",
                    value: formatPercent(xirrAnnual),
                    tone: xirrAnnual == null ? "neutral" as Tone : xirrAnnual >= 0.04 ? "positive" as Tone : "negative" as Tone,
                    desc: "Sinh lời thực dương khi XIRR > lạm phát",
                  },
                  {
                    label: "XIRR so với mục tiêu (10%)",
                    value: xirrAnnual != null ? (xirrAnnual >= 0.1 ? "Đạt" : "Chưa đạt") : "—",
                    tone: xirrAnnual == null ? "neutral" as Tone : xirrAnnual >= 0.1 ? "positive" as Tone : "warn" as Tone,
                    desc: "10%/năm là mức sinh lời dài hạn hợp lý",
                  },
                ].map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-4 border-b border-border/20 pb-3 last:border-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-xs text-foreground font-medium">{row.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{row.desc}</p>
                    </div>
                    <p className={`text-xs font-semibold whitespace-nowrap shrink-0 ${TONE_CLASS[row.tone]}`}>
                      {hideValues && row.label !== "Đa dạng hoá" && row.label !== "XIRR so với mục tiêu (10%)" ? "****" : row.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>

          </Card>
        </section>

        {/* ── Thu nhập & Dòng tiền ─────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Thu nhập & Dòng tiền
            {cashflowQuery.data && (
              <span className="ml-2 normal-case text-muted-foreground/60">năm {cashflowQuery.data.year}</span>
            )}
          </p>
          <Card className="p-4 md:p-6 grid md:grid-cols-2 gap-6">

            {/* Cột trái — tổng quan thu chi */}
            <div className="space-y-4">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Tổng quan năm</p>
              {cashflowQuery.isLoading ? (
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-5 rounded bg-muted animate-pulse" />)}</div>
              ) : !cashflowQuery.data ? (
                <p className="text-xs text-muted-foreground">Không thể đọc sheet {CASHFLOW_SOURCE_SHEET}.</p>
              ) : (
                <div className="space-y-3">
                  {[
                    { label: "Thu nhập năm",           value: fmt(cashflowQuery.data.income, true), t: "positive" as Tone },
                    { label: "Chi tiêu năm",            value: fmt(cashflowQuery.data.expense, true), t: "neutral" as Tone },
                    { label: "Tiết kiệm ròng",          value: fmt(cashflowQuery.data.income - cashflowQuery.data.expense, true), t: tone(cashflowQuery.data.income - cashflowQuery.data.expense) },
                    { label: "Thu nhập / tháng (ước)",  value: fmt(cashflowQuery.data.income / 12), t: "neutral" as Tone },
                    { label: "Gánh nặng lãi vay",       value: formatPercent(cashflowQuery.data.interestBurden), t: (cashflowQuery.data.interestBurden ?? 0) < 0.1 ? "positive" as Tone : "warn" as Tone },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-4 border-b border-border/20 py-2 first:pt-0 last:border-0 last:pb-0">
                      <p className="text-xs text-muted-foreground shrink-0">{row.label}</p>
                      <p className={`text-xs font-semibold tabular-nums text-right ${TONE_CLASS[row.t]}`}>
                        {hideValues ? "****" : row.value}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cột phải — chỉ số tỷ lệ */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Chỉ số dòng tiền</p>
              {cashflowQuery.isLoading || totalAssetQuery.isLoading ? (
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}</div>
              ) : (
                <div className="space-y-5">
                  <HealthRow
                    label="Tỷ lệ tiết kiệm"
                    value={formatPercent(cashflowQuery.data?.savingsRate)}
                    pct={cashflowQuery.data?.savingsRate ?? null}
                    low={0.20} high={0.50}
                    hint="Mục tiêu 20–50% thu nhập — nền tảng tích lũy"
                  />
                  <HealthRow
                    label="Gánh nặng lãi vay"
                    value={formatPercent(cashflowQuery.data?.interestBurden)}
                    pct={cashflowQuery.data?.interestBurden ?? null}
                    low={0} high={0.10}
                    hint="Nên dưới 10% thu nhập — an toàn tài chính"
                  />
                  <HealthRow
                    label="Tỷ lệ nợ / tổng tài sản"
                    value={formatPercent(totalAssetQuery.data?.debtRatio)}
                    pct={totalAssetQuery.data?.debtRatio ?? null}
                    low={0} high={0.30}
                    hint="Nên dưới 30% tổng tài sản"
                  />
                </div>
              )}
            </div>

          </Card>
        </section>

      </main>
    </div>
  );
}
