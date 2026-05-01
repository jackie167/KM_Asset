import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import { db, incomeExpenseTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

function serialize(row: typeof incomeExpenseTable.$inferSelect) {
  const income = parseFloat(String(row.income));
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
  const rows = await db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year));
  res.json(rows.map(serialize));
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
