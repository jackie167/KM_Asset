import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import {
  db,
  incomeExpenseTable,
  incomeSourcesTable,
  incomeForecastTable,
  incomeProjectCalcTable,
} from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

const INCOME_YEAR_START = 2026;
const INCOME_YEAR_END   = 2044;
const INCOME_YEARS = Array.from({ length: INCOME_YEAR_END - INCOME_YEAR_START + 1 }, (_, i) => INCOME_YEAR_START + i);

function fcf(inp: Record<string, number>, type: "direct" | "per_ha"): number {
  const g = (k: string) => inp[k] ?? 0;
  const rev  = type === "per_ha" ? g("area") * g("yield_per_ha") * g("price") : g("revenue_direct");
  const cogs = type === "per_ha" ? g("area") * (g("cogs_material") + g("cogs_labor") + g("cogs_overhead")) : g("cogs_direct");
  const dep  = g("depreciation");
  const ebit = (rev - cogs) - dep - g("interest") - g("sga");
  return (ebit - Math.max(0, ebit) * (g("tax_rate") / 100)) + dep - g("capex") - g("delta_wc");
}

async function computedIncomeByYear(): Promise<Record<number, number>> {
  const [sources, forecastEntries, calcEntries] = await Promise.all([
    db.select().from(incomeSourcesTable).where(eq(incomeSourcesTable.active, true)),
    db.select().from(incomeForecastTable),
    db.select().from(incomeProjectCalcTable),
  ]);

  const totals: Record<number, number> = {};
  for (const y of INCOME_YEARS) totals[y] = 0;

  const fcBySource: Record<number, Record<number, number>> = {};
  for (const e of forecastEntries) {
    fcBySource[e.sourceId] ??= {};
    fcBySource[e.sourceId]![e.year] = Number(e.amount);
  }

  const calcBySource: Record<number, typeof calcEntries> = {};
  for (const e of calcEntries) { calcBySource[e.sourceId] ??= []; calcBySource[e.sourceId]!.push(e); }

  for (const src of sources) {
    if (src.type === "business") {
      const rows = calcBySource[src.id] ?? [];
      let calcType: "direct" | "per_ha" = "direct";
      const vals: Record<string, Record<number, number>> = {};
      for (const e of rows) {
        if (e.rowId === "_calc_type") { calcType = Number(e.value) === 1 ? "per_ha" : "direct"; continue; }
        vals[e.rowId] ??= {};
        vals[e.rowId]![e.year] = Number(e.value);
      }
      for (const year of INCOME_YEARS) {
        const inp: Record<string, number> = {};
        for (const [rowId, ym] of Object.entries(vals)) inp[rowId] = ym[year] ?? 0;
        totals[year]! += fcf(inp, calcType);
      }
    } else if (src.forecastMode === "growth" && Number(src.forecastBase) > 0) {
      const base = Number(src.forecastBase);
      const rate = Number(src.forecastRate) || 0;
      for (const year of INCOME_YEARS) {
        totals[year]! += base * Math.pow(1 + rate / 100, year - INCOME_YEAR_START);
      }
    } else {
      const stored = fcBySource[src.id] ?? {};
      for (const year of INCOME_YEARS) totals[year]! += stored[year] ?? 0;
    }
  }

  return totals;
}

function serialize(row: typeof incomeExpenseTable.$inferSelect, incomeOverride?: number) {
  const income = incomeOverride ?? parseFloat(String(row.income));
  const otherIncome = parseFloat(String(row.otherIncome));
  const expense = Math.abs(parseFloat(String(row.expense)));
  const otherExpense = Math.abs(parseFloat(String(row.otherExpense)));
  const totalInterest = Math.abs(parseFloat(String(row.totalInterest)));
  const totalIncome = income + otherIncome;
  const totalExpense = expense + otherExpense + totalInterest;
  return {
    id: row.id,
    year: row.year,
    income,
    otherIncome,
    expense,
    otherExpense,
    totalInterest,
    totalIncome,
    totalExpense,
    freeCash: totalIncome - totalExpense,
    note: row.note,
  };
}

const RowInput = z.object({
  year: z.number().int().min(2026).max(2044),
  income: z.number().default(0),
  otherIncome: z.number().default(0),
  expense: z.number().nonnegative().default(0),
  otherExpense: z.number().nonnegative().default(0),
  totalInterest: z.number().nonnegative().default(0),
  note: z.string().trim().max(500).optional().nullable(),
});

const ReplaceBody = z.object({
  rows: z.array(RowInput).min(1),
});

router.get("/income-expense", async (_req, res): Promise<void> => {
  const [dbRows, incomeMap] = await Promise.all([
    db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
    computedIncomeByYear(),
  ]);

  // Override income from income sources for forecast years; keep DB value for historical years
  const rowByYear = new Map(dbRows.map((r) => [r.year, r]));

  // Include all DB years + any forecast year that has computed income
  const allYears = new Set([
    ...dbRows.map((r) => r.year),
    ...INCOME_YEARS.filter((y) => (incomeMap[y] ?? 0) > 0),
  ]);

  const EMPTY_ROW_BASE = {
    id: 0, income: "0", otherIncome: "0", expense: "0",
    otherExpense: "0", totalInterest: "0", note: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  const result = [...allYears].sort((a, b) => a - b).map((year) => {
    const row = rowByYear.get(year) ?? { ...EMPTY_ROW_BASE, year };
    const override = INCOME_YEARS.includes(year) ? incomeMap[year] : undefined;
    return serialize(row, override);
  });

  res.json(result);
});

router.put("/income-expense", async (req, res): Promise<void> => {
  const parsed = ReplaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db.delete(incomeExpenseTable);
  const rows = await db
    .insert(incomeExpenseTable)
    .values(parsed.data.rows.map((row) => ({
      year: row.year,
      income: String(row.income),
      otherIncome: String(row.otherIncome),
      expense: String(row.expense),
      otherExpense: String(row.otherExpense),
      totalInterest: String(row.totalInterest),
      note: row.note ?? null,
    })))
    .returning();

  res.json(rows.map(serialize));
});

router.post("/income-expense/import", async (req, res): Promise<void> => {
  const parsed = ReplaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db.select({ id: incomeExpenseTable.id }).from(incomeExpenseTable).limit(1);
  if (existing.length > 0) {
    const rows = await db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year));
    res.json(rows.map(serialize));
    return;
  }

  const rows = await db
    .insert(incomeExpenseTable)
    .values(parsed.data.rows.map((row) => ({
      year: row.year,
      income: String(row.income),
      otherIncome: String(row.otherIncome),
      expense: String(row.expense),
      otherExpense: String(row.otherExpense),
      totalInterest: String(row.totalInterest),
      note: row.note ?? "Imported from Function sheet",
    })))
    .returning();

  res.status(201).json(rows.map(serialize));
});

export default router;
