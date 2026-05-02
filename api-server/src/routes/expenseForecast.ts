import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc } from "drizzle-orm";
import { db, expenseForecastTable, incomeExpenseTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

const DEFAULT_INVESTMENT_RATIO = 30;
const DEFAULT_NEED = {
  living: 420_000_000,
  tuition: 204_000_000,
  allowance: 360_000_000,
  maintenance: 80_155_640,
};
const DEFAULT_WANT = 1_009_786_160;
const DEFAULT_NEED_TOTAL =
  DEFAULT_NEED.living + DEFAULT_NEED.tuition + DEFAULT_NEED.allowance + DEFAULT_NEED.maintenance;
const DEFAULT_AFTER_INVESTMENT = DEFAULT_NEED_TOTAL + DEFAULT_WANT;
const DEFAULT_NEED_SHARE = DEFAULT_AFTER_INVESTMENT > 0 ? DEFAULT_NEED_TOTAL / DEFAULT_AFTER_INVESTMENT : 0.5;

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serialize(row: typeof expenseForecastTable.$inferSelect) {
  const income = num(row.income);
  const otherIncome = num(row.otherIncome);
  const totalIncome = income + otherIncome;
  const investmentRatio = num(row.investmentRatio);
  const investmentAmount = totalIncome * (investmentRatio / 100);
  const availableAfterInvestment = totalIncome - investmentAmount;
  const needLiving = num(row.needLiving);
  const needTuition = num(row.needTuition);
  const needAllowance = num(row.needAllowance);
  const needMaintenance = num(row.needMaintenance);
  const needTotal = needLiving + needTuition + needAllowance + needMaintenance;
  const wantShopping = num(row.wantShopping);
  const wantTravel = num(row.wantTravel);
  const wantSupport = num(row.wantSupport);
  const wantPersonal = num(row.wantPersonal);
  const wantOther = num(row.wantOther);
  const wantCategoryTotal = wantShopping + wantTravel + wantSupport + wantPersonal + wantOther;
  const wantBudget = wantCategoryTotal > 0 ? wantCategoryTotal : num(row.wantBudget);
  const spendingFundChange = availableAfterInvestment - needTotal - wantBudget;
  const actualNeed = row.actualNeed != null ? num(row.actualNeed) : null;
  const actualWant = row.actualWant != null ? num(row.actualWant) : null;
  const actualBalance = (actualNeed != null || actualWant != null)
    ? availableAfterInvestment - (actualNeed ?? needTotal) - (actualWant ?? wantBudget)
    : null;

  return {
    id: row.id,
    year: row.year,
    income, otherIncome, totalIncome, investmentRatio, investmentAmount, availableAfterInvestment,
    needLiving, needTuition, needAllowance, needMaintenance, needTotal,
    wantShopping, wantTravel, wantSupport, wantPersonal, wantOther,
    wantBudget, spendingFundChange,
    actualNeed, actualWant, actualBalance,
    note: row.note,
  };
}

function seedFromIncomeExpense(row: typeof incomeExpenseTable.$inferSelect) {
  const income = num(row.income);
  const otherIncome = num(row.otherIncome);
  const totalIncome = income + otherIncome;
  const availableAfterInvestment = totalIncome * (1 - DEFAULT_INVESTMENT_RATIO / 100);
  const needTotal = availableAfterInvestment * DEFAULT_NEED_SHARE;
  const needScale = DEFAULT_NEED_TOTAL > 0 ? needTotal / DEFAULT_NEED_TOTAL : 0;

  return {
    year: row.year,
    income: String(income),
    otherIncome: String(otherIncome),
    investmentRatio: String(DEFAULT_INVESTMENT_RATIO),
    needLiving: String(DEFAULT_NEED.living * needScale),
    needTuition: String(DEFAULT_NEED.tuition * needScale),
    needAllowance: String(DEFAULT_NEED.allowance * needScale),
    needMaintenance: String(DEFAULT_NEED.maintenance * needScale),
    wantBudget: String(Math.max(0, availableAfterInvestment - needTotal)),
    note: "Seeded from income_expense",
  } satisfies typeof expenseForecastTable.$inferInsert;
}

async function ensureSeedRows() {
  const existing = await db.select({ id: expenseForecastTable.id }).from(expenseForecastTable).limit(1);
  if (existing.length > 0) return;

  const sourceRows = await db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year));
  if (sourceRows.length === 0) return;

  await db.insert(expenseForecastTable).values(sourceRows.map(seedFromIncomeExpense));
}

const RowInput = z.object({
  year: z.number().int().min(2024).max(2100),
  income: z.number().default(0),
  otherIncome: z.number().default(0),
  investmentRatio: z.number().min(0).max(100).default(DEFAULT_INVESTMENT_RATIO),
  needLiving: z.number().nonnegative().default(0),
  needTuition: z.number().nonnegative().default(0),
  needAllowance: z.number().nonnegative().default(0),
  needMaintenance: z.number().nonnegative().default(0),
  wantBudget: z.number().nonnegative().default(0),
  wantShopping: z.number().nonnegative().default(0),
  actualNeed: z.number().nonnegative().nullable().optional(),
  actualWant: z.number().nonnegative().nullable().optional(),
  wantTravel: z.number().nonnegative().default(0),
  wantSupport: z.number().nonnegative().default(0),
  wantPersonal: z.number().nonnegative().default(0),
  wantOther: z.number().nonnegative().default(0),
  note: z.string().trim().max(500).optional().nullable(),
});

const ReplaceBody = z.object({
  rows: z.array(RowInput).min(1),
});

router.get("/expense-forecast", async (_req, res): Promise<void> => {
  await ensureSeedRows();
  const rows = await db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year));
  res.json(rows.map(serialize));
});

router.put("/expense-forecast", async (req, res): Promise<void> => {
  const parsed = ReplaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Propagate want categories: if a year has all-zero cats, fill from previous year * 1.04
  const sorted = [...parsed.data.rows].sort((a, b) => a.year - b.year);
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1]!;
    const curHasCats = cur.wantShopping + cur.wantTravel + cur.wantSupport + cur.wantPersonal + cur.wantOther > 0;
    const prevHasCats = prev.wantShopping + prev.wantTravel + prev.wantSupport + prev.wantPersonal + prev.wantOther > 0;
    if (!curHasCats && prevHasCats) {
      const f = Math.pow(1.04, cur.year - prev.year);
      cur.wantShopping = prev.wantShopping * f;
      cur.wantTravel   = prev.wantTravel   * f;
      cur.wantSupport  = prev.wantSupport  * f;
      cur.wantPersonal = prev.wantPersonal * f;
      cur.wantOther    = prev.wantOther    * f;
      cur.wantBudget   = cur.wantShopping + cur.wantTravel + cur.wantSupport + cur.wantPersonal + cur.wantOther;
    }
  }

  await db.delete(expenseForecastTable);
  const rows = await db
    .insert(expenseForecastTable)
    .values(sorted.map((row) => ({
      year: row.year,
      income: String(row.income),
      otherIncome: String(row.otherIncome),
      investmentRatio: String(row.investmentRatio),
      needLiving: String(row.needLiving),
      needTuition: String(row.needTuition),
      needAllowance: String(row.needAllowance),
      needMaintenance: String(row.needMaintenance),
      wantBudget: String(row.wantBudget),
      wantShopping: String(row.wantShopping),
      wantTravel: String(row.wantTravel),
      wantSupport: String(row.wantSupport),
      wantPersonal: String(row.wantPersonal),
      wantOther: String(row.wantOther),
      actualNeed: row.actualNeed != null ? String(row.actualNeed) : null,
      actualWant: row.actualWant != null ? String(row.actualWant) : null,
      note: row.note ?? null,
    })))
    .returning();

  res.json(rows.map(serialize));
});

export default router;
