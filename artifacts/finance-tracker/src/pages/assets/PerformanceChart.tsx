import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import type { ChartPoint, SnapshotRange } from "@/pages/assets/types";
import { formatVND, formatVNDFull } from "@/pages/assets/utils";

const RANGE_OPTIONS: Array<{ value: SnapshotRange; label: string }> = [
  { value: "1m", label: "1 month" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "1y", label: "1 year" },
];

type PerformanceChartProps = {
  title?: string;
  seriesLabel?: string;
  emptyMessage?: string;
  chartData: ChartPoint[];
  hideValues: boolean;
  selectedRange: SnapshotRange;
  onRangeChange: (range: SnapshotRange) => void;
};

export default function PerformanceChart({
  title = "Performance",
  seriesLabel = "Total",
  emptyMessage = "No historical data yet.",
  chartData,
  hideValues,
  selectedRange,
  onRangeChange,
}: PerformanceChartProps) {
  const rangeControls = (
    <div className="flex flex-wrap gap-1">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onRangeChange(option.value)}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            selectedRange === option.value
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-primary/50"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  if (chartData.length > 0) {
    return (
      <Card className="p-4 min-w-0 w-full">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-xs text-muted-foreground uppercase tracking-widest">{title}</p>
          {rangeControls}
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(value) => (hideValues ? "" : formatVND(value))}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              formatter={(value: number) => [hideValues ? "****" : formatVNDFull(value), seriesLabel]}
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Area
              type="monotone"
              dataKey="totalValue"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#colorTotal)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-xs text-muted-foreground uppercase tracking-widest">{title}</p>
        {rangeControls}
      </div>
      <p className="text-sm text-muted-foreground text-center py-6">{emptyMessage}</p>
    </Card>
  );
}
