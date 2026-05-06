import { Eye, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";

type SummaryMetric = {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
};

type PortfolioSummaryCardProps = {
  title?: string;
  totalValueLabel: string;
  hideValues: boolean;
  onToggleHideValues: () => void;
  metrics?: SummaryMetric[];
};

export default function PortfolioSummaryCard({
  title = "Portfolio Value",
  totalValueLabel,
  hideValues,
  onToggleHideValues,
  metrics = [],
}: PortfolioSummaryCardProps) {
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground uppercase tracking-widest">{title}</p>
        <button
          type="button"
          onClick={onToggleHideValues}
          className="inline-flex items-center justify-center h-7 w-7 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors"
          aria-label={hideValues ? "Show values" : "Hide values"}
        >
          {hideValues ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight break-all leading-tight">{totalValueLabel}</p>
      {metrics.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
          {metrics.map((metric) => (
            <div key={metric.label} className="space-y-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{metric.label}</p>
              <p
                className={`text-sm font-semibold tabular-nums ${
                  metric.tone === "positive"
                    ? "text-emerald-400"
                    : metric.tone === "negative"
                      ? "text-red-400"
                      : "text-foreground"
                }`}
              >
                {hideValues ? "****" : metric.value}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
