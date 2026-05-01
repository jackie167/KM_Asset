import { boolean, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const forecastTradesTable = pgTable("forecast_trades", {
  id: serial("id").primaryKey(),
  side: text("side").notNull(),
  year: integer("year").notNull(),
  assetType: text("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  loanRatio: numeric("loan_ratio", { precision: 10, scale: 6 }).notNull().default("0"),
  loanInterestRate: numeric("loan_interest_rate", { precision: 10, scale: 6 }).notNull().default("0"),
  loanAnnualPrincipalPayment: numeric("loan_annual_principal_payment", { precision: 18, scale: 2 }).notNull().default("0"),
  loanAnnualInterestPayment: numeric("loan_annual_interest_payment", { precision: 18, scale: 2 }).notNull().default("0"),
  loanRepaymentType: text("loan_repayment_type").notNull().default("interest_only"),
  settleLoanOnSell: boolean("settle_loan_on_sell").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ForecastTrade = typeof forecastTradesTable.$inferSelect;
