import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Plus } from "lucide-react";
import PageHeader from "@/pages/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ─── constants ────────────────────────────────────────────────────────────────

const YEAR_START = 2026;
const YEAR_END = 2044;
const YEARS = Array.from({ length: YEAR_END - YEAR_START + 1 }, (_, i) => YEAR_START + i);
const CURRENT_YEAR = new Date().getFullYear();

const SOURCE_TYPES = [
  { value: "salary",     label: "Lương" },
  { value: "business",   label: "Kinh doanh" },
  { value: "rental",     label: "Cho thuê" },
  { value: "investment", label: "Đầu tư" },
  { value: "other",      label: "Khác" },
] as const;

const COLOR_PRESETS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

// ─── types ────────────────────────────────────────────────────────────────────

type IncomeSource = {
  id: number;
  name: string;
  type: string;
  color: string;
  sortOrder: number;
  active: boolean;
  note: string | null;
};

type IncomeForecastEntry = {
  id: number;
  sourceId: number;
  year: number;
  amount: string;
  note: string | null;
};

// key: `${sourceId}-${year}`
type CellMap = Record<number, Record<number, number>>;

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatCell(amount: number): string {
  if (amount <= 0) return "—";
  return Math.round(amount).toLocaleString("vi-VN");
}

function typeLabel(type: string) {
  return SOURCE_TYPES.find((t) => t.value === type)?.label ?? type;
}

// ─── fetchers ─────────────────────────────────────────────────────────────────

async function fetchSources(): Promise<IncomeSource[]> {
  const res = await fetch("/api/income-sources");
  if (!res.ok) return [];
  return res.json();
}

async function fetchEntries(): Promise<IncomeForecastEntry[]> {
  const res = await fetch("/api/income-forecast");
  if (!res.ok) return [];
  return res.json();
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function IncomeForecastPage() {
  const qc = useQueryClient();

  const [editMode, setEditMode] = useState(false);
  const [cells, setCells] = useState<CellMap>({});
  const [showAdd, setShowAdd] = useState(false);
  const [newSrc, setNewSrc] = useState({ name: "", type: "salary", color: COLOR_PRESETS[0]! });

  const sourcesQ = useQuery({ queryKey: ["income-sources"], queryFn: fetchSources });
  const entriesQ = useQuery({ queryKey: ["income-forecast"], queryFn: fetchEntries });

  const sources = sourcesQ.data ?? [];
  const entries = entriesQ.data ?? [];

  // Build a cell map from DB data
  const dbCells = useMemo<CellMap>(() => {
    const map: CellMap = {};
    for (const e of entries) {
      map[e.sourceId] ??= {};
      map[e.sourceId]![e.year] = Number(e.amount);
    }
    return map;
  }, [entries]);

  const displayCells = editMode ? cells : dbCells;

  // Year totals across all sources
  const yearTotals = useMemo(() => {
    const t: Record<number, number> = {};
    for (const year of YEARS) {
      t[year] = sources.reduce((s, src) => s + (displayCells[src.id]?.[year] ?? 0), 0);
    }
    return t;
  }, [displayCells, sources]);

  // ── edit helpers ─────────────────────────────────────────────────────────────

  const enterEdit = () => {
    const copy: CellMap = {};
    for (const src of sources) copy[src.id] = { ...(dbCells[src.id] ?? {}) };
    setCells(copy);
    setEditMode(true);
  };

  const cancelEdit = () => { setEditMode(false); setCells({}); };

  const setCell = (srcId: number, year: number, val: number) => {
    setCells((prev) => ({
      ...prev,
      [srcId]: { ...prev[srcId], [year]: val },
    }));
  };

  // ── mutations ─────────────────────────────────────────────────────────────────

  const saveMut = useMutation({
    mutationFn: async (payload: { sourceId: number; year: number; amount: number }[]) => {
      const res = await fetch("/api/income-forecast", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: payload }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["income-forecast"] });
      setEditMode(false);
      setCells({});
    },
  });

  const addMut = useMutation({
    mutationFn: async (data: typeof newSrc) => {
      const res = await fetch("/api/income-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<IncomeSource>;
    },
    onSuccess: (src) => {
      qc.invalidateQueries({ queryKey: ["income-sources"] });
      if (editMode) setCells((prev) => ({ ...prev, [src.id]: {} }));
      setShowAdd(false);
      setNewSrc({ name: "", type: "salary", color: COLOR_PRESETS[0]! });
    },
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/income-sources/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["income-sources"] });
      qc.invalidateQueries({ queryKey: ["income-forecast"] });
      setCells((prev) => { const n = { ...prev }; delete n[id]; return n; });
    },
  });

  // ── save handler ──────────────────────────────────────────────────────────────

  const handleSave = () => {
    const payload: { sourceId: number; year: number; amount: number }[] = [];
    for (const src of sources) {
      for (const year of YEARS) {
        const amount = cells[src.id]?.[year] ?? 0;
        if (amount > 0) payload.push({ sourceId: src.id, year, amount });
      }
    }
    saveMut.mutate(payload);
  };

  const isLoading = sourcesQ.isLoading || entriesQ.isLoading;

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Kế hoạch thu nhập"
        subtitle="Dự báo thu nhập từng nguồn đến năm 2044"
        inlineRight={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1"
              onClick={() => setShowAdd(true)}
            >
              <Plus size={12} />
              Thêm nguồn
            </Button>
            {editMode ? (
              <>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleSave}
                  disabled={saveMut.isPending}
                >
                  {saveMut.isPending ? "Đang lưu…" : "Lưu"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={cancelEdit}
                >
                  Huỷ
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={enterEdit}
                disabled={sources.length === 0}
              >
                Chỉnh sửa
              </Button>
            )}
          </div>
        }
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-4">

        {isLoading ? (
          <div className="h-48 rounded-lg bg-muted animate-pulse" />
        ) : sources.length === 0 ? (
          <Card className="p-10 text-center space-y-4">
            <p className="text-sm text-muted-foreground">Chưa có nguồn thu nhập nào.</p>
            <Button onClick={() => setShowAdd(true)} className="gap-1.5">
              <Plus size={14} /> Thêm nguồn đầu tiên
            </Button>
          </Card>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-max w-full text-xs border-collapse">

              {/* ── header ────────────────────────────────────────────── */}
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="sticky left-0 z-10 bg-muted/90 backdrop-blur px-4 py-3 text-left text-[11px] uppercase tracking-widest text-muted-foreground font-medium min-w-[180px] border-r border-border/40">
                    Nguồn thu
                  </th>
                  {YEARS.map((year) => (
                    <th
                      key={year}
                      className={`px-3 py-3 text-right text-[11px] tracking-widest font-medium min-w-[88px] whitespace-nowrap ${
                        year === CURRENT_YEAR
                          ? "text-primary font-semibold"
                          : "text-muted-foreground"
                      }`}
                    >
                      {year}
                    </th>
                  ))}
                </tr>
              </thead>

              {/* ── source rows ───────────────────────────────────────── */}
              <tbody>
                {sources.map((src) => (
                  <tr
                    key={src.id}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                  >
                    {/* source name cell */}
                    <td className="sticky left-0 z-10 bg-background px-4 py-2.5 border-r border-border/40">
                      <div className="flex items-center gap-2 min-w-0">
                        {editMode && (
                          <button
                            className="shrink-0 text-muted-foreground/50 hover:text-red-400 transition-colors"
                            onClick={() => delMut.mutate(src.id)}
                            title="Xoá nguồn"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                        <span
                          className="shrink-0 w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: src.color }}
                        />
                        <span className="font-medium truncate">{src.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded leading-none">
                          {typeLabel(src.type)}
                        </span>
                      </div>
                    </td>

                    {/* year cells */}
                    {YEARS.map((year) => {
                      const val = displayCells[src.id]?.[year] ?? 0;
                      return (
                        <td
                          key={year}
                          className={`px-3 py-2.5 text-right tabular-nums ${
                            year === CURRENT_YEAR ? "bg-primary/5" : ""
                          }`}
                        >
                          {editMode ? (
                            <input
                              type="number"
                              min={0}
                              step={1_000_000}
                              className="w-full text-right bg-transparent border-b border-border outline-none focus:border-primary tabular-nums text-xs py-0.5 placeholder:text-muted-foreground/30"
                              value={cells[src.id]?.[year] || ""}
                              placeholder="—"
                              onChange={(e) =>
                                setCell(src.id, year, Number(e.target.value) || 0)
                              }
                            />
                          ) : (
                            <span
                              className={val > 0 ? "text-foreground" : "text-muted-foreground/30"}
                            >
                              {formatCell(val)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>

              {/* ── footer: total + yoy ───────────────────────────────── */}
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30">
                  <td className="sticky left-0 z-10 bg-muted/80 backdrop-blur px-4 py-3 border-r border-border/40">
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-semibold">
                      Tổng
                    </span>
                  </td>
                  {YEARS.map((year) => (
                    <td
                      key={year}
                      className={`px-3 py-3 text-right font-bold tabular-nums ${
                        year === CURRENT_YEAR ? "bg-primary/5" : ""
                      }`}
                    >
                      {formatCell(yearTotals[year] ?? 0)}
                    </td>
                  ))}
                </tr>

                <tr className="border-t border-border/30">
                  <td className="sticky left-0 z-10 bg-background px-4 py-2 border-r border-border/40">
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      Tăng trưởng YoY
                    </span>
                  </td>
                  {YEARS.map((year, i) => {
                    if (i === 0)
                      return (
                        <td key={year} className="px-3 py-2 text-right text-muted-foreground/30">
                          —
                        </td>
                      );
                    const prev = yearTotals[YEARS[i - 1]!] ?? 0;
                    const curr = yearTotals[year] ?? 0;
                    const pct = prev > 0 ? ((curr - prev) / prev) * 100 : null;
                    return (
                      <td
                        key={year}
                        className={`px-3 py-2 text-right text-[10px] tabular-nums ${
                          pct == null
                            ? "text-muted-foreground/30"
                            : pct > 0
                              ? "text-emerald-400"
                              : pct < 0
                                ? "text-red-400"
                                : "text-muted-foreground"
                        }`}
                      >
                        {pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* hint text */}
        {!isLoading && sources.length > 0 && (
          <p className="text-[11px] text-muted-foreground/60 text-center">
            Đơn vị: đồng (VND). Nhập số nguyên, ví dụ 1200000000 = 1.2B.
          </p>
        )}
      </main>

      {/* ── add source dialog ─────────────────────────────────────────────── */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Thêm nguồn thu nhập</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="src-name">Tên nguồn thu</Label>
              <Input
                id="src-name"
                placeholder="VD: Lương chính, Cho thuê nhà…"
                value={newSrc.name}
                onChange={(e) => setNewSrc((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addMut.mutate(newSrc)}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Loại</Label>
              <div className="flex flex-wrap gap-2">
                {SOURCE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setNewSrc((p) => ({ ...p, type: t.value }))}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors border ${
                      newSrc.type === t.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-transparent border-border hover:bg-muted"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Màu nhận diện</Label>
              <div className="flex gap-2">
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    className={`w-7 h-7 rounded-full transition-all ${
                      newSrc.color === color
                        ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                        : "hover:scale-105"
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => setNewSrc((p) => ({ ...p, color }))}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>
              Huỷ
            </Button>
            <Button
              onClick={() => addMut.mutate(newSrc)}
              disabled={!newSrc.name.trim() || addMut.isPending}
            >
              {addMut.isPending ? "Đang thêm…" : "Thêm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
