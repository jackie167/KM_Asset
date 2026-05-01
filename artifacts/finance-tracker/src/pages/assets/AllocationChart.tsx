import { useMemo, useState } from "react";
import { BarChart, Bar, Cell, LabelList, Tooltip, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/card";
import type { HoldingItem } from "@/pages/assets/types";
import { formatVND, typeLabel } from "@/pages/assets/utils";

const PIE_COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(43, 96%, 56%)",
  "hsl(142, 71%, 45%)",
  "hsl(280, 65%, 60%)",
  "hsl(0, 72%, 60%)",
];

type AllocationChartProps = {
  holdings: HoldingItem[];
  totalValue: number;
  onTypeSelect?: (type: string) => void;
  title?: string;
  groupBy?: (holding: HoldingItem) => string;
  comparisonTotalValue?: number;
  comparisonShareLabel?: string;
};

export default function AllocationChart({
  holdings,
  totalValue,
  onTypeSelect,
  title = "Asset Allocation",
  groupBy = (holding) => holding.type.toLowerCase(),
  comparisonTotalValue,
  comparisonShareLabel = "Total Share",
}: AllocationChartProps) {
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const data = useMemo(() => {
    const typeMap = new Map<string, number>();
    for (const holding of holdings ?? []) {
      if (holding.currentValue == null || holding.currentValue <= 0) continue;
      const normalizedType = groupBy(holding).toLowerCase();
      typeMap.set(normalizedType, (typeMap.get(normalizedType) ?? 0) + holding.currentValue);
    }
    const entries = Array.from(typeMap.entries());
    entries.sort(([, a], [, b]) => (sortDir === "desc" ? b - a : a - b));
    return entries.map(([type, value], index) => ({
      type,
      name: typeLabel(type),
      value,
      pct: totalValue > 0 ? (value / totalValue) * 100 : 0,
      comparisonPct: comparisonTotalValue && comparisonTotalValue > 0 ? (value / comparisonTotalValue) * 100 : null,
      color: PIE_COLORS[index % PIE_COLORS.length],
    }));
  }, [comparisonTotalValue, groupBy, holdings, totalValue, sortDir]);

  if (data.length === 0) return null;

  return (
    <Card className="p-4 min-w-0 w-full">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-muted-foreground uppercase tracking-widest">{title}</p>
        <div className="flex gap-1">
          <button
            onClick={() => setSortDir("desc")}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              sortDir === "desc"
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/50"
            }`}
          >
            High → Low
          </button>
          <button
            onClick={() => setSortDir("asc")}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              sortDir === "asc"
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/50"
            }`}
          >
            Low → High
          </button>
        </div>
      </div>

      <div style={{ height: 160 }}>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart
            data={data}
            barSize={44}
            barCategoryGap="30%"
            margin={{ top: 18, right: 8, left: 8, bottom: 0 }}
          >
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide />
            <Tooltip
              formatter={(value: number, _name: string, props: { payload?: { name: string; pct: number } }) => [
                `${formatVND(value)} (${props.payload?.pct?.toFixed(1) ?? 0}%)`,
                props.payload?.name ?? "",
              ]}
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList
                dataKey="pct"
                position="top"
                style={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                formatter={(value: number) => `${value.toFixed(1)}%`}
              />
              {data.map((entry) => (
                <Cell
                  key={entry.type}
                  fill={entry.color}
                  cursor={onTypeSelect ? "pointer" : "default"}
                  onClick={() => onTypeSelect?.(entry.type)}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto mt-1">
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr className="text-[9px] text-muted-foreground uppercase tracking-wider">
              <th className="py-1.5 pr-6 text-left font-normal border-b border-border">Asset Type</th>
              <th className="py-1.5 px-4 text-center font-normal border-b border-border">Share</th>
              {comparisonTotalValue != null && (
                <th className="py-1.5 px-4 text-center font-normal border-b border-border">{comparisonShareLabel}</th>
              )}
              <th className="py-1.5 pl-6 text-right font-normal border-b border-border">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((entry, index) => (
              <tr
                key={entry.type}
                className={`${index < data.length - 1 ? "border-b border-border" : ""} ${
                  onTypeSelect ? "cursor-pointer hover:bg-muted/40 transition-colors" : ""
                }`}
                onClick={() => onTypeSelect?.(entry.type)}
              >
                <td className="py-2.5 pr-6">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: entry.color }} />
                    <span className="text-sm font-medium whitespace-nowrap">{entry.name}</span>
                  </div>
                </td>
                <td className="py-2.5 px-4 text-[11px] text-center tabular-nums font-medium">
                  {entry.pct.toFixed(1)}%
                </td>
                {comparisonTotalValue != null && (
                  <td className="py-2.5 px-4 text-[11px] text-center tabular-nums text-muted-foreground">
                    {entry.comparisonPct != null ? `${entry.comparisonPct.toFixed(1)}%` : "—"}
                  </td>
                )}
                <td className="py-2.5 pl-6 text-[11px] font-semibold text-right tabular-nums whitespace-nowrap">
                  {formatVND(entry.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
