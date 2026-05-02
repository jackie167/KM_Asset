import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import PageHeader from "@/pages/PageHeader";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatVNDFull } from "@/pages/assets/utils";

// ─── constants ───────────────────────────────────────────────────────────────

const CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "shopping", label: "Shopping", icon: "🛍️" },
  { key: "travel",   label: "Travel",   icon: "✈️" },
  { key: "support",  label: "Support",  icon: "🤝" },
  { key: "personal", label: "Personal", icon: "🧴" },
  { key: "other",    label: "Other",    icon: "📦" },
];

const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

// ─── types ───────────────────────────────────────────────────────────────────

type Expense = {
  id: number; amount: number; category: string;
  note: string | null; occurredAt: string; createdAt: string;
};
type Summary = {
  month: string; totalSpent: number;
  byCategory: { category: string; label: string; amount: number; count: number }[];
};
type DialogState = { open: false } | { open: true; mode: "add" } | { open: true; mode: "edit"; expense: Expense };
type ExpenseForecastRow = {
  id?: number;
  year: number;
  income: number;
  otherIncome: number;
  totalIncome: number;
  investmentRatio: number;
  investmentAmount: number;
  availableAfterInvestment: number;
  needLiving: number;
  needTuition: number;
  needAllowance: number;
  needMaintenance: number;
  needTotal: number;
  wantBudget: number;
  wantShopping: number;
  wantTravel: number;
  wantSupport: number;
  wantPersonal: number;
  wantOther: number;
  spendingFundChange: number;
  note: string | null;
};

// ─── api ─────────────────────────────────────────────────────────────────────

async function getExpenses(year: string): Promise<Expense[]> {
  const res = await fetch(`/api/expenses?year=${encodeURIComponent(year)}`);
  if (!res.ok) throw new Error("Failed to load expenses");
  return res.json();
}
async function getSummary(year: string): Promise<Summary> {
  const res = await fetch(`/api/expenses/summary?year=${encodeURIComponent(year)}`);
  if (!res.ok) throw new Error("Failed to load summary");
  return res.json();
}
async function createExpense(body: Omit<Expense, "id" | "createdAt">): Promise<Expense> {
  const res = await fetch("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("Failed to create expense");
  return res.json();
}
async function updateExpense(id: number, body: Partial<Omit<Expense, "id" | "createdAt">>): Promise<Expense> {
  const res = await fetch(`/api/expenses/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("Failed to update expense");
  return res.json();
}
async function deleteExpense(id: number): Promise<void> {
  const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete expense");
}
async function getExpenseForecast(): Promise<ExpenseForecastRow[]> {
  const res = await fetch("/api/expense-forecast");
  if (!res.ok) throw new Error("Failed to load expense forecast");
  return res.json();
}
async function saveExpenseForecast(rows: ExpenseForecastRow[]): Promise<ExpenseForecastRow[]> {
  const res = await fetch("/api/expense-forecast", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: rows.map((row) => ({
        year: row.year,
        income: row.income,
        otherIncome: row.otherIncome,
        investmentRatio: row.investmentRatio,
        needLiving: row.needLiving,
        needTuition: row.needTuition,
        needAllowance: row.needAllowance,
        needMaintenance: row.needMaintenance,
        wantBudget: row.wantBudget,
        wantShopping: row.wantShopping ?? 0,
        wantTravel:   row.wantTravel   ?? 0,
        wantSupport:  row.wantSupport  ?? 0,
        wantPersonal: row.wantPersonal ?? 0,
        wantOther:    row.wantOther    ?? 0,
        note: row.note,
      })),
    }),
  });
  if (!res.ok) throw new Error("Failed to save expense forecast");
  return res.json();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, hide = false) => hide ? "****" : formatVNDFull(v);
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const currentYear = () => String(new Date().getFullYear());

// ─── dialog ──────────────────────────────────────────────────────────────────

function ExpenseDialog({ state, onClose, onSave }: {
  state: DialogState;
  onClose: () => void;
  onSave: (d: { amount: number; category: string; note: string; occurredAt: string }) => void;
}) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("shopping");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayStr());

  useEffect(() => {
    if (!state.open) return;
    const init = state.mode === "edit" ? state.expense : null;
    setAmount(init ? String(init.amount) : "");
    setCategory(init?.category ?? "shopping");
    setNote(init?.note ?? "");
    setDate(init ? init.occurredAt.slice(0, 10) : todayStr());
  }, [state.open, state.open && (state as any).expense?.id]);

  if (!state.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <Card className="w-full max-w-sm p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{state.mode === "add" ? "Thêm chi tiêu" : "Chỉnh sửa"}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); const amt = parseFloat(amount.replace(/[^0-9.]/g, "")); if (!amt || amt <= 0) return; onSave({ amount: amt, category, note, occurredAt: new Date(date).toISOString() }); }} className="space-y-3">
          {[
            { label: "Số tiền", el: <input type="text" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" required className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" /> },
            { label: "Danh mục", el: <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary">{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.icon} {c.label}</option>)}</select> },
            { label: "Ghi chú", el: <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tùy chọn..." className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" /> },
            { label: "Ngày", el: <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" /> },
          ].map(({ label, el }) => (
            <div key={label} className="space-y-1">
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</label>
              {el}
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onClose}>Huỷ</Button>
            <Button type="submit" size="sm" className="flex-1">Lưu</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────

export default function ExpenseTrackerPage() {
  const [year, setYear] = useState(currentYear);
  const [hide, setHide] = useState(() => localStorage.getItem("hide_values") === "1");
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [forecastEditing, setForecastEditing] = useState(false);
  const [forecastDraft, setForecastDraft] = useState<Record<number, ExpenseForecastRow>>({});
  const qc = useQueryClient();

  const expensesQuery = useQuery({ queryKey: ["expenses", year], queryFn: () => getExpenses(year) });
  const summaryQuery  = useQuery({ queryKey: ["expenses-summary", year], queryFn: () => getSummary(year) });
  const selectedYear = Number(year);
  const forecastQuery = useQuery({ queryKey: ["expense-forecast"], queryFn: getExpenseForecast });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["expenses", year] });
    qc.invalidateQueries({ queryKey: ["expenses-summary", year] });
  };

  const createMut = useMutation({ mutationFn: createExpense, onSuccess: () => { invalidate(); setDialog({ open: false }); } });
  const updateMut = useMutation({ mutationFn: ({ id, ...body }: { id: number } & Partial<Omit<Expense,"id"|"createdAt">>) => updateExpense(id, body), onSuccess: () => { invalidate(); setDialog({ open: false }); } });
  const deleteMut = useMutation({ mutationFn: deleteExpense, onSuccess: invalidate });
  const saveForecastMut = useMutation({
    mutationFn: saveExpenseForecast,
    onSuccess: () => {
      setForecastEditing(false);
      qc.invalidateQueries({ queryKey: ["expense-forecast"] });
    },
  });

  const forecastRows = forecastQuery.data ?? [];
  const selectedForecast = useMemo(
    () => forecastRows.find((row) => row.year === selectedYear) ?? forecastRows.findLast((row) => row.year <= selectedYear) ?? forecastRows[0],
    [forecastRows, selectedYear]
  );
  const alloc = {
    invest: selectedForecast?.investmentAmount ?? 0,
    needTotal: selectedForecast?.needTotal ?? 0,
    needLiving: selectedForecast?.needLiving ?? 0,
    needTuition: selectedForecast?.needTuition ?? 0,
    needAllowance: selectedForecast?.needAllowance ?? 0,
    needMaint: selectedForecast?.needMaintenance ?? 0,
    want: selectedForecast?.wantBudget ?? 0,
  };

  const totalIncome = selectedForecast?.totalIncome ?? 0;
  const annualBudget = alloc.want > 0 ? alloc.want : null;
  const availableYears = forecastRows.length > 0
    ? forecastRows.map((row) => row.year)
    : [2024, 2025, 2026, 2027, 2028];

  const totalSpent = summaryQuery.data?.totalSpent ?? 0;
  const budgetUsed = annualBudget && annualBudget > 0 ? totalSpent / annualBudget : null;
  const remaining  = annualBudget != null ? annualBudget - totalSpent : null;

  const expenses   = expensesQuery.data ?? [];
  const byCategory = summaryQuery.data?.byCategory ?? [];

  const handleSave = (data: { amount: number; category: string; note: string; occurredAt: string }) => {
    if (dialog.open && dialog.mode === "edit") updateMut.mutate({ id: dialog.expense.id, ...data });
    else createMut.mutate(data as any);
  };

  const beginForecastEdit = () => {
    const sorted = [...forecastRows].sort((a, b) => a.year - b.year);
    const draft: typeof forecastDraft = {};
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i]!;
      const prev = i > 0 ? draft[sorted[i - 1]!.year] : undefined;
      const shopping  = row.wantShopping ?? 0;
      const travel    = row.wantTravel   ?? 0;
      const support   = row.wantSupport  ?? 0;
      const personal  = row.wantPersonal ?? 0;
      const other     = row.wantOther    ?? 0;
      const hasCats   = shopping + travel + support + personal + other > 0;
      const prevHas   = prev && (prev.wantShopping + prev.wantTravel + prev.wantSupport + prev.wantPersonal + prev.wantOther) > 0;
      if (!hasCats && prevHas && prev) {
        const f = Math.pow(1.04, row.year - sorted[i - 1]!.year);
        const s = prev.wantShopping * f;
        const t = prev.wantTravel   * f;
        const su = prev.wantSupport  * f;
        const p = prev.wantPersonal * f;
        const o = prev.wantOther    * f;
        draft[row.year] = { ...row, wantShopping: s, wantTravel: t, wantSupport: su, wantPersonal: p, wantOther: o, wantBudget: s + t + su + p + o };
      } else {
        draft[row.year] = { ...row, wantShopping: shopping, wantTravel: travel, wantSupport: support, wantPersonal: personal, wantOther: other };
      }
    }
    setForecastDraft(draft);
    setForecastEditing(true);
  };

  const updateForecastDraft = (year: number, key: keyof ExpenseForecastRow, value: string) => {
    setForecastDraft((current) => {
      const row = current[year];
      if (!row) return current;
      const numericValue = Number(value.replace(/[^\d.-]/g, ""));
      const next = {
        ...row,
        [key]: Number.isFinite(numericValue) ? numericValue : 0,
      };
      const totalIncome = next.income + next.otherIncome;
      const investmentAmount = totalIncome * (next.investmentRatio / 100);
      const availableAfterInvestment = totalIncome - investmentAmount;
      const needTotal = next.needLiving + next.needTuition + next.needAllowance + next.needMaintenance;
      const wantCatTotal = (next.wantShopping ?? 0) + (next.wantTravel ?? 0) + (next.wantSupport ?? 0) + (next.wantPersonal ?? 0) + (next.wantOther ?? 0);
      const wantBudget = wantCatTotal > 0 ? wantCatTotal : next.wantBudget;
      const spendingFundChange = availableAfterInvestment - needTotal - wantBudget;
      return {
        ...current,
        [year]: {
          ...next,
          totalIncome,
          investmentAmount,
          availableAfterInvestment,
          needTotal,
          wantBudget,
          spendingFundChange,
        },
      };
    });
  };

  const saveForecastDraft = () => {
    saveForecastMut.mutate(Object.values(forecastDraft).sort((a, b) => a.year - b.year));
  };

  const barColor = (pct: number | null) =>
    !pct ? "bg-primary" : pct >= 1 ? "bg-red-500" : pct >= 0.8 ? "bg-amber-400" : "bg-emerald-500";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="Chi tiêu"
        subtitle={`Theo dõi Want budget · ${year}`}
        inlineRight={
          <select value={year} onChange={(e) => setYear(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary">
            {availableYears.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        }
        actions={[{
          kind: "item",
          label: hide ? "Hiện số liệu" : "Ẩn số liệu",
          onSelect: () => { const n = !hide; setHide(n); localStorage.setItem("hide_values", n ? "1" : "0"); },
        }]}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-6">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Forecast chi tiêu</p>
              <p className="text-xs text-muted-foreground">Thu nhập trừ phần đầu tư, sau đó phân bổ Need / Want / Spending fund.</p>
            </div>
            <div className="flex items-center gap-2">
              {forecastEditing ? (
                <>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setForecastEditing(false)}>Huỷ</Button>
                  <Button size="sm" className="h-8 text-xs" disabled={saveForecastMut.isPending} onClick={saveForecastDraft}>
                    {saveForecastMut.isPending ? "Đang lưu..." : "Lưu"}
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={beginForecastEdit} disabled={!forecastRows.length}>
                  Edit
                </Button>
              )}
            </div>
          </div>
          <Card className="overflow-x-auto">
            {forecastQuery.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading...</div>
            ) : forecastRows.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Chưa có dữ liệu forecast chi tiêu.</div>
            ) : (() => {
              const inputCls = "h-7 w-full text-right text-xs tabular-nums";
              type DataRow = {
                label: string;
                field?: keyof ExpenseForecastRow;
                render: (row: ExpenseForecastRow, editRow: ExpenseForecastRow, yr: number) => React.ReactNode;
                className?: string;
                indent?: boolean;
              };
              const dataRows: DataRow[] = [
                { label: "Income",          field: "income",          className: "", render: (r, e, yr) => forecastEditing ? <Input value={String(e.income)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "income", ev.target.value)} /> : fmt(r.income, hide) },
                { label: "Other income",    field: "otherIncome",     className: "", render: (r, e, yr) => forecastEditing ? <Input value={String(e.otherIncome)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "otherIncome", ev.target.value)} /> : fmt(r.otherIncome, hide) },
                { label: "Invest %",        field: "investmentRatio", className: "", render: (r, e, yr) => forecastEditing ? <Input value={String(e.investmentRatio)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "investmentRatio", ev.target.value)} /> : `${r.investmentRatio.toFixed(1)}%` },
                { label: "Investment",      className: "text-emerald-400 font-semibold", render: (r, e) => fmt(e.investmentAmount, hide) },
                { label: "After invest",    className: "text-muted-foreground", render: (r, e) => fmt(e.availableAfterInvestment, hide) },
                { label: "Need",            className: "font-semibold", render: (r, e) => fmt(e.needTotal, hide) },
                { label: "· Living",        field: "needLiving",      indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.needLiving)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "needLiving", ev.target.value)} /> : fmt(r.needLiving, hide) },
                { label: "· Tuition",       field: "needTuition",     indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.needTuition)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "needTuition", ev.target.value)} /> : fmt(r.needTuition, hide) },
                { label: "· Allowance",     field: "needAllowance",   indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.needAllowance)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "needAllowance", ev.target.value)} /> : fmt(r.needAllowance, hide) },
                { label: "· Maintenance",   field: "needMaintenance", indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.needMaintenance)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "needMaintenance", ev.target.value)} /> : fmt(r.needMaintenance, hide) },
                { label: "Want",            className: "text-primary font-bold", render: (r, e) => <span className="text-primary">{fmt(e.wantBudget, hide)}</span> },
                { label: "· Shopping",      field: "wantShopping", indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.wantShopping)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "wantShopping", ev.target.value)} /> : fmt(r.wantShopping, hide) },
                { label: "· Travel",        field: "wantTravel",   indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.wantTravel)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "wantTravel", ev.target.value)} /> : fmt(r.wantTravel, hide) },
                { label: "· Support",       field: "wantSupport",  indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.wantSupport)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "wantSupport", ev.target.value)} /> : fmt(r.wantSupport, hide) },
                { label: "· Personal",      field: "wantPersonal", indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.wantPersonal)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "wantPersonal", ev.target.value)} /> : fmt(r.wantPersonal, hide) },
                { label: "· Other",         field: "wantOther",    indent: true, render: (r, e, yr) => forecastEditing ? <Input value={String(e.wantOther)} inputMode="decimal" className={inputCls} onChange={(ev) => updateForecastDraft(yr, "wantOther", ev.target.value)} /> : fmt(r.wantOther, hide) },
                { label: "Spending fund Δ", className: "", render: (r, e) => <span className={e.spendingFundChange >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>{fmt(e.spendingFundChange, hide)}</span> },
              ];
              return (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/60 text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="px-4 py-2.5 text-left font-medium sticky left-0 bg-card w-28 min-w-[7rem]">Chỉ số</th>
                      {forecastRows.map((r) => (
                        <th key={r.year} className={`px-3 py-2.5 text-right font-medium min-w-[7rem] ${r.year === selectedYear ? "text-primary" : ""}`}>
                          {r.year}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {dataRows.map((dr) => (
                      <tr key={dr.label} className={dr.indent ? "bg-muted/10" : "hover:bg-muted/20"}>
                        <td className={`px-4 py-2 sticky left-0 bg-card whitespace-nowrap text-muted-foreground ${dr.indent ? "pl-7 text-[10px]" : "font-medium"}`}>
                          {dr.label}
                        </td>
                        {forecastRows.map((r) => {
                          const editRow = forecastEditing ? forecastDraft[r.year] ?? r : r;
                          return (
                            <td key={r.year} className={`px-3 py-2 text-right tabular-nums ${r.year === selectedYear ? "bg-primary/5" : ""} ${dr.className ?? ""}`}>
                              {dr.render(r, editRow, r.year)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
          </Card>
        </section>

        {/* ── Phân bổ + Want Budget (side by side on landscape) ───────────── */}
        <div className="grid md:grid-cols-2 gap-6 items-start">

        {/* Phân bổ thu nhập */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Phân bổ thu nhập {year}</p>
            <button type="button" onClick={beginForecastEdit}
              className="text-[10px] text-muted-foreground hover:text-foreground border border-border/50 rounded px-2 py-0.5 transition-colors">
              Chỉnh sửa
            </button>
          </div>
          <Card className="overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-2/5" />
                <col className="w-2/5" />
                <col className="w-1/5" />
              </colgroup>
              <tbody className="divide-y divide-border/40">
                {/* Investment */}
                <tr className="hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-semibold">Investment</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmt(alloc.invest, hide)}</td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground text-xs">
                    {totalIncome > 0 ? fmtPct(alloc.invest / totalIncome) : "—"}
                  </td>
                </tr>
                {/* Need */}
                <tr className="hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-semibold">Need</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmt(alloc.needTotal, hide)}</td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground text-xs">
                    {totalIncome > 0 ? fmtPct(alloc.needTotal / totalIncome) : "—"}
                  </td>
                </tr>
                {[
                  { label: "Living cost",  val: alloc.needLiving },
                  { label: "Tuition",      val: alloc.needTuition },
                  { label: "Allowance",    val: alloc.needAllowance },
                  { label: "Maintenance",  val: alloc.needMaint },
                ].map(({ label, val }) => (
                  <tr key={label} className="bg-muted/10 hover:bg-muted/20">
                    <td className="px-4 py-2 pl-8 text-muted-foreground text-xs">{label}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{fmt(val, hide)}</td>
                    <td />
                  </tr>
                ))}
                {/* Want — highlighted */}
                <tr className="bg-primary/5 hover:bg-primary/10">
                  <td className="px-4 py-2.5 font-bold text-primary">Want</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold text-primary">{fmt(alloc.want, hide)}</td>
                  <td className="px-3 py-2.5 text-right text-primary text-xs font-semibold">
                    {totalIncome > 0 ? fmtPct(alloc.want / totalIncome) : "—"}
                  </td>
                </tr>
                {/* Want sub-items: actual spending by category */}
                {CATEGORIES.map((cat) => {
                  const spent = byCategory.find((b) => b.category === cat.key)?.amount ?? 0;
                  return (
                    <tr key={cat.key} className="bg-muted/10 hover:bg-muted/20">
                      <td className="px-4 py-2 pl-8 text-muted-foreground text-xs">{cat.icon} {cat.label}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{fmt(spent, hide)}</td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {alloc.want > 0 ? fmtPct(spent / alloc.want) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {/* Want: Đã chi tổng + Còn lại */}
                <tr className="bg-muted/10 hover:bg-muted/20">
                  <td className="px-4 py-2 pl-8 text-muted-foreground text-xs">Tổng đã chi</td>
                  <td className="px-4 py-2 text-right tabular-nums text-xs font-medium">{fmt(totalSpent, hide)}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {alloc.want > 0 ? fmtPct(totalSpent / alloc.want) : "—"}
                  </td>
                </tr>
                <tr className="bg-muted/10 hover:bg-muted/20">
                  <td className="px-4 py-2 pl-8 text-xs font-semibold">Còn lại</td>
                  <td className={`px-4 py-2 text-right tabular-nums text-xs font-semibold ${remaining != null && remaining < 0 ? "text-red-400" : "text-emerald-400"}`}>
                    {remaining != null ? fmt(remaining, hide) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {alloc.want > 0 && remaining != null ? fmtPct(remaining / alloc.want) : "—"}
                  </td>
                </tr>
                {/* Total */}
                <tr className="border-t-2 border-border">
                  <td className="px-4 py-2.5 font-bold">Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold">{fmt(totalIncome, hide)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </Card>
          {selectedForecast && (
            <p className="text-[11px] text-muted-foreground">
              Dữ liệu lấy từ expense_forecast năm {selectedForecast.year}
            </p>
          )}
        </section>

        {/* Want Budget */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Want budget — năm {year}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Budget Want/năm", value: fmt(annualBudget, hide), sub: "Mục Want từ phân bổ thu nhập" },
              { label: "Đã chi",  value: fmt(totalSpent, hide), sub: budgetUsed != null ? `${fmtPct(budgetUsed)} want budget` : undefined },
              { label: "Còn lại", value: remaining != null ? fmt(remaining, hide) : "—", sub: remaining != null && remaining < 0 ? "Vượt Want budget!" : undefined },
              { label: "Số giao dịch", value: String(expenses.length), sub: `năm ${year}` },
            ].map((c) => (
              <Card key={c.label} className="p-4 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{c.label}</p>
                <p className="text-sm sm:text-lg md:text-xl font-bold tabular-nums break-all leading-snug">{c.value}</p>
                {c.sub && <p className="text-[10px] text-muted-foreground">{c.sub}</p>}
              </Card>
            ))}
          </div>

          {annualBudget != null && (
            <Card className="p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Tổng chi tiêu Want năm {year}</span>
                <span className={`font-semibold ${(budgetUsed ?? 0) >= 1 ? "text-red-400" : (budgetUsed ?? 0) >= 0.8 ? "text-amber-400" : "text-emerald-400"}`}>
                  {budgetUsed != null ? fmtPct(budgetUsed) : "—"}
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full transition-all ${barColor(budgetUsed)}`}
                  style={{ width: `${Math.min((budgetUsed ?? 0) * 100, 100)}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0</span>
                <span className="text-amber-400">80%</span>
                <span className="text-red-400">100% = {fmt(annualBudget, hide)}</span>
              </div>
            </Card>
          )}
        </section>

        </div>{/* end grid md:grid-cols-2 */}

        {/* ── Category + Transactions (2-col on landscape) ─────────────────── */}
        <div className="grid md:grid-cols-2 gap-6 items-start">

        {/* ── Category Breakdown ───────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Phân loại chi tiêu Want — {year}</p>
          <div className="grid grid-cols-2 gap-3">
            {CATEGORIES.map((cat) => {
              const data = byCategory.find((b) => b.category === cat.key);
              const amount = data?.amount ?? 0;
              const pct = annualBudget && annualBudget > 0 ? amount / annualBudget : null;
              return (
                <Card key={cat.key} className="p-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-base">{cat.icon}</span>
                    <p className="text-xs font-medium truncate">{cat.label}</p>
                  </div>
                  <p className="text-sm sm:text-base md:text-lg font-bold tabular-nums break-all leading-snug">{fmt(amount, hide)}</p>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">{data?.count ? `${data.count} lần` : "0 lần"}</span>
                    <span className="font-semibold tabular-nums text-emerald-400">
                      {pct != null ? fmtPct(pct) : "—"}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min((pct ?? 0) * 100, 100)}%` }} />
                  </div>
                </Card>
              );
            })}
          </div>
        </section>

        {/* ── Transaction List ─────────────────────────────────────────────── */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Giao dịch Want — {year} ({expenses.length})
            </p>
            <Button size="sm" className="h-8 text-xs" onClick={() => setDialog({ open: true, mode: "add" })}>
              + Thêm chi tiêu
            </Button>
          </div>
          <Card className="overflow-hidden">
            {expensesQuery.isLoading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
            ) : expenses.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-3xl">💸</p>
                <p className="text-sm text-muted-foreground">Chưa có chi tiêu nào tháng này</p>
                <Button size="sm" variant="outline" onClick={() => setDialog({ open: true, mode: "add" })}>
                  Thêm chi tiêu đầu tiên
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {expenses.map((exp) => {
                  const cat = CAT_MAP[exp.category];
                  return (
                    <div key={exp.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                      <span className="text-xl shrink-0">{cat?.icon ?? "📦"}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium">{cat?.label ?? exp.category}</p>
                        {exp.note && <p className="text-[10px] text-muted-foreground truncate">{exp.note}</p>}
                        <p className="text-[10px] text-muted-foreground">{format(new Date(exp.occurredAt), "dd/MM/yyyy")}</p>
                      </div>
                      <p className="text-sm font-semibold tabular-nums shrink-0">{fmt(exp.amount, hide)}</p>
                      <div className="flex gap-1 shrink-0">
                        <button type="button" onClick={() => setDialog({ open: true, mode: "edit", expense: exp })}
                          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/50 hover:border-border transition">Edit</button>
                        <button type="button" onClick={() => { if (confirm("Xóa giao dịch này?")) deleteMut.mutate(exp.id); }}
                          className="text-[10px] text-muted-foreground hover:text-red-400 px-1.5 py-0.5 rounded border border-border/50 hover:border-red-400/50 transition">Del</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </section>

        </div>{/* end grid md:grid-cols-2 category+transactions */}
      </main>

      <ExpenseDialog state={dialog} onClose={() => setDialog({ open: false })} onSave={handleSave} />
    </div>
  );
}
