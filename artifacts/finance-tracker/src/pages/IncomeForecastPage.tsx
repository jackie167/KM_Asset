import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Plus, ChevronRight } from "lucide-react";
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

// ─── shared constants ─────────────────────────────────────────────────────────

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

// ─── shared types ─────────────────────────────────────────────────────────────

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

type CellMap = Record<number, Record<number, number>>;

// ─── shared helpers ───────────────────────────────────────────────────────────

function fmtVND(v: number): string {
  if (v === 0) return "—";
  const abs = Math.abs(Math.round(v));
  const s = abs.toLocaleString("vi-VN");
  return v < 0 ? `(${s})` : s;
}

function fmtPct(v: number): string {
  return `${v.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
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

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

const CALC_STORAGE_KEY = "income_project_calc_v1";

type CalcValues = Record<string, Record<number, number>>;

type CalcRow =
  | { kind: "section"; label: string }
  | { kind: "input";   id: string; label: string; unit: string; indent?: boolean }
  | { kind: "calc";    id: string; label: string; bold?: boolean; highlight?: boolean; isPercent?: boolean; isFCF?: boolean; indent?: boolean; isSub?: boolean };

const CALC_ROWS: CalcRow[] = [
  { kind: "section", label: "DOANH THU" },
  { kind: "input",   id: "volume",        label: "Sản lượng",                        unit: "sp/năm" },
  { kind: "input",   id: "price",         label: "Đơn giá bán",                      unit: "đ/sp",   indent: true },
  { kind: "calc",    id: "revenue",       label: "Doanh thu thuần",                  bold: true },

  { kind: "section", label: "GIÁ VỐN HÀNG BÁN" },
  { kind: "input",   id: "cogs_material", label: "Chi phí nguyên vật liệu / sp",     unit: "đ/sp",   indent: true },
  { kind: "input",   id: "cogs_labor",    label: "Chi phí nhân công trực tiếp / sp", unit: "đ/sp",   indent: true },
  { kind: "input",   id: "cogs_overhead", label: "Chi phí sản xuất chung / sp",      unit: "đ/sp",   indent: true },
  { kind: "calc",    id: "cogs",          label: "Giá vốn hàng bán" },
  { kind: "calc",    id: "gross_profit",  label: "Lợi nhuận gộp",                    bold: true, highlight: true },
  { kind: "calc",    id: "gross_margin",  label: "Biên lợi nhuận gộp",               isPercent: true, indent: true, isSub: true },

  { kind: "section", label: "CHI PHÍ HOẠT ĐỘNG" },
  { kind: "input",   id: "depreciation",  label: "Khấu hao tài sản cố định",         unit: "đ/năm",  indent: true },
  { kind: "input",   id: "interest",      label: "Chi phí lãi vay",                  unit: "đ/năm",  indent: true },
  { kind: "input",   id: "sga",           label: "Chi phí bán hàng & quản lý (SG&A)",unit: "đ/năm",  indent: true },
  { kind: "calc",    id: "ebit",          label: "EBIT — Lợi nhuận trước thuế & lãi", bold: true, highlight: true },

  { kind: "section", label: "THUẾ" },
  { kind: "input",   id: "tax_rate",      label: "Thuế suất TNDN",                   unit: "%",      indent: true },
  { kind: "calc",    id: "tax",           label: "Thuế thu nhập doanh nghiệp",        indent: true, isSub: true },
  { kind: "calc",    id: "net_profit",    label: "Lợi nhuận sau thuế",               bold: true, highlight: true },

  { kind: "section", label: "DÒNG TIỀN TỰ DO" },
  { kind: "calc",    id: "dep_addback",   label: "Cộng lại: khấu hao (không tiền mặt)", indent: true, isSub: true },
  { kind: "input",   id: "capex",         label: "Trừ: đầu tư CAPEX",                unit: "đ/năm",  indent: true },
  { kind: "input",   id: "delta_wc",      label: "Trừ: tăng vốn lưu động",           unit: "đ/năm",  indent: true },
  { kind: "calc",    id: "fcf",           label: "DÒNG TIỀN CUỐI NĂM",              bold: true, highlight: true, isFCF: true },
];

type CalcResult = {
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin: number;
  ebit: number;
  tax: number;
  net_profit: number;
  dep_addback: number;
  fcf: number;
};

function computeCalcYear(inp: Record<string, number>): CalcResult {
  const g = (id: string) => inp[id] ?? 0;

  const volume = g("volume");
  const price  = g("price");
  const revenue = volume * price;

  const cogsUnit = g("cogs_material") + g("cogs_labor") + g("cogs_overhead");
  const cogs = volume * cogsUnit;
  const gross_profit = revenue - cogs;
  const gross_margin = revenue > 0 ? (gross_profit / revenue) * 100 : 0;

  const depreciation = g("depreciation");
  const ebit = gross_profit - depreciation - g("interest") - g("sga");

  const tax = Math.max(0, ebit) * (g("tax_rate") / 100);
  const net_profit = ebit - tax;

  const dep_addback = depreciation;
  const fcf = net_profit + dep_addback - g("capex") - g("delta_wc");

  return { revenue, cogs, gross_profit, gross_margin, ebit, tax, net_profit, dep_addback, fcf };
}

function calcGet(r: CalcResult, id: string): number {
  return (r as unknown as Record<string, number>)[id] ?? 0;
}

// ── ProjectCalculator component ───────────────────────────────────────────────

function ProjectCalculator({
  sources,
  onApplyFCF,
}: {
  sources: IncomeSource[];
  onApplyFCF: (sourceId: number, fcfByYear: Record<number, number>) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [projectName, setProjectName] = useState("Dự án");
  const [values, setValues] = useState<CalcValues>(() => {
    try { return JSON.parse(localStorage.getItem(CALC_STORAGE_KEY) ?? "{}"); }
    catch { return {}; }
  });

  // fill dialog
  const [fillRow, setFillRow]       = useState<string | null>(null);
  const [fillBase, setFillBase]     = useState("");
  const [fillGrowth, setFillGrowth] = useState("0");

  // apply dialog
  const [showApply, setShowApply]       = useState(false);
  const [applyTarget, setApplyTarget]   = useState<number | null>(null);

  const setVal = (rowId: string, year: number, v: number) => {
    setValues((prev) => {
      const next = { ...prev, [rowId]: { ...prev[rowId], [year]: v } };
      localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const openFill = (rowId: string) => {
    const first = values[rowId]?.[YEAR_START] ?? 0;
    setFillBase(first > 0 ? String(first) : "");
    setFillGrowth("0");
    setFillRow(rowId);
  };

  const applyFill = () => {
    if (!fillRow) return;
    const base = parseFloat(fillBase.replace(/\./g, "").replace(",", ".")) || 0;
    const rate = parseFloat(fillGrowth.replace(",", ".")) / 100;
    setValues((prev) => {
      const next: CalcValues = { ...prev, [fillRow]: {} };
      for (const year of YEARS) {
        next[fillRow]![year] = base * Math.pow(1 + rate, year - YEAR_START);
      }
      localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setFillRow(null);
  };

  const calcResults = useMemo(() => {
    const map: Record<number, CalcResult> = {};
    for (const year of YEARS) {
      const inp: Record<string, number> = {};
      for (const row of CALC_ROWS) {
        if (row.kind === "input") inp[row.id] = values[row.id]?.[year] ?? 0;
      }
      map[year] = computeCalcYear(inp);
    }
    return map;
  }, [values]);

  const fcfByYear = useMemo(() => {
    const m: Record<number, number> = {};
    for (const year of YEARS) m[year] = calcResults[year]?.fcf ?? 0;
    return m;
  }, [calcResults]);

  const handleApply = () => {
    if (!applyTarget) return;
    onApplyFCF(applyTarget, fcfByYear);
    setShowApply(false);
  };

  const fillRowDef = CALC_ROWS.find((r) => r.kind === "input" && r.id === fillRow);

  return (
    <>
      {/* ── section toggle ────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-6 pb-1">
        <button
          className="flex items-center gap-1.5 group"
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronRight
            size={13}
            className={`text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-semibold group-hover:text-foreground transition-colors">
            Bảng tính dự án
          </span>
        </button>
        {!collapsed && (
          <Input
            className="h-7 text-xs w-44 text-right"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Tên dự án"
          />
        )}
      </div>

      {!collapsed && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-max w-full text-xs border-collapse">

            {/* header */}
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="sticky left-0 z-10 bg-muted/90 backdrop-blur px-4 py-3 text-left text-[11px] uppercase tracking-widest text-muted-foreground font-medium min-w-[260px] border-r border-border/40">
                  {projectName}
                </th>
                {YEARS.map((year) => (
                  <th
                    key={year}
                    className={`px-3 py-3 text-right text-[11px] tracking-widest font-medium min-w-[116px] whitespace-nowrap ${
                      year === CURRENT_YEAR ? "text-primary font-semibold" : "text-muted-foreground"
                    }`}
                  >
                    {year}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {CALC_ROWS.map((row, ri) => {
                // ── section header row
                if (row.kind === "section") {
                  return (
                    <tr key={`s-${ri}`} className="bg-muted/40">
                      <td
                        colSpan={YEARS.length + 1}
                        className="px-4 py-2 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold border-b border-t border-border/50"
                      >
                        {row.label}
                      </td>
                    </tr>
                  );
                }

                const isInput   = row.kind === "input";
                const unit      = isInput ? (row as { unit: string }).unit : null;
                const bold      = "bold"      in row && row.bold;
                const highlight = "highlight" in row && row.highlight;
                const isPercent = "isPercent" in row && row.isPercent;
                const isFCF     = "isFCF"     in row && row.isFCF;
                const isSub     = "isSub"     in row && row.isSub;
                const indent    = "indent"    in row && row.indent;

                return (
                  <tr
                    key={row.id}
                    className={`border-b border-border/40 transition-colors ${
                      isFCF ? "bg-emerald-500/5" : highlight ? "bg-muted/20" : "hover:bg-muted/10"
                    }`}
                  >
                    {/* label cell */}
                    <td className={`sticky left-0 z-10 px-4 py-2 border-r border-border/40 ${
                      isFCF ? "bg-emerald-500/5" : highlight ? "bg-muted/20" : "bg-background"
                    }`}>
                      <div className="flex items-center gap-2 min-w-0">
                        {indent && <span className="w-3 shrink-0" />}
                        <span className={`${bold ? "font-semibold" : ""} ${isSub ? "text-muted-foreground" : ""} ${isFCF ? "text-emerald-400 font-bold" : ""}`}>
                          {row.label}
                        </span>
                        {isInput && (
                          <>
                            <span className="shrink-0 ml-auto text-[10px] text-muted-foreground/40">{unit}</span>
                            <button
                              className="shrink-0 text-[11px] text-muted-foreground/40 hover:text-primary transition-colors px-1 py-0.5 rounded border border-transparent hover:border-border"
                              title="Điền theo tăng trưởng từ giá trị gốc"
                              onClick={() => openFill(row.id)}
                            >
                              ↗
                            </button>
                          </>
                        )}
                        {isFCF && sources.length > 0 && (
                          <button
                            className="shrink-0 ml-auto text-[10px] bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors px-2 py-0.5 rounded font-medium"
                            onClick={() => { setApplyTarget(sources[0]!.id); setShowApply(true); }}
                          >
                            Áp dụng →
                          </button>
                        )}
                      </div>
                    </td>

                    {/* year cells */}
                    {YEARS.map((year) => {
                      const result = calcResults[year]!;
                      const calcVal = !isInput ? calcGet(result, row.id) : 0;
                      const inputVal = isInput ? (values[row.id]?.[year] ?? 0) : 0;

                      return (
                        <td
                          key={year}
                          className={`px-2 py-2 text-right tabular-nums ${
                            year === CURRENT_YEAR ? "bg-primary/5" : ""
                          } ${isFCF ? "bg-emerald-500/5" : ""}`}
                        >
                          {isInput ? (
                            <input
                              type="number"
                              min={0}
                              className="w-full text-right bg-transparent border-b border-border/40 outline-none focus:border-primary tabular-nums text-xs py-0.5 placeholder:text-muted-foreground/20"
                              value={inputVal || ""}
                              placeholder="—"
                              onChange={(e) => setVal(row.id, year, Number(e.target.value) || 0)}
                            />
                          ) : isPercent ? (
                            <span className={`${isSub ? "text-muted-foreground" : ""} ${calcVal < 0 ? "text-red-400" : calcVal > 0 ? "text-emerald-400" : "text-muted-foreground/30"}`}>
                              {calcVal === 0 ? "—" : fmtPct(calcVal)}
                            </span>
                          ) : (
                            <span className={`${bold ? "font-semibold" : ""} ${isSub ? "text-muted-foreground" : ""} ${
                              isFCF
                                ? calcVal > 0 ? "text-emerald-400" : calcVal < 0 ? "text-red-400" : "text-muted-foreground/30"
                                : calcVal < 0 ? "text-red-400" : calcVal === 0 ? "text-muted-foreground/30" : ""
                            }`}>
                              {fmtVND(calcVal)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── fill dialog ─────────────────────────────────────────── */}
      <Dialog open={!!fillRow} onOpenChange={(o) => !o && setFillRow(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Điền tự động</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {fillRowDef?.kind === "input" ? fillRowDef.label : ""}
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Giá trị năm {YEAR_START}</Label>
              <Input
                className="text-xs h-8"
                placeholder="0"
                value={fillBase}
                onChange={(e) => setFillBase(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tăng trưởng mỗi năm (%)</Label>
              <Input
                className="text-xs h-8"
                placeholder="0"
                value={fillGrowth}
                onChange={(e) => setFillGrowth(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFill()}
              />
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              Áp dụng cho tất cả {YEARS.length} năm theo công thức lãi kép.
              Giá trị 0 sẽ không được ghi đè.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setFillRow(null)}>Huỷ</Button>
            <Button size="sm" onClick={applyFill}>Điền</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── apply dialog ────────────────────────────────────────── */}
      <Dialog open={showApply} onOpenChange={setShowApply}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Áp dụng dòng tiền vào nguồn thu</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Giá trị dòng tiền cuối năm của dự án sẽ được điền vào nguồn thu được chọn. Bạn có thể xem lại và lưu sau.
            </p>
            <div className="space-y-1">
              {sources.map((src) => (
                <button
                  key={src.id}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors text-xs ${
                    applyTarget === src.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted"
                  }`}
                  onClick={() => setApplyTarget(src.id)}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: src.color }} />
                  <span className="font-medium flex-1">{src.name}</span>
                  <span className="text-muted-foreground text-[10px]">{typeLabel(src.type)}</span>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowApply(false)}>Huỷ</Button>
            <Button size="sm" disabled={!applyTarget} onClick={handleApply}>Áp dụng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function IncomeForecastPage() {
  const qc = useQueryClient();

  const [editMode, setEditMode] = useState(false);
  const [cells, setCells]       = useState<CellMap>({});
  const [showAdd, setShowAdd]   = useState(false);
  const [newSrc, setNewSrc]     = useState({ name: "", type: "salary", color: COLOR_PRESETS[0]! });

  const sourcesQ = useQuery({ queryKey: ["income-sources"], queryFn: fetchSources });
  const entriesQ = useQuery({ queryKey: ["income-forecast"], queryFn: fetchEntries });

  const sources = sourcesQ.data ?? [];
  const entries = entriesQ.data ?? [];

  const dbCells = useMemo<CellMap>(() => {
    const map: CellMap = {};
    for (const e of entries) {
      map[e.sourceId] ??= {};
      map[e.sourceId]![e.year] = Number(e.amount);
    }
    return map;
  }, [entries]);

  const displayCells = editMode ? cells : dbCells;

  const yearTotals = useMemo(() => {
    const t: Record<number, number> = {};
    for (const year of YEARS) {
      t[year] = sources.reduce((s, src) => s + (displayCells[src.id]?.[year] ?? 0), 0);
    }
    return t;
  }, [displayCells, sources]);

  // ── edit helpers ──────────────────────────────────────────────────────────────

  const enterEdit = () => {
    const copy: CellMap = {};
    for (const src of sources) copy[src.id] = { ...(dbCells[src.id] ?? {}) };
    setCells(copy);
    setEditMode(true);
  };

  const cancelEdit = () => { setEditMode(false); setCells({}); };

  const setCell = (srcId: number, year: number, val: number) => {
    setCells((prev) => ({ ...prev, [srcId]: { ...prev[srcId], [year]: val } }));
  };

  // Apply FCF from project calculator → enter edit mode with values pre-filled
  const handleApplyFCF = (sourceId: number, fcfByYear: Record<number, number>) => {
    const copy: CellMap = {};
    for (const src of sources) copy[src.id] = { ...(dbCells[src.id] ?? {}) };
    copy[sourceId] = { ...copy[sourceId] };
    for (const [y, amount] of Object.entries(fcfByYear)) {
      if (amount !== 0) copy[sourceId]![Number(y)] = amount;
    }
    setCells(copy);
    setEditMode(true);
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

  const handleSave = () => {
    const payload: { sourceId: number; year: number; amount: number }[] = [];
    for (const src of sources) {
      for (const year of YEARS) {
        const amount = cells[src.id]?.[year] ?? 0;
        if (amount !== 0) payload.push({ sourceId: src.id, year, amount });
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
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => setShowAdd(true)}>
              <Plus size={12} /> Thêm nguồn
            </Button>
            {editMode ? (
              <>
                <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saveMut.isPending}>
                  {saveMut.isPending ? "Đang lưu…" : "Lưu"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={cancelEdit}>Huỷ</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={enterEdit} disabled={sources.length === 0}>
                Chỉnh sửa
              </Button>
            )}
          </div>
        }
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-4">

        {/* ── income forecast table ──────────────────────────── */}
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
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="sticky left-0 z-10 bg-muted/90 backdrop-blur px-4 py-3 text-left text-[11px] uppercase tracking-widest text-muted-foreground font-medium min-w-[180px] border-r border-border/40">
                    Nguồn thu
                  </th>
                  {YEARS.map((year) => (
                    <th key={year} className={`px-3 py-3 text-right text-[11px] tracking-widest font-medium min-w-[116px] whitespace-nowrap ${year === CURRENT_YEAR ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                      {year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((src) => (
                  <tr key={src.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="sticky left-0 z-10 bg-background px-4 py-2.5 border-r border-border/40">
                      <div className="flex items-center gap-2 min-w-0">
                        {editMode && (
                          <button className="shrink-0 text-muted-foreground/50 hover:text-red-400 transition-colors" onClick={() => delMut.mutate(src.id)} title="Xoá nguồn">
                            <Trash2 size={12} />
                          </button>
                        )}
                        <span className="shrink-0 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: src.color }} />
                        <span className="font-medium truncate">{src.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded leading-none">{typeLabel(src.type)}</span>
                      </div>
                    </td>
                    {YEARS.map((year) => {
                      const val = displayCells[src.id]?.[year] ?? 0;
                      return (
                        <td key={year} className={`px-3 py-2.5 text-right tabular-nums ${year === CURRENT_YEAR ? "bg-primary/5" : ""}`}>
                          {editMode ? (
                            <input
                              type="number" min={0} step={1_000_000}
                              className="w-full text-right bg-transparent border-b border-border outline-none focus:border-primary tabular-nums text-xs py-0.5 placeholder:text-muted-foreground/30"
                              value={cells[src.id]?.[year] || ""}
                              placeholder="—"
                              onChange={(e) => setCell(src.id, year, Number(e.target.value) || 0)}
                            />
                          ) : (
                            <span className={val > 0 ? "text-foreground" : "text-muted-foreground/30"}>
                              {fmtVND(val)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30">
                  <td className="sticky left-0 z-10 bg-muted/80 backdrop-blur px-4 py-3 border-r border-border/40">
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-semibold">Tổng</span>
                  </td>
                  {YEARS.map((year) => (
                    <td key={year} className={`px-3 py-3 text-right font-bold tabular-nums ${year === CURRENT_YEAR ? "bg-primary/5" : ""}`}>
                      {fmtVND(yearTotals[year] ?? 0)}
                    </td>
                  ))}
                </tr>
                <tr className="border-t border-border/30">
                  <td className="sticky left-0 z-10 bg-background px-4 py-2 border-r border-border/40">
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Tăng trưởng YoY</span>
                  </td>
                  {YEARS.map((year, i) => {
                    if (i === 0) return <td key={year} className="px-3 py-2 text-right text-muted-foreground/30">—</td>;
                    const prev = yearTotals[YEARS[i - 1]!] ?? 0;
                    const curr = yearTotals[year] ?? 0;
                    const pct  = prev > 0 ? ((curr - prev) / prev) * 100 : null;
                    return (
                      <td key={year} className={`px-3 py-2 text-right text-[10px] tabular-nums ${pct == null ? "text-muted-foreground/30" : pct > 0 ? "text-emerald-400" : pct < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* ── project calculator ─────────────────────────────── */}
        <ProjectCalculator sources={sources} onApplyFCF={handleApplyFCF} />

      </main>

      {/* ── add source dialog ──────────────────────────────────── */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Thêm nguồn thu nhập</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="src-name">Tên nguồn thu</Label>
              <Input
                id="src-name" placeholder="VD: Lương chính, Cho thuê nhà…"
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
                  <button key={t.value} onClick={() => setNewSrc((p) => ({ ...p, type: t.value }))}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors border ${newSrc.type === t.value ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-border hover:bg-muted"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Màu nhận diện</Label>
              <div className="flex gap-2">
                {COLOR_PRESETS.map((color) => (
                  <button key={color}
                    className={`w-7 h-7 rounded-full transition-all ${newSrc.color === color ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110" : "hover:scale-105"}`}
                    style={{ backgroundColor: color }} onClick={() => setNewSrc((p) => ({ ...p, color }))} />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Huỷ</Button>
            <Button onClick={() => addMut.mutate(newSrc)} disabled={!newSrc.name.trim() || addMut.isPending}>
              {addMut.isPending ? "Đang thêm…" : "Thêm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
