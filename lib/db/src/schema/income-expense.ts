import { integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const incomeExpenseTable = pgTable(
  "income_expense",
  {
    id: serial("id").primaryKey(),
    year: integer("year").notNull(),
    income: numeric("income", { precision: 22, scale: 2 }).notNull().default("0"),
    otherIncome: numeric("other_income", { precision: 22, scale: 2 }).notNull().default("0"),
    expense: numeric("expense", { precision: 22, scale: 2 }).notNull().default("0"),
    otherExpense: numeric("other_expense", { precision: 22, scale: 2 }).notNull().default("0"),
    totalInterest: numeric("total_interest", { precision: 22, scale: 2 }).notNull().default("0"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    uniqueYear: uniqueIndex("income_expense_year_idx").on(t.year),
  }),
);

export type IncomeExpense = typeof incomeExpenseTable.$inferSelect;
