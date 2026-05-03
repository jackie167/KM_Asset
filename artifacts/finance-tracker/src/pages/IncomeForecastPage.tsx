import { useState, useMemo, useRef, useEffect } from "react";
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
  forecastMode: string;        // "manual" | "growth"
  forecastBase: string | null; // numeric from DB
  forecastRate: string | null; // numeric from DB
  note: string | null;
};

type SrcSettings = { mode: "manual" | "growth"; base: number; rate: number };

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

const isBusiness = (src: IncomeSource) => src.type === "business";

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

type CalcType   = "direct" | "per_ha";
type CalcValues = Record<string, Record<number, number>>;

// meta row persisted in income_project_calc with year = -1
const CALC_TYPE_META = "_calc_type";

type CalcRow =
  | { kind: "section"; label: string }
  | { kind: "input";   id: string; label: string; unit: string; indent?: boolean }
  | { kind: "calc";    id: string; label: string; bold?: boolean; highlight?: boolean; isPercent?: boolean; isPlain?: boolean; plainUnit?: string; isFCF?: boolean; isSub?: boolean; indent?: boolean };

// shared tail rows (OPEX → Tax → Cash flow) reused by both layouts
const CALC_TAIL: CalcRow[] = [
  { kind: "section", label: "CHI PHÍ HOẠT ĐỘNG" },
  { kind: "input",   id: "depreciation",  label: "Khấu hao tài sản cố định",          unit: "đ/năm",  indent: true },
  { kind: "input",   id: "interest",      label: "Chi phí lãi vay",                   unit: "đ/năm",  indent: true },
  { kind: "input",   id: "sga",           label: "Chi phí bán hàng & quản lý (SG&A)", unit: "đ/năm",  indent: true },
  { kind: "calc",    id: "ebit",          label: "EBIT — Lợi nhuận trước thuế & lãi", bold: true, highlight: true },

  { kind: "section", label: "THUẾ" },
  { kind: "input",   id: "tax_rate",      label: "Thuế suất TNDN",                    unit: "%",      indent: true },
  { kind: "calc",    id: "tax",           label: "Thuế thu nhập doanh nghiệp",         indent: true, isSub: true },
  { kind: "calc",    id: "net_profit",    label: "Lợi nhuận sau thuế",                bold: true, highlight: true },

  { kind: "section", label: "DÒNG TIỀN TỰ DO" },
  { kind: "calc",    id: "dep_addback",   label: "Cộng lại: khấu hao (không tiền mặt)", indent: true, isSub: true },
  { kind: "input",   id: "capex",         label: "Trừ: đầu tư CAPEX",                 unit: "đ/năm",  indent: true },
  { kind: "input",   id: "delta_wc",      label: "Trừ: tăng vốn lưu động",            unit: "đ/năm",  indent: true },
  { kind: "calc",    id: "fcf",           label: "DÒNG TIỀN CUỐI NĂM",               bold: true, highlight: true, isFCF: true },
];

// ── Option A: direct revenue + COGS per year ─────────────────────────────────
const CALC_ROWS_DIRECT: CalcRow[] = [
  { kind: "section", label: "DOANH THU" },
  { kind: "input",   id: "revenue_direct", label: "Doanh thu thuần",    unit: "đ/năm" },

  { kind: "section", label: "GIÁ VỐN HÀNG BÁN" },
  { kind: "input",   id: "cogs_direct",   label: "Giá vốn hàng bán",   unit: "đ/năm" },
  { kind: "calc",    id: "gross_profit",  label: "Lợi nhuận gộp",       bold: true, highlight: true },
  { kind: "calc",    id: "gross_margin",  label: "Biên lợi nhuận gộp",  isPercent: true, indent: true, isSub: true },

  ...CALC_TAIL,
];

// ── Nông nghiệp: area × yield/ha, cost/ha ────────────────────────────────────
const CALC_ROWS_PER_HA: CalcRow[] = [
  { kind: "section", label: "DOANH THU" },
  { kind: "input",   id: "area",          label: "Diện tích canh tác",                unit: "ha" },
  { kind: "input",   id: "yield_per_ha",  label: "Năng suất",                         unit: "tấn/ha", indent: true },
  { kind: "calc",    id: "volume",        label: "Sản lượng",                         isSub: true, indent: true, isPlain: true, plainUnit: "tấn" },
  { kind: "input",   id: "price",         label: "Đơn giá bán",                       unit: "đ/tấn",  indent: true },
  { kind: "calc",    id: "revenue",       label: "Doanh thu thuần",                   bold: true },

  { kind: "section", label: "GIÁ VỐN HÀNG BÁN (tính theo ha)" },
  { kind: "input",   id: "cogs_material", label: "Phân bón & vật tư",                 unit: "đ/ha",   indent: true },
  { kind: "input",   id: "cogs_labor",    label: "Nhân công trực tiếp",               unit: "đ/ha",   indent: true },
  { kind: "input",   id: "cogs_overhead", label: "Chi phí sản xuất chung",            unit: "đ/ha",   indent: true },
  { kind: "calc",    id: "cogs",          label: "Giá vốn hàng bán" },
  { kind: "calc",    id: "gross_profit",  label: "Lợi nhuận gộp",                     bold: true, highlight: true },
  { kind: "calc",    id: "gross_margin",  label: "Biên lợi nhuận gộp",                isPercent: true, indent: true, isSub: true },

  ...CALC_TAIL,
];

function getCalcRows(t: CalcType): CalcRow[] {
  return t === "per_ha" ? CALC_ROWS_PER_HA : CALC_ROWS_DIRECT;
}

type CalcResult = {
  volume: number;
  revenue: number; cogs: number; gross_profit: number; gross_margin: number;
  ebit: number; tax: number; net_profit: number; dep_addback: number; fcf: number;
};

function computeCalcYear(inp: Record<string, number>, calcType: CalcType = "direct"): CalcResult {
  const g = (id: string) => inp[id] ?? 0;
  let volume: number, revenue: number, cogs: number;
  if (calcType === "per_ha") {
    const area = g("area");
    volume  = area * g("yield_per_ha");
    revenue = volume * g("price");
    cogs    = area * (g("cogs_material") + g("cogs_labor") + g("cogs_overhead"));
  } else {
    volume  = 0;
    revenue = g("revenue_direct");
    cogs    = g("cogs_direct");
  }
  const gross_profit = revenue - cogs;
  const gross_margin = revenue > 0 ? (gross_profit / revenue) * 100 : 0;
  const depreciation = g("depreciation");
  const ebit         = gross_profit - depreciation - g("interest") - g("sga");
  const tax          = Math.max(0, ebit) * (g("tax_rate") / 100);
  const net_profit   = ebit - tax;
  const dep_addback  = depreciation;
  const fcf          = net_profit + dep_addback - g("capex") - g("delta_wc");
  return { volume, revenue, cogs, gross_profit, gross_margin, ebit, tax, net_profit, dep_addback, fcf };
}

function calcGet(r: CalcResult, id: string): number {
  return (r as unknown as Record<string, number>)[id] ?? 0;
}

// ── ProjectCalculator ─────────────────────────────────────────────────────────

type CalcEntry = { id: number; sourceId: number; rowId: string; year: number; value: string };

const LAYOUT_META: Record<CalcType, { label: string; desc: string }> = {
  direct: { label: "Đầu tư thông thường", desc: "Nhập trực tiếp doanh thu và giá vốn theo năm. Phù hợp với Solar, shop, bất động sản cho thuê…" },
  per_ha: { label: "Nông nghiệp",          desc: "Tính theo diện tích × năng suất. Chi phí nhập theo ha. Phù hợp với cây trồng, chăn nuôi…" },
};

function ProjectCalculator({ source }: { source: IncomeSource }) {
  const qc = useQueryClient();

  // null = chưa chọn layout (hiện picker)
  const [selectedType, setSelectedType] = useState<CalcType | null>(null);
  const [calcEditMode, setCalcEditMode] = useState(false);
  const [editValues, setEditValues]     = useState<CalcValues>({});
  const [editCalcType, setEditCalcType] = useState<CalcType>("direct");

  // fill dialog
  const [fillRow, setFillRow]       = useState<string | null>(null);
  const [fillBase, setFillBase]     = useState("");
  const [fillGrowth, setFillGrowth] = useState("0");

  // load saved data from DB
  const calcQ = useQuery({
    queryKey: ["income-project-calc", source.id],
    queryFn: async () => {
      const res = await fetch(`/api/income-project-calc/${source.id}`);
      if (!res.ok) return [] as CalcEntry[];
      return res.json() as Promise<CalcEntry[]>;
    },
  });

  // parse DB data: extract saved type + values
  const { dbValues, dbCalcType } = useMemo(() => {
    const map: CalcValues = {};
    let t: CalcType | null = null;
    for (const e of calcQ.data ?? []) {
      if (e.rowId === CALC_TYPE_META) { t = Number(e.value) === 1 ? "per_ha" : "direct"; continue; }
      map[e.rowId] ??= {};
      map[e.rowId]![e.year] = Number(e.value);
    }
    return { dbValues: map, dbCalcType: t };
  }, [calcQ.data]);

  // once DB data arrives, sync selectedType (null stays null for new projects → picker)
  useEffect(() => {
    if (dbCalcType !== null) setSelectedType(dbCalcType);
  }, [dbCalcType]);

  const activeType     = calcEditMode ? editCalcType : (selectedType ?? "direct");
  const displayValues  = calcEditMode ? editValues   : dbValues;

  // ── pick layout (first time) ──────────────────────────────────────────────
  const pickLayout = (type: CalcType) => {
    setSelectedType(type);
    setEditCalcType(type);
    setEditValues({});
    setCalcEditMode(true);
  };

  const enterCalcEdit = () => {
    const copy: CalcValues = {};
    for (const [k, v] of Object.entries(dbValues)) copy[k] = { ...v };
    setEditValues(copy);
    setEditCalcType(selectedType ?? "direct");
    setCalcEditMode(true);
  };

  const cancelCalcEdit = () => { setCalcEditMode(false); setEditValues({}); };

  const setVal = (rowId: string, year: number, v: number) => {
    setEditValues((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [year]: v } }));
  };

  const openFill = (rowId: string) => {
    setFillBase(String(editValues[rowId]?.[YEAR_START] ?? ""));
    setFillGrowth("0");
    setFillRow(rowId);
  };

  const applyFill = () => {
    if (!fillRow) return;
    const base = parseFloat(fillBase.replace(/\./g, "").replace(",", ".")) || 0;
    const rate = parseFloat(fillGrowth.replace(",", ".")) / 100;
    setEditValues((prev) => {
      const next = { ...prev, [fillRow]: {} };
      for (const year of YEARS) next[fillRow]![year] = base * Math.pow(1 + rate, year - YEAR_START);
      return next;
    });
    setFillRow(null);
  };

  // save mutation
  const saveMut = useMutation({
    mutationFn: async (entries: { rowId: string; year: number; value: number }[]) => {
      const res = await fetch(`/api/income-project-calc/${source.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["income-project-calc", source.id] });
      qc.invalidateQueries({ queryKey: ["income-project-calc-all"] });
      setCalcEditMode(false);
      setEditValues({});
    },
  });

  const handleSave = () => {
    const entries: { rowId: string; year: number; value: number }[] = [];
    // persist layout type as meta row (year = -1)
    entries.push({ rowId: CALC_TYPE_META, year: -1, value: editCalcType === "per_ha" ? 1 : 0 });
    for (const [rowId, yearMap] of Object.entries(editValues)) {
      for (const [y, value] of Object.entries(yearMap)) {
        if (value !== 0) entries.push({ rowId, year: Number(y), value });
      }
    }
    saveMut.mutate(entries);
  };

  // compute results
  const calcResults = useMemo(() => {
    const map: Record<number, CalcResult> = {};
    for (const year of YEARS) {
      const inp: Record<string, number> = {};
      for (const row of getCalcRows(activeType)) if (row.kind === "input") inp[row.id] = displayValues[row.id]?.[year] ?? 0;
      map[year] = computeCalcYear(inp, activeType);
    }
    return map;
  }, [displayValues, activeType]);

  const fillRowDef = getCalcRows(activeType).find((r) => r.kind === "input" && r.id === fillRow);

  // ── layout picker (shown for new projects with no saved type) ─────────────
  if (!calcQ.isLoading && selectedType === null) {
    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center gap-2 mb-4">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: source.color }} />
          <span className="text-sm font-semibold">{source.name}</span>
        </div>
        <p className="text-xs text-muted-foreground">Chọn loại bảng tính cho dự án này:</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(["direct", "per_ha"] as CalcType[]).map((type) => (
            <button
              key={type}
              onClick={() => pickLayout(type)}
              className="p-4 rounded-lg border border-border hover:border-primary hover:bg-primary/5 text-left transition-all space-y-1.5 group"
            >
              <p className="text-sm font-semibold group-hover:text-primary transition-colors">{LAYOUT_META[type].label}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{LAYOUT_META[type].desc}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: source.color }} />
          <span className="text-sm font-semibold">{source.name}</span>
          {!calcEditMode && selectedType && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {LAYOUT_META[selectedType].label}
            </span>
          )}
        </div>
        {calcEditMode ? (
          <div className="flex items-center gap-2">
            {/* layout type toggle — only in edit mode */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-[10px]">
              {(["direct", "per_ha"] as CalcType[]).map((type, i) => (
                <button
                  key={type}
                  className={`px-2 py-1 transition-colors ${i > 0 ? "border-l border-border" : ""} ${editCalcType === type ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  onClick={() => setEditCalcType(type)}
                >
                  {type === "direct" ? "Đầu tư" : "Nông nghiệp"}
                </button>
              ))}
            </div>
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saveMut.isPending}>
              {saveMut.isPending ? "Đang lưu…" : "Lưu"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelCalcEdit}>Huỷ</Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={enterCalcEdit} disabled={calcQ.isLoading}>
            Chỉnh sửa
          </Button>
        )}
      </div>

      {/* table */}
      {calcQ.isLoading ? (
        <div className="h-32 rounded-lg bg-muted animate-pulse" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-max w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="sticky left-0 z-10 bg-muted/90 backdrop-blur px-4 py-3 text-left text-[11px] uppercase tracking-widest text-muted-foreground font-medium min-w-[270px] border-r border-border/40">
                  Chỉ tiêu
                </th>
                {YEARS.map((year) => (
                  <th key={year} className={`px-3 py-3 text-right text-[11px] tracking-widest font-medium min-w-[116px] whitespace-nowrap ${year === CURRENT_YEAR ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                    {year}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {getCalcRows(activeType).map((row, ri) => {
                if (row.kind === "section") {
                  return (
                    <tr key={`s-${ri}`} className="bg-muted/40">
                      <td colSpan={YEARS.length + 1} className="px-4 py-2 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold border-b border-t border-border/50">
                        {row.label}
                      </td>
                    </tr>
                  );
                }

                const isInput    = row.kind === "input";
                const unit       = isInput ? (row as { unit: string }).unit : null;
                const bold       = "bold"      in row && !!row.bold;
                const highlight  = "highlight" in row && !!row.highlight;
                const isPercent  = "isPercent" in row && !!row.isPercent;
                const isPlain    = "isPlain"   in row && !!row.isPlain;
                const plainUnit  = "plainUnit" in row ? (row as { plainUnit?: string }).plainUnit : undefined;
                const isFCF      = "isFCF"     in row && !!row.isFCF;
                const isSub      = "isSub"     in row && !!row.isSub;
                const indent     = "indent"    in row && !!row.indent;

                return (
                  <tr key={row.id} className={`border-b border-border/40 transition-colors ${isFCF ? "bg-emerald-500/5" : highlight ? "bg-muted/20" : "hover:bg-muted/10"}`}>
                    {/* label */}
                    <td className={`sticky left-0 z-10 px-4 py-2 border-r border-border/40 ${isFCF ? "bg-emerald-500/5" : highlight ? "bg-muted/20" : "bg-background"}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        {indent && <span className="w-3 shrink-0" />}
                        <span className={`${bold ? "font-semibold" : ""} ${isSub ? "text-muted-foreground" : ""} ${isFCF ? "text-emerald-400 font-bold" : ""}`}>
                          {row.label}
                        </span>
                        {isInput && calcEditMode && (
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
                        {isInput && !calcEditMode && (
                          <span className="shrink-0 ml-auto text-[10px] text-muted-foreground/40">{unit}</span>
                        )}
                        {isFCF && (
                          <span className="shrink-0 ml-auto text-[10px] text-emerald-400/60">→ bảng thu nhập</span>
                        )}
                      </div>
                    </td>
                    {/* year cells */}
                    {YEARS.map((year) => {
                      const result   = calcResults[year]!;
                      const calcVal  = !isInput ? calcGet(result, row.id) : 0;
                      const inputVal = isInput ? (displayValues[row.id]?.[year] ?? 0) : 0;
                      return (
                        <td key={year} className={`px-2 py-2 text-right tabular-nums ${year === CURRENT_YEAR ? "bg-primary/5" : ""} ${isFCF ? "bg-emerald-500/5" : ""}`}>
                          {isInput && calcEditMode ? (
                            <input
                              type="number"
                              min={0}
                              className="w-full text-right bg-transparent border-b border-border/40 outline-none focus:border-primary tabular-nums text-xs py-0.5 placeholder:text-muted-foreground/20"
                              value={editValues[row.id]?.[year] || ""}
                              placeholder="—"
                              onChange={(e) => setVal(row.id, year, Number(e.target.value) || 0)}
                            />
                          ) : isInput ? (
                            <span className={inputVal === 0 ? "text-muted-foreground/30" : ""}>
                              {inputVal === 0 ? "—" : inputVal.toLocaleString("vi-VN")}
                            </span>
                          ) : isPlain ? (
                            <span className={`${isSub ? "text-muted-foreground" : ""} ${calcVal === 0 ? "text-muted-foreground/30" : ""}`}>
                              {calcVal === 0 ? "—" : `${calcVal.toLocaleString("vi-VN")}${plainUnit ? ` ${plainUnit}` : ""}`}
                            </span>
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

      {/* fill dialog */}
      <Dialog open={!!fillRow} onOpenChange={(o) => !o && setFillRow(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Điền tự động</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <p className="text-[11px] text-muted-foreground">
              {fillRowDef?.kind === "input" ? fillRowDef.label : ""}
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Giá trị năm {YEAR_START}</Label>
              <Input className="text-xs h-8" placeholder="0" value={fillBase} onChange={(e) => setFillBase(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tăng trưởng mỗi năm (%)</Label>
              <Input className="text-xs h-8" placeholder="0" value={fillGrowth} onChange={(e) => setFillGrowth(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyFill()} />
            </div>
            <p className="text-[11px] text-muted-foreground/60">Áp dụng cho tất cả {YEARS.length} năm theo công thức lãi kép.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setFillRow(null)}>Huỷ</Button>
            <Button size="sm" onClick={applyFill}>Điền</Button>
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

  const [editMode, setEditMode]         = useState(false);
  const [cells, setCells]               = useState<CellMap>({});
  const [editSrcSettings, setEditSrcSettings] = useState<Record<number, SrcSettings>>({});
  const [showAdd, setShowAdd]     = useState(false);
  const [newSrc, setNewSrc]       = useState({ name: "", type: "salary", color: COLOR_PRESETS[0]! });

  // selected business source for the project calculator
  const [selectedCalcSrc, setSelectedCalcSrc] = useState<IncomeSource | null>(null);
  const calcSectionRef = useRef<HTMLDivElement>(null);

  const sourcesQ  = useQuery({ queryKey: ["income-sources"],         queryFn: fetchSources });
  const entriesQ  = useQuery({ queryKey: ["income-forecast"],         queryFn: fetchEntries });
  const calcAllQ  = useQuery({
    queryKey: ["income-project-calc-all"],
    queryFn: async () => {
      const res = await fetch("/api/income-project-calc");
      if (!res.ok) return [] as CalcEntry[];
      return res.json() as Promise<CalcEntry[]>;
    },
  });

  const sources = sourcesQ.data ?? [];
  const entries = entriesQ.data ?? [];

  // keep selectedCalcSrc in sync if the source list changes
  useEffect(() => {
    if (!selectedCalcSrc) return;
    const updated = sources.find((s) => s.id === selectedCalcSrc.id);
    if (!updated) setSelectedCalcSrc(null);
    else if (updated.name !== selectedCalcSrc.name || updated.color !== selectedCalcSrc.color)
      setSelectedCalcSrc(updated);
  }, [sources]); // eslint-disable-line

  const dbCells = useMemo<CellMap>(() => {
    const map: CellMap = {};
    for (const e of entries) {
      map[e.sourceId] ??= {};
      map[e.sourceId]![e.year] = Number(e.amount);
    }
    return map;
  }, [entries]);

  // Compute FCF per year for every business source directly from calculator DB data
  const businessFCF = useMemo<CellMap>(() => {
    const allEntries = calcAllQ.data ?? [];
    const bySource: Record<number, CalcEntry[]> = {};
    for (const e of allEntries) { bySource[e.sourceId] ??= []; bySource[e.sourceId]!.push(e); }

    const result: CellMap = {};
    for (const src of sources.filter(isBusiness)) {
      const vals: CalcValues = {};
      let srcCalcType: CalcType = "direct";
      for (const e of bySource[src.id] ?? []) {
        if (e.rowId === CALC_TYPE_META) { srcCalcType = Number(e.value) === 1 ? "per_ha" : "direct"; continue; }
        vals[e.rowId] ??= {};
        vals[e.rowId]![e.year] = Number(e.value);
      }
      result[src.id] = {};
      for (const year of YEARS) {
        const inp: Record<string, number> = {};
        for (const row of getCalcRows(srcCalcType)) if (row.kind === "input") inp[row.id] = vals[row.id]?.[year] ?? 0;
        result[src.id]![year] = computeCalcYear(inp, srcCalcType).fcf;
      }
    }
    return result;
  }, [calcAllQ.data, sources]);

  // Compute growth-mode cells for a given settings map (view or edit)
  function applyGrowthSources(base: CellMap, srcs: IncomeSource[], settingsMap: Record<number, SrcSettings> | null): CellMap {
    const merged = { ...base };
    for (const src of srcs) {
      if (isBusiness(src)) continue;
      const s = settingsMap ? settingsMap[src.id] : { mode: src.forecastMode as "manual" | "growth", base: Number(src.forecastBase ?? 0), rate: Number(src.forecastRate ?? 0) };
      if (!s || s.mode !== "growth" || s.base <= 0) continue;
      merged[src.id] = {};
      const r = s.rate / 100;
      for (const year of YEARS) merged[src.id]![year] = s.base * Math.pow(1 + r, year - YEAR_START);
    }
    return merged;
  }

  const displayCells = useMemo<CellMap>(() => {
    const base = editMode ? cells : dbCells;
    const withFCF = { ...base, ...businessFCF };
    return applyGrowthSources(withFCF, sources, editMode ? editSrcSettings : null);
  }, [editMode, cells, dbCells, businessFCF, sources, editSrcSettings]); // eslint-disable-line

  const yearTotals = useMemo(() => {
    const t: Record<number, number> = {};
    for (const year of YEARS)
      t[year] = sources.reduce((s, src) => s + (displayCells[src.id]?.[year] ?? 0), 0);
    return t;
  }, [displayCells, sources]);

  // ── edit helpers ──────────────────────────────────────────────────────────────

  const enterEdit = () => {
    const copy: CellMap = {};
    const settingsCopy: Record<number, SrcSettings> = {};
    for (const src of sources.filter((s) => !isBusiness(s))) {
      copy[src.id] = { ...(dbCells[src.id] ?? {}) };
      settingsCopy[src.id] = {
        mode: (src.forecastMode ?? "manual") as "manual" | "growth",
        base: Number(src.forecastBase ?? 0),
        rate: Number(src.forecastRate ?? 0),
      };
    }
    setCells(copy);
    setEditSrcSettings(settingsCopy);
    setEditMode(true);
  };

  const cancelEdit = () => { setEditMode(false); setCells({}); setEditSrcSettings({}); };

  const setSourceSetting = (srcId: number, patch: Partial<SrcSettings>) => {
    setEditSrcSettings((prev) => ({ ...prev, [srcId]: { ...prev[srcId]!, ...patch } }));
  };

  const setCell = (srcId: number, year: number, val: number) => {
    setCells((prev) => ({ ...prev, [srcId]: { ...prev[srcId], [year]: val } }));
  };

  const handleSourceClick = (src: IncomeSource) => {
    if (!isBusiness(src)) return;
    setSelectedCalcSrc(src);
    setTimeout(() => calcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  // ── mutations ─────────────────────────────────────────────────────────────────

  const saveMut = useMutation({
    mutationFn: async ({ payload, settingsPatches }: {
      payload: { sourceId: number; year: number; amount: number }[];
      settingsPatches: { id: number; mode: string; base: number | null; rate: number | null }[];
    }) => {
      await Promise.all([
        fetch("/api/income-forecast", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: payload }),
        }),
        ...settingsPatches.map(({ id, mode, base, rate }) =>
          fetch(`/api/income-sources/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ forecastMode: mode, forecastBase: base, forecastRate: rate }),
          })
        ),
      ]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["income-forecast"] });
      qc.invalidateQueries({ queryKey: ["income-sources"] });
      setEditMode(false);
      setCells({});
      setEditSrcSettings({});
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
      if (selectedCalcSrc?.id === id) setSelectedCalcSrc(null);
    },
  });

  const handleSave = () => {
    const payload: { sourceId: number; year: number; amount: number }[] = [];
    const settingsPatches: { id: number; mode: string; base: number | null; rate: number | null }[] = [];

    for (const src of sources.filter((s) => !isBusiness(s))) {
      const s = editSrcSettings[src.id];
      if (!s) continue;
      settingsPatches.push({ id: src.id, mode: s.mode, base: s.mode === "growth" ? s.base : null, rate: s.mode === "growth" ? s.rate : null });
      if (s.mode === "manual") {
        for (const year of YEARS) {
          const amount = cells[src.id]?.[year] ?? 0;
          if (amount !== 0) payload.push({ sourceId: src.id, year, amount });
        }
      }
      // growth mode: no per-year entries saved (formula-driven)
    }
    saveMut.mutate({ payload, settingsPatches });
  };

  const isLoading = sourcesQ.isLoading || entriesQ.isLoading;
  const businessSources = sources.filter(isBusiness);
  const hasNonBusiness = sources.some((s) => !isBusiness(s));

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
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={enterEdit} disabled={!hasNonBusiness}>
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
            <Button onClick={() => setShowAdd(true)} className="gap-1.5"><Plus size={14} /> Thêm nguồn đầu tiên</Button>
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
                {sources.map((src) => {
                  const clickable = isBusiness(src);
                  const isSelected = selectedCalcSrc?.id === src.id;
                  return (
                    <tr
                      key={src.id}
                      className={`border-b border-border/50 transition-colors ${clickable ? "hover:bg-muted/30" : "hover:bg-muted/20"} ${isSelected ? "bg-primary/5" : ""}`}
                    >
                      {/* source label cell */}
                      <td
                        className={`sticky left-0 z-10 px-4 border-r border-border/40 ${isSelected ? "bg-primary/5" : "bg-background"} ${clickable ? "cursor-pointer" : ""} ${editMode && !clickable ? "py-2" : "py-2.5"}`}
                        onClick={() => handleSourceClick(src)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {editMode && (
                            <button className="shrink-0 text-muted-foreground/50 hover:text-red-400 transition-colors" onClick={(e) => { e.stopPropagation(); delMut.mutate(src.id); }} title="Xoá nguồn">
                              <Trash2 size={12} />
                            </button>
                          )}
                          <span className="shrink-0 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: src.color }} />
                          <span className="font-medium truncate">{src.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded leading-none">{typeLabel(src.type)}</span>
                          {/* view mode: growth badge */}
                          {!editMode && !clickable && src.forecastMode === "growth" && src.forecastRate && (
                            <span className="shrink-0 ml-auto text-[10px] text-emerald-400 font-medium">↗ {Number(src.forecastRate)}%/năm</span>
                          )}
                          {clickable && !isSelected && <ChevronRight size={11} className="shrink-0 ml-auto text-muted-foreground/40" />}
                          {clickable && isSelected && <span className="shrink-0 ml-auto text-[10px] text-primary/60">← bảng tính</span>}
                        </div>
                        {/* edit mode: mode toggle + rate input for non-business sources */}
                        {editMode && !clickable && editSrcSettings[src.id] && (
                          <div className="flex items-center gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center rounded border border-border overflow-hidden text-[10px]">
                              {(["manual", "growth"] as const).map((m, i) => (
                                <button
                                  key={m}
                                  className={`px-1.5 py-0.5 transition-colors ${i > 0 ? "border-l border-border" : ""} ${editSrcSettings[src.id]!.mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                                  onClick={() => setSourceSetting(src.id, { mode: m })}
                                >
                                  {m === "manual" ? "Thủ công" : "↗ Tăng trưởng"}
                                </button>
                              ))}
                            </div>
                            {editSrcSettings[src.id]!.mode === "growth" && (
                              <>
                                <input
                                  type="number" min={0} step={1}
                                  className="w-20 text-xs bg-transparent border-b border-border/60 outline-none focus:border-primary tabular-nums py-0.5 text-right placeholder:text-muted-foreground/30"
                                  placeholder="Gốc 2026"
                                  value={editSrcSettings[src.id]!.base || ""}
                                  onChange={(e) => setSourceSetting(src.id, { base: Number(e.target.value) || 0 })}
                                />
                                <input
                                  type="number" min={0} step={0.1}
                                  className="w-12 text-xs bg-transparent border-b border-border/60 outline-none focus:border-primary tabular-nums py-0.5 text-right placeholder:text-muted-foreground/30"
                                  placeholder="0"
                                  value={editSrcSettings[src.id]!.rate || ""}
                                  onChange={(e) => setSourceSetting(src.id, { rate: Number(e.target.value) || 0 })}
                                />
                                <span className="text-[10px] text-muted-foreground">%/năm</span>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                      {YEARS.map((year) => {
                        const val = displayCells[src.id]?.[year] ?? 0;
                        const isGrowth = !clickable && editMode && editSrcSettings[src.id]?.mode === "growth";
                        return (
                          <td key={year} className={`px-3 py-2.5 text-right tabular-nums ${year === CURRENT_YEAR ? "bg-primary/5" : ""} ${isSelected ? "bg-primary/5" : ""}`}>
                            {editMode && !clickable && !isGrowth ? (
                              <input
                                type="number" min={0} step={1_000_000}
                                className="w-full text-right bg-transparent border-b border-border outline-none focus:border-primary tabular-nums text-xs py-0.5 placeholder:text-muted-foreground/30"
                                value={cells[src.id]?.[year] || ""}
                                placeholder="—"
                                onChange={(e) => setCell(src.id, year, Number(e.target.value) || 0)}
                              />
                            ) : (
                              <span className={`${val > 0 ? "text-foreground" : "text-muted-foreground/30"} ${clickable && val > 0 ? "text-emerald-400" : ""} ${isGrowth && val > 0 ? "text-blue-400" : ""}`}>
                                {fmtVND(val)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
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

        {/* ── project calculator section ─────────────────────── */}
        <div ref={calcSectionRef} className="scroll-mt-20">
          <div className="flex items-center gap-2 pt-4 pb-3">
            <ChevronRight size={13} className="text-muted-foreground" />
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-semibold">
              Bảng tính dự án
            </span>
          </div>

          {businessSources.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-xs text-muted-foreground">
                Thêm nguồn thu loại <span className="font-medium text-foreground">Kinh doanh</span> để sử dụng bảng tính dự án.
              </p>
            </Card>
          ) : !selectedCalcSrc ? (
            <Card className="p-6 space-y-3">
              <p className="text-xs text-muted-foreground text-center">Chọn một nguồn thu kinh doanh ở bảng trên để mở bảng tính.</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {businessSources.map((src) => (
                  <button
                    key={src.id}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors text-xs"
                    onClick={() => { setSelectedCalcSrc(src); setTimeout(() => calcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: src.color }} />
                    {src.name}
                  </button>
                ))}
              </div>
            </Card>
          ) : (
            // key forces remount when source changes → resets all local state + re-fetches
            <ProjectCalculator key={selectedCalcSrc.id} source={selectedCalcSrc} />
          )}
        </div>
      </main>

      {/* ── add source dialog ──────────────────────────────────── */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Thêm nguồn thu nhập</DialogTitle></DialogHeader>
          <div className="space-y-5 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="src-name">Tên nguồn thu</Label>
              <Input id="src-name" placeholder="VD: Lương chính, Cho thuê nhà…" value={newSrc.name}
                onChange={(e) => setNewSrc((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addMut.mutate(newSrc)} autoFocus />
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
