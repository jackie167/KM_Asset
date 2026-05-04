import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/pages/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// ─── types ────────────────────────────────────────────────────────────────────

type DataQuality = {
  missing_prices: string[];
  stale_prices: { asset_code: string; days_old: number }[];
  negative_cash: boolean;
  base_assets_note: string;
  xirr_note: string;
  last_price_update: string | null;
  issues_count: number;
};

type AIContext = {
  as_of: string;
  dashboard_summary: Record<string, unknown>;
  current_allocation: Record<string, unknown>[];
  current_holdings: Record<string, unknown>[];
  loans_summary: Record<string, unknown>;
  cashflow_summary: Record<string, unknown>[];
  data_quality: DataQuality;
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("vi-VN");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded border border-border hover:border-primary"
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

function Section({ title, data, defaultOpen = false }: { title: string; data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const json = JSON.stringify(data, null, 2);
  return (
    <Card className="overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-xs font-mono font-semibold">{title}</span>
        <div className="flex items-center gap-2">
          <CopyButton text={json} />
          <span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && (
        <pre className="px-4 pb-4 text-[11px] leading-relaxed font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap border-t border-border/40 bg-muted/10">
          {json}
        </pre>
      )}
    </Card>
  );
}

// ─── data_quality panel ───────────────────────────────────────────────────────

function DataQualityPanel({ dq }: { dq: DataQuality }) {
  const ok    = dq.issues_count === 0;
  const color = ok ? "text-emerald-400" : "text-amber-400";

  return (
    <Card className={`p-4 border ${ok ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono font-semibold">data_quality</span>
        <span className={`text-xs font-semibold ${color}`}>
          {ok ? "✓ No issues" : `⚠ ${dq.issues_count} issue${dq.issues_count > 1 ? "s" : ""}`}
        </span>
      </div>
      <div className="space-y-2 text-[11px]">
        <Row label="Last price update" value={fmtDate(dq.last_price_update)} />
        <Row
          label="Missing prices"
          value={dq.missing_prices.length === 0 ? "None" : dq.missing_prices.join(", ")}
          warn={dq.missing_prices.length > 0}
        />
        <Row
          label="Stale prices (>7d)"
          value={dq.stale_prices.length === 0
            ? "None"
            : dq.stale_prices.map((s) => `${s.asset_code} (${s.days_old}d)`).join(", ")
          }
          warn={dq.stale_prices.length > 0}
        />
        <Row label="Negative cash" value={dq.negative_cash ? "Yes" : "No"} warn={dq.negative_cash} />
        <Row label="Notes" value={`${dq.base_assets_note} · ${dq.xirr_note}`} />
      </div>
    </Card>
  );
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-36 shrink-0">{label}</span>
      <span className={warn ? "text-amber-400 font-semibold" : "text-foreground"}>{value}</span>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function DebugAIPage() {
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery<AIContext>({
    queryKey: ["ai-context"],
    queryFn: async () => {
      const res = await fetch("/api/ai/context");
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="AI Debug"
        subtitle="Dữ liệu AI đọc từ backend — kiểm tra trước khi tin vào phân tích"
        inlineRight={
          <div className="flex items-center gap-3">
            {dataUpdatedAt > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {fmtDate(new Date(dataUpdatedAt).toISOString())}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => refetch()}
              disabled={isLoading}
            >
              {isLoading ? "Loading…" : "↺ Refresh"}
            </Button>
          </div>
        }
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-4">

        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <Card className="p-4 border-red-500/20 bg-red-500/5">
            <p className="text-sm text-red-400">Không thể tải data. Kiểm tra backend.</p>
          </Card>
        )}

        {data && (
          <>
            {/* as_of timestamp */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono">as_of:</span>
              <span>{fmtDate(data.as_of)}</span>
              <CopyButton text={JSON.stringify(data, null, 2)} />
              <span className="ml-1 text-muted-foreground/60">← copy toàn bộ context</span>
            </div>

            {/* data_quality — always visible */}
            <DataQualityPanel dq={data.data_quality} />

            {/* sections */}
            <Section title="dashboard_summary"  data={data.dashboard_summary}  defaultOpen />
            <Section title="current_allocation" data={data.current_allocation} />
            <Section title="current_holdings"   data={data.current_holdings}   />
            <Section title="loans_summary"       data={data.loans_summary}      />
            <Section title="cashflow_summary"    data={data.cashflow_summary}   />
          </>
        )}
      </main>
    </div>
  );
}
