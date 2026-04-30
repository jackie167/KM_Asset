import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import PageHeader from "@/pages/PageHeader";
import type { HoldingItem } from "@/pages/assets/types";
import { formatVNDFull } from "@/pages/assets/utils";
import { CASHFLOW_SOURCE_SHEET, fetchCashflowData, fetchTotalAssetData } from "@/lib/excel-sheets";
import { fetchWealthAllocationHoldings } from "@/pages/wealthAllocationData";
import {
  INVEST_TYPES, DEFAULT_RATES, DEFAULT_ALLOCATION_RATIOS,
  DB_KEYS, readJsonRecord, parsePercentInput,
  fetchCurrentAssetData, fetchForecastTrades, fetchFreeCashRows,
  computeForecastTotals, loadDbSetting, saveDbSetting,
} from "@/lib/asset-forecast";

const FIRE_DB_KEYS = {
  wr:        "fire_wr",
  ret:       "fire_ret",
  age:       "fire_age",
  targetAge: "fire_target_age",
  spend:     "fire_spend",
  assetMode: "fire_asset_mode",
} as const;

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, hide = false) {
  if (hide) return "****";
  return formatVNDFull(v);
}

function fmtPct(v: number | null | undefined, dec = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(dec)}%`;
}

function fmtYear(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—";
  if (v > 100) return ">100 năm";
  const y = Math.floor(v);
  const m = Math.round((v - y) * 12);
  if (y === 0) return `${m} tháng`;
  if (m === 0) return `${y} năm`;
  return `${y} năm ${m} tháng`;
}

// Years to reach target FV given PV, PMT/year, annual rate r
function yearsToFire(pv: number, pmt: number, r: number, fv: number): number | null {
  if (fv <= pv) return 0;
  if (r === 0) return pmt > 0 ? (fv - pv) / pmt : null;
  if (pmt + pv * r <= 0) return null;
  const n = Math.log((fv * r + pmt) / (pv * r + pmt)) / Math.log(1 + r);
  return n > 0 && Number.isFinite(n) ? n : null;
}

type Tone = "positive" | "negative" | "warn" | "neutral";
const T: Record<Tone, string> = {
  positive: "text-emerald-400",
  negative: "text-red-400",
  warn: "text-amber-400",
  neutral: "text-muted-foreground",
};

function tonePct(v: number | null, good: number): Tone {
  if (v == null) return "neutral";
  return v >= good ? "positive" : v >= good * 0.5 ? "warn" : "negative";
}

// ─── fetchers ────────────────────────────────────────────────────────────────

async function fetchInvestmentSummary() {
  const res = await fetch("/api/portfolio/summary");
  if (!res.ok) throw new Error();
  return res.json() as Promise<{ holdings: HoldingItem[] }>;
}

async function fetchXirr() {
  const res = await fetch("/api/portfolio/xirr");
  const d = await res.json().catch(() => null);
  return { xirrAnnual: typeof d?.xirrAnnual === "number" ? d.xirrAnnual : null };
}

// ─── small components ────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, tone = "neutral", loading = false }: {
  label: string; value: string; sub?: string; tone?: Tone; loading?: boolean;
}) {
  return (
    <Card className="p-4 space-y-1 min-w-0">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{label}</p>
      {loading
        ? <div className="h-7 w-32 rounded bg-muted animate-pulse" />
        : <p className={`text-sm sm:text-base md:text-xl font-bold tabular-nums break-all leading-snug ${T[tone]}`}>{value}</p>}
      {sub && <p className="text-[10px] sm:text-xs text-muted-foreground break-words">{sub}</p>}
    </Card>
  );
}

function ProgressBar({ pct, tone }: { pct: number; tone: Tone }) {
  const w = Math.min(Math.round(pct * 100), 100);
  const color = tone === "positive" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-400" : "bg-primary";
  return (
    <div className="h-2 rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function StepInput({ label, value, onChange, step, min, format }: {
  label: string; value: number; onChange: (v: number) => void;
  step: number; min?: number; format: (v: number) => string;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasRepeatingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const clamp = (v: number) => min != null ? Math.max(min, v) : v;

  const startPress = (delta: number) => {
    wasRepeatingRef.current = false;
    timerRef.current = setTimeout(() => {
      wasRepeatingRef.current = true;
      intervalRef.current = setInterval(() => {
        valueRef.current = clamp(valueRef.current + delta);
        onChange(valueRef.current);
      }, 80);
    }, 2000);
  };

  const clearPress = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  // Single tap: fires after mouseup (click) — skip if auto-repeat already ran
  const handleTap = (delta: number) => {
    clearPress();
    if (!wasRepeatingRef.current) {
      onChange(clamp(valueRef.current + delta));
    }
    wasRepeatingRef.current = false;
  };

  const btnProps = (delta: number) => ({
    type: "button" as const,
    onMouseDown: () => startPress(delta),
    onMouseUp: () => handleTap(delta),
    onMouseLeave: () => { clearPress(); wasRepeatingRef.current = false; },
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); startPress(delta); },
    onTouchEnd: (e: React.TouchEvent) => { e.preventDefault(); handleTap(delta); },
    className: "px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 active:bg-muted/60 transition-colors shrink-0 select-none",
  });

  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-tight">{label}</p>
      <div className="flex items-center rounded border border-border overflow-hidden">
        <button {...btnProps(-step)}>−</button>
        <span className="flex-1 text-center text-sm tabular-nums font-medium py-1.5 px-1 min-w-0 truncate">
          {format(value)}
        </span>
        <button {...btnProps(+step)}>+</button>
      </div>
    </div>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

const LS = {
  get: (k: string, def: number) => { const v = localStorage.getItem(k); return v != null ? Number(v) : def; },
  set: (k: string, v: number) => localStorage.setItem(k, String(v)),
};

export default function FirePlanningPage() {
  const [hide, setHide] = useState(() => localStorage.getItem("hide_values") === "1");

  // User params (localStorage-backed)
  const [withdrawalRate, setWithdrawalRate] = useState(() => LS.get("fire_wr", 4));          // %
  const [expectedReturn, setExpectedReturn] = useState(() => LS.get("fire_ret", 8));          // %
  const [currentAge, setCurrentAge] = useState(() => LS.get("fire_age", 35));
  const [targetAge, setTargetAge] = useState(() => LS.get("fire_target_age", 55));
  const [customSpend, setCustomSpend] = useState(() => LS.get("fire_spend", 0));              // 0 = auto from cashflow
  const [fireAssetMode, setFireAssetMode] = useState<"investment" | "networth">(() =>
    localStorage.getItem("fire_asset_mode") === "networth" ? "networth" : "investment"
  );

  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounceSaveDb = (key: string, value: string, delay = 1500) => {
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => { void saveDbSetting(key, value); }, delay);
  };
  const save = (k: string, v: number) => { LS.set(k, v); debounceSaveDb(k, String(v)); };

  useEffect(() => {
    void (async () => {
      const vals = await Promise.all(Object.values(FIRE_DB_KEYS).map((k) => loadDbSetting(k)));
      const [wr, ret, age, targetAge, spend, assetMode] = vals;
      if (wr)        { LS.set(FIRE_DB_KEYS.wr, Number(wr));        setWithdrawalRate(Number(wr)); }
      if (ret)       { LS.set(FIRE_DB_KEYS.ret, Number(ret));       setExpectedReturn(Number(ret)); }
      if (age)       { LS.set(FIRE_DB_KEYS.age, Number(age));       setCurrentAge(Number(age)); }
      if (targetAge) { LS.set(FIRE_DB_KEYS.targetAge, Number(targetAge)); setTargetAge(Number(targetAge)); }
      if (spend)     { LS.set(FIRE_DB_KEYS.spend, Number(spend));   setCustomSpend(Number(spend)); }
      if (assetMode === "networth" || assetMode === "investment") {
        localStorage.setItem("fire_asset_mode", assetMode);
        setFireAssetMode(assetMode);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Queries
  const investQuery = useQuery({ queryKey: ["dashboard-investment"], queryFn: fetchInvestmentSummary });
  const xirrQuery = useQuery({ queryKey: ["portfolio-xirr"], queryFn: fetchXirr });
  const cashflowQuery = useQuery({ queryKey: ["excel-function-cashflow"], queryFn: fetchCashflowData });
  const totalAssetQuery = useQuery({ queryKey: ["excel-total-asset"], queryFn: fetchTotalAssetData });
  const wealthQuery = useQuery({ queryKey: ["wealth-allocation-holdings"], queryFn: fetchWealthAllocationHoldings });
  // Forecast data — same query keys as AssetForecastPage so cache is shared
  const forecastAssetQuery = useQuery({ queryKey: ["asset-forecast-current-asset"], queryFn: fetchCurrentAssetData });
  const forecastCashQuery = useQuery({ queryKey: ["asset-forecast-free-cash-rows"], queryFn: fetchFreeCashRows });
  const forecastTradesQuery = useQuery({ queryKey: ["asset-forecast-trades"], queryFn: fetchForecastTrades });

  const isLoading = investQuery.isLoading || cashflowQuery.isLoading;

  // ── core numbers ────────────────────────────────────────────────────────────

  const financialAssets = useMemo(() => {
    const holdings: HoldingItem[] = investQuery.data?.holdings ?? [];
    return holdings.reduce((s, h) => s + (h.currentValue ?? 0), 0);
  }, [investQuery.data]);

  const annualSavings = useMemo(() => {
    const cf = cashflowQuery.data;
    if (!cf) return 0;
    return Math.max(cf.income - cf.expense, 0);
  }, [cashflowQuery.data]);

  const autoSpend = cashflowQuery.data?.expense ?? 0;
  const annualSpend = customSpend > 0 ? customSpend : autoSpend;

  const wr = withdrawalRate / 100;
  const r = expectedReturn / 100;
  const xirrActual = xirrQuery.data?.xirrAnnual;

  const fireNumber = wr > 0 ? annualSpend / wr : null;

  // Assets counted toward FIRE
  const wealthNetAsset = useMemo(() => {
    const holdings = wealthQuery.data ?? [];
    const total = holdings.reduce((s, h) => s + (h.currentValue ?? 0), 0);
    const debt = totalAssetQuery.data?.debt ?? 0;
    return total - debt;
  }, [wealthQuery.data, totalAssetQuery.data]);

  const fireAssets = fireAssetMode === "networth" ? wealthNetAsset : financialAssets;

  const fireProgress = fireNumber && fireNumber > 0 ? Math.min(fireAssets / fireNumber, 1) : null;
  const freedomRatio = annualSpend > 0 ? (fireAssets * wr) / annualSpend : null;

  // Passive income potential
  const annualPassiveIncome = fireAssets * wr;
  const monthlyPassiveIncome = annualPassiveIncome / 12;
  const monthlySpend = annualSpend / 12;

  // Time to FIRE — derived from forecast table (same data as AssetForecastPage)
  const forecastTotals = useMemo(() => {
    // Wait until all 3 queries finish to avoid flash with partial data
    if (forecastAssetQuery.isLoading || forecastCashQuery.isLoading || forecastTradesQuery.isLoading) return null;

    const currentAssetRows = forecastAssetQuery.data ?? [];
    const freeCashRows = forecastCashQuery.data ?? [];
    const forecastTrades = forecastTradesQuery.data ?? [];

    const allocationRecord = readJsonRecord(DB_KEYS.allocationRatios);
    const investReturnRecord = readJsonRecord(DB_KEYS.investmentReturns);
    const assetReturnRecord = readJsonRecord(DB_KEYS.assetReturns);

    const allocationRatios = INVEST_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = parsePercentInput(allocationRecord[t] ?? String(DEFAULT_ALLOCATION_RATIOS[t])) / 100;
      return acc;
    }, {}) as Record<typeof INVEST_TYPES[number], number>;

    const investmentReturnRates = INVEST_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = parsePercentInput(investReturnRecord[t] ?? String(DEFAULT_RATES[t])) / 100;
      return acc;
    }, {}) as Record<typeof INVEST_TYPES[number], number>;

    const assetReturnRates = Object.fromEntries(
      Object.entries(assetReturnRecord).map(([k, v]) => [k, parsePercentInput(v) / 100])
    );

    return computeForecastTotals({ currentAssetRows, freeCashRows, forecastTrades, allocationRatios, investmentReturnRates, assetReturnRates });
  }, [forecastAssetQuery.isLoading, forecastAssetQuery.data, forecastCashQuery.isLoading, forecastCashQuery.data, forecastTradesQuery.isLoading, forecastTradesQuery.data]);

  const { yearsLeft, fireYear } = useMemo(() => {
    if (!fireNumber || fireNumber <= 0 || !forecastTotals) {
      return { yearsLeft: null, fireYear: null };
    }
    const currentYear = new Date().getFullYear();
    const crossing = forecastTotals.find((row) => {
      // Compare the right value based on what fireAssets counts
      const comparableEnd = fireAssetMode === "investment"
        ? row.investmentEnd + row.endYearFreeCash
        : row.totalEnd;
      return comparableEnd >= fireNumber;
    });
    if (!crossing) return { yearsLeft: null, fireYear: null };
    return { fireYear: crossing.year, yearsLeft: crossing.year - currentYear };
  }, [forecastTotals, fireNumber, fireAssetMode]);

  // Coast FIRE
  const yearsToTarget = Math.max(targetAge - currentAge, 0);
  const coastFireNumber = fireNumber && yearsToTarget > 0
    ? fireNumber / Math.pow(1 + r, yearsToTarget)
    : null;
  const isCoastFire = coastFireNumber != null && fireAssets >= coastFireNumber;

  // Scenarios
  const scenarios = useMemo(() => {
    const base = annualSpend;
    return [
      { label: "Lean FIRE", multiplier: 0.7, color: "text-sky-400" },
      { label: "Normal FIRE", multiplier: 1.0, color: "text-emerald-400" },
      { label: "Fat FIRE", multiplier: 1.3, color: "text-amber-400" },
    ].map(({ label, multiplier, color }) => {
      const spend = base * multiplier;
      const target = wr > 0 ? spend / wr : null;
      const years = target ? yearsToFire(fireAssets, annualSavings, r, target) : null;
      const yr = years != null ? new Date().getFullYear() + Math.ceil(years) : null;
      const progress = target ? Math.min(fireAssets / target, 1) : null;
      return { label, spend, target, years, yr, progress, color };
    });
  }, [annualSpend, wr, fireAssets, annualSavings, r]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <PageHeader
        title="FIRE Planning"
        subtitle="Financial Independence, Retire Early"
        actions={[{
          kind: "item",
          label: hide ? "Hiện số liệu" : "Ẩn số liệu",
          onSelect: () => { const n = !hide; setHide(n); localStorage.setItem("hide_values", n ? "1" : "0"); },
        }]}
      />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-6 space-y-6">

        {/* ── Settings ─────────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Thông số cá nhân</p>
          <Card className="p-4 md:p-5">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <StepInput
                label="Chi tiêu/năm"
                value={customSpend > 0 ? customSpend : autoSpend}
                step={10_000_000}
                min={0}
                format={(v) => v === 0 ? "Tự động" : `${v.toLocaleString("vi-VN")} đ`}
                onChange={(v) => { setCustomSpend(v); save("fire_spend", v); }}
              />
              <StepInput
                label="Withdrawal Rate"
                value={withdrawalRate}
                step={0.5}
                min={0.5}
                format={(v) => `${v}%`}
                onChange={(v) => { setWithdrawalRate(v); save("fire_wr", v); }}
              />
              <StepInput
                label="Lãi suất kỳ vọng"
                value={expectedReturn}
                step={0.5}
                min={0}
                format={(v) => `${v}%`}
                onChange={(v) => { setExpectedReturn(v); save("fire_ret", v); }}
              />
              <StepInput
                label="Tuổi hiện tại"
                value={currentAge}
                step={1}
                min={1}
                format={(v) => `${v} tuổi`}
                onChange={(v) => { setCurrentAge(v); save("fire_age", v); }}
              />
              <StepInput
                label="Tuổi mục tiêu FIRE"
                value={targetAge}
                step={1}
                min={1}
                format={(v) => `${v} tuổi`}
                onChange={(v) => { setTargetAge(v); save("fire_target_age", v); }}
              />
            </div>
            {autoSpend > 0 && customSpend === 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Chi tiêu tự động từ sheet {CASHFLOW_SOURCE_SHEET} ({cashflowQuery.data?.year}): {fmt(autoSpend, hide)} / năm
              </p>
            )}
            {xirrActual != null && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                XIRR thực tế hiện tại: {fmtPct(xirrActual)} / năm
                {Math.abs(xirrActual * 100 - expectedReturn) > 0.5 && (
                  <span className="text-amber-400 ml-1">(đang dùng {expectedReturn}% kỳ vọng)</span>
                )}
              </p>
            )}
          </Card>
        </section>

        {/* ── KPIs ─────────────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Chỉ số FIRE</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="FIRE Number"
              value={fmt(fireNumber, hide)}
              sub={`Chi tiêu ${fmt(annualSpend, hide)}/năm ÷ ${withdrawalRate}%`}
              loading={isLoading}
            />
            <Card className="p-4 space-y-1 min-w-0">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Tài sản hiện tại</p>
              {(isLoading || wealthQuery.isLoading)
                ? <div className="h-7 w-32 rounded bg-muted animate-pulse" />
                : <p className="text-sm sm:text-base md:text-xl font-bold tabular-nums break-all leading-snug">{fmt(fireAssets, hide)}</p>}
              <div className="flex gap-1 pt-1">
                {(["investment", "networth"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { setFireAssetMode(mode); localStorage.setItem("fire_asset_mode", mode); debounceSaveDb(FIRE_DB_KEYS.assetMode, mode); }}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${fireAssetMode === mode ? "bg-primary/10 border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    {mode === "investment" ? "Investment" : "Net worth"}
                  </button>
                ))}
              </div>
            </Card>
            <KpiCard
              label="Freedom Ratio"
              value={fmtPct(freedomRatio)}
              sub={`Thu nhập thụ động: ${fmt(annualPassiveIncome, hide)}/năm`}
              tone={tonePct(freedomRatio, 1)}
              loading={isLoading}
            />
            <KpiCard
              label="Thời gian đến FIRE"
              value={isLoading ? "…" : fmtYear(yearsLeft)}
              sub={fireYear ? `Dự kiến năm ${fireYear}` : undefined}
              tone={yearsLeft != null ? (yearsLeft <= 10 ? "positive" : yearsLeft <= 20 ? "warn" : "neutral") : "neutral"}
              loading={isLoading}
            />
          </div>
        </section>

        {/* ── Progress ─────────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Tiến độ đến FIRE</p>
          <Card className="p-4 md:p-6 space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {fmtPct(fireProgress)} hoàn thành
                  {fireProgress != null && fireProgress >= 1 && <span className="ml-2 text-emerald-400 font-bold">🎉 ĐÃ FIRE!</span>}
                </span>
                <span className="text-muted-foreground tabular-nums text-xs">
                  {hide ? "****" : `${fmt(fireAssets)} / ${fmt(fireNumber)}`}
                </span>
              </div>
              <ProgressBar pct={fireProgress ?? 0} tone={tonePct(fireProgress, 1)} />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0%</span>
                <span className="text-amber-400">25% (Starter)</span>
                <span className="text-sky-400">50% (Halfway)</span>
                <span className="text-emerald-400">100% FIRE</span>
              </div>
            </div>

            {/* Passive income vs spend */}
            <div className="grid md:grid-cols-2 gap-4 pt-2 border-t border-border/40">
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Thu nhập thụ động / tháng</p>
                <p className={`text-xl font-bold tabular-nums ${freedomRatio != null && freedomRatio >= 1 ? "text-emerald-400" : "text-foreground"}`}>
                  {fmt(monthlyPassiveIncome, hide)}
                </p>
                <p className="text-xs text-muted-foreground">từ {fmtPct(wr, 0)} × tài sản tài chính</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Chi tiêu mục tiêu / tháng</p>
                <p className="text-xl font-bold tabular-nums">{fmt(monthlySpend, hide)}</p>
                <p className={`text-xs font-medium ${freedomRatio != null && freedomRatio >= 1 ? "text-emerald-400" : "text-amber-400"}`}>
                  {freedomRatio != null ? `Thụ động bù được ${fmtPct(freedomRatio)} chi tiêu` : "—"}
                </p>
              </div>
            </div>
          </Card>
        </section>

        {/* ── Coast FIRE ───────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Coast FIRE</p>
          <Card className="p-4 md:p-6">
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Nếu ngừng tiết kiệm ngay hôm nay, tài sản có tự tăng đến FIRE number trước tuổi <strong className="text-foreground">{targetAge}</strong> không?
                </p>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Coast FIRE Number (tại tuổi {currentAge})</span>
                    <span className="font-semibold">{fmt(coastFireNumber, hide)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Tài sản hiện tại</span>
                    <span className="font-semibold">{fmt(fireAssets, hide)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Còn thiếu</span>
                    <span className={`font-semibold ${isCoastFire ? "text-emerald-400" : "text-amber-400"}`}>
                      {coastFireNumber != null ? (isCoastFire ? "Đã đạt Coast FIRE ✓" : fmt(coastFireNumber - fireAssets, hide)) : "—"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {isCoastFire ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-1">
                    <p className="text-sm font-semibold text-emerald-400">Đã đạt Coast FIRE!</p>
                    <p className="text-xs text-muted-foreground">
                      Dù ngừng tiết kiệm, tài sản hiện tại sẽ tự tăng đến {fmt(fireNumber, hide)} trước tuổi {targetAge} với lãi suất {expectedReturn}%/năm.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-1">
                    <p className="text-sm font-semibold text-amber-400">Chưa đạt Coast FIRE</p>
                    <p className="text-xs text-muted-foreground">
                      Cần {fmt(coastFireNumber, hide)} để Coast FIRE. Tiếp tục tích lũy thêm {fmt(coastFireNumber != null ? Math.max(coastFireNumber - fireAssets, 0) : null, hide)}.
                    </p>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Năm còn lại đến tuổi mục tiêu: {yearsToTarget} năm · Lãi suất: {expectedReturn}%/năm
                </p>
              </div>
            </div>
          </Card>
        </section>

        {/* ── Scenarios ────────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Kịch bản FIRE</p>
          <div className="grid md:grid-cols-3 gap-4">
            {scenarios.map((s) => (
              <Card key={s.label} className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className={`text-sm font-semibold ${s.color}`}>{s.label}</p>
                  <p className="text-[10px] text-muted-foreground">{fmtPct(s.progress)} done</p>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Chi tiêu/năm</span>
                    <span className="font-medium">{fmt(s.spend, hide)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">FIRE Number</span>
                    <span className="font-medium">{fmt(s.target, hide)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Thời gian</span>
                    <span className={`font-semibold ${s.color}`}>{fmtYear(s.years)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Năm FIRE</span>
                    <span className="font-medium">{s.yr ?? "—"}</span>
                  </div>
                </div>
                <ProgressBar pct={s.progress ?? 0} tone="neutral" />
              </Card>
            ))}
          </div>
        </section>

        {/* ── Milestones ───────────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Cột mốc tích lũy</p>
          <Card className="p-4 md:p-5">
            <div className="divide-y divide-border/40">
              {[
                { label: "Starter (25%)", pct: 0.25, emoji: "🌱" },
                { label: "Halfway (50%)", pct: 0.50, emoji: "🏃" },
                { label: "Almost there (75%)", pct: 0.75, emoji: "🚀" },
                { label: "FIRE! (100%)", pct: 1.00, emoji: "🎯" },
              ].map((m) => {
                const target = fireNumber ? fireNumber * m.pct : null;
                const reached = fireAssets >= (target ?? Infinity);
                const yearsToMilestone = target && !reached
                  ? yearsToFire(fireAssets, annualSavings, r, target)
                  : null;
                return (
                  <div key={m.label} className="flex items-center gap-3 py-2.5">
                    <span className="text-lg w-6 shrink-0">{m.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium ${reached ? "text-emerald-400" : "text-foreground"}`}>
                        {m.label} {reached && "✓"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{fmt(target, hide)}</p>
                    </div>
                    <p className={`text-xs font-semibold tabular-nums shrink-0 ${reached ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {reached ? "Đạt rồi!" : fmtYear(yearsToMilestone)}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>
        </section>

      </main>
    </div>
  );
}
