import { integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const expenseForecastTable = pgTable(
  "expense_forecast",
  {
    id: serial("id").primaryKey(),
    year: integer("year").notNull(),
    income: numeric("income", { precision: 22, scale: 2 }).notNull().default("0"),
    otherIncome: numeric("other_income", { precision: 22, scale: 2 }).notNull().default("0"),
    investmentRatio: numeric("investment_ratio", { precision: 10, scale: 6 }).notNull().default("30"),
    needLiving: numeric("need_living", { precision: 22, scale: 2 }).notNull().default("0"),
    needTuition: numeric("need_tuition", { precision: 22, scale: 2 }).notNull().default("0"),
    needAllowance: numeric("need_allowance", { precision: 22, scale: 2 }).notNull().default("0"),
    needMaintenance: numeric("need_maintenance", { precision: 22, scale: 2 }).notNull().default("0"),
    wantBudget: numeric("want_budget", { precision: 22, scale: 2 }).notNull().default("0"),
    wantShopping: numeric("want_shopping", { precision: 22, scale: 2 }).notNull().default("0"),
    wantTravel: numeric("want_travel", { precision: 22, scale: 2 }).notNull().default("0"),
    wantSupport: numeric("want_support", { precision: 22, scale: 2 }).notNull().default("0"),
    wantPersonal: numeric("want_personal", { precision: 22, scale: 2 }).notNull().default("0"),
    wantOther: numeric("want_other", { precision: 22, scale: 2 }).notNull().default("0"),
    actualNeed: numeric("actual_need", { precision: 22, scale: 2 }),
    actualWant: numeric("actual_want", { precision: 22, scale: 2 }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    uniqueYear: uniqueIndex("expense_forecast_year_idx").on(t.year),
  }),
);

export type ExpenseForecast = typeof expenseForecastTable.$inferSelect;
