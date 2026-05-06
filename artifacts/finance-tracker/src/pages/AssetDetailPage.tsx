import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "wouter";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { formatVNDFull } from "@/pages/assets/utils";
import PageHeader from "@/pages/PageHeader";

// ─── types ────────────────────────────────────────────────────────────────────

type HoldingItem = {
  id: number;
  symbol: string;
  type: string;
  quantity: number;
  currentValue: number | null;
  currentPrice: number | null;
  costOfCapital: number | null;
  costBasisRemaining: number | null;
  realizedPnl: number | null;
  interest: number | null;
};

type TimelineEvent =
  | {
      eventType: "price";
      id: number;
      date: string;
      assetCode: string;
      priceOrValue: number;
      quantity: number | null;
      currentValue: number | null;
      source: string;
    }
  | {
      eventType: "transaction";
      id: number;
      date: string;
      assetCode: string;
      assetType: string;
      side: string;
      quantity: number;
      unitPrice: number | null;
      netAmount: number;
      realizedPnl: number | null;
      fundingSource: string;
      status: string;
      note: string | null;
    };

// ─── fetchers ─────────────────────────────────────────────────────────────────

async function fetchHolding(symbol: string): Promise<HoldingItem | null> {
  const res = await fetch("/api/portfolio/summary");
  if (!res.ok) return null;
  const data = await res.json();
  const h = (data.holdings ?? []).find(
    (x: HoldingItem) => x.symbol.toUpperCase() === symbol.toUpperCase()
  );
  return h ?? null;
}

async function fetchTimeline(symbol: string): Promise<TimelineEvent[]> {
  const res = await fetch(`/api/assets/${encodeURIComponent(symbol)}/timeline?limit=500`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.events ?? data ?? [];
}

// ─── xirr — same formula as Investment page ───────────────────────────────────

const RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");

function calculateSnapshotXirr(cost: number | null | undefined, currentValue: number | null | undefined): number | null {
  if (!cost || !currentValue || cost <= 0 || currentValue <= 0) return null;
  const years = (new Date().getTime() - RETURN_INITIAL_AT.getTime()) / (365 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(years) || years <= 0) return null;
  return Math.pow(currentValue / cost, 1 / years) - 1;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined) {
  if (v == null) return "—";
  return formatVNDFull(v);
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function fmtQty(v: number | null | undefined) {
  if (v == null) return "—";
  return v.toLocaleString("vi-VN", { maximumFractionDigits: 6 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function tone(v: number | null | undefined) {
  if (v == null) return "text-muted-foreground";
  return v >= 0 ? "text-emerald-400" : "text-red-400";
}

// ─── summary card ─────────────────────────────────────────────────────────────

function MetricBox({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${className ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function AssetDetailPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = (params.symbol ?? "").toUpperCase();

  const holdingQuery = useQuery({
    queryKey: ["asset-detail-holding", symbol],
    queryFn: () => fetchHolding(symbol),
    enabled: !!symbol,
  });

  const timelineQuery = useQuery({
    queryKey: ["asset-timeline", symbol],
    queryFn: () => fetchTimeline(symbol),
    enabled: !!symbol,
  });

  const h = holdingQuery.data;
  const timeline = timelineQuery.data ?? [];
  const trades = timeline
    .filter((e): e is Extract<TimelineEvent, { eventType: "transaction" }> => e.eventType === "transaction")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const currentValue = h?.currentValue ?? 0;
  const cost = h?.costBasisRemaining ?? h?.costOfCapital ?? 0;
  const realizedPnl = (h?.realizedPnl ?? 0) + (h?.interest ?? 0);
  const unrealizedPnl = currentValue > 0 && cost > 0 ? currentValue - cost : 0;
  const totalPnl = unrealizedPnl + realizedPnl;
  const pnlPct = cost > 0 ? totalPnl / cost : null;

  const totalBought = trades.filter(t => t.side === "buy").reduce((s, t) => s + t.netAmount, 0);
  const totalSold   = trades.filter(t => t.side === "sell").reduce((s, t) => s + t.netAmount, 0);

  const xirr = useMemo(
    () => calculateSnapshotXirr(cost, currentValue),
    [cost, currentValue]
  );
  const xirrMonthly = xirr != null ? Math.pow(1 + xirr, 1 / 12) - 1 : null;

  const isLoading = holdingQuery.isLoading || timelineQuery.isLoading;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title={symbol}
        subtitle={h ? `${h.type} · ${fmtQty(h.quantity)} đơn vị` : undefined}
        inlineRight={
          <Link href="/assets" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            ← Investment
          </Link>
        }
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-4">
        {isLoading && (
          <div className="space-y-3">
            {[1, 2].map(i => <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />)}
          </div>
        )}

        {!isLoading && (
          <>
            {/* ── Summary ──────────────────────────────────────────────── */}
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground uppercase tracking-widest">Tổng quan</p>
              </div>
              <p className="text-2xl md:text-3xl font-bold tabular-nums">{fmt(currentValue)}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3 pt-1">
                <MetricBox label="Vốn đầu tư" value={fmt(cost)} />
                <MetricBox label="Unrealized P/L" value={fmt(unrealizedPnl)} className={tone(unrealizedPnl)} />
                <MetricBox label="Realized P/L" value={fmt(realizedPnl)} className={tone(realizedPnl)} />
                <MetricBox label="Total P/L" value={fmt(totalPnl)} className={tone(totalPnl)} />
                <MetricBox label="P/L %" value={fmtPct(pnlPct)} className={tone(pnlPct)} />
                <MetricBox label="Giá hiện tại" value={fmt(h?.currentPrice)} />
                <MetricBox
                  label="XIRR Year"
                  value={xirr != null ? fmtPct(xirr) : "—"}
                  className={xirr != null ? tone(xirr) : "text-muted-foreground"}
                />
                <MetricBox
                  label="XIRR Month"
                  value={xirrMonthly != null ? fmtPct(xirrMonthly) : "—"}
                  className={xirrMonthly != null ? tone(xirrMonthly) : "text-muted-foreground"}
                />
              </div>
            </Card>

            {/* ── Cash flow summary ────────────────────────────────────── */}
            {trades.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Card className="p-3 space-y-1">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Tổng mua</p>
                  <p className="text-sm font-semibold tabular-nums">{fmt(totalBought)}</p>
                </Card>
                <Card className="p-3 space-y-1">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Tổng bán</p>
                  <p className="text-sm font-semibold tabular-nums text-emerald-400">{fmt(totalSold)}</p>
                </Card>
                <Card className="p-3 space-y-1">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Số giao dịch</p>
                  <p className="text-sm font-semibold tabular-nums">{trades.length}</p>
                </Card>
              </div>
            )}

            {/* ── Trade history ─────────────────────────────────────────── */}
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-semibold uppercase tracking-widest">Lịch sử giao dịch</p>
              </div>
              {trades.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Chưa có giao dịch nào.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                        <th className="py-2 px-4 text-left font-medium">Ngày</th>
                        <th className="py-2 px-4 text-center font-medium">Loại</th>
                        <th className="py-2 px-4 text-right font-medium">SL</th>
                        <th className="py-2 px-4 text-right font-medium">Giá đơn vị</th>
                        <th className="py-2 px-4 text-right font-medium">Giá trị</th>
                        <th className="py-2 px-4 text-right font-medium">Realized P/L</th>
                        <th className="py-2 px-4 text-left font-medium">Nguồn</th>
                        <th className="py-2 px-4 text-left font-medium">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {trades.map(t => (
                        <tr key={t.id} className="hover:bg-muted/20 transition-colors">
                          <td className="py-2 px-4 whitespace-nowrap">{fmtDate(t.date)}</td>
                          <td className="py-2 px-4 text-center">
                            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              t.side === "buy" ? "bg-emerald-400/15 text-emerald-400" : "bg-red-400/15 text-red-400"
                            }`}>
                              {t.side === "buy" ? "Mua" : "Bán"}
                            </span>
                          </td>
                          <td className="py-2 px-4 text-right tabular-nums">{fmtQty(t.quantity)}</td>
                          <td className="py-2 px-4 text-right tabular-nums">{fmt(t.unitPrice)}</td>
                          <td className="py-2 px-4 text-right tabular-nums font-medium">{fmt(t.netAmount)}</td>
                          <td className={`py-2 px-4 text-right tabular-nums ${tone(t.realizedPnl)}`}>
                            {t.realizedPnl != null ? fmt(t.realizedPnl) : "—"}
                          </td>
                          <td className="py-2 px-4 text-muted-foreground">{t.fundingSource || "—"}</td>
                          <td className="py-2 px-4">
                            <span className={`text-[10px] ${t.status === "applied" ? "text-emerald-400" : "text-amber-400"}`}>
                              {t.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
