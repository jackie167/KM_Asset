import { boolean, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const forecastLoansTable = pgTable("forecast_loans", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  loanName: text("loan_name").notNull(),
  principalStart: numeric("principal_start", { precision: 18, scale: 2 }).notNull(),
  interestRate: numeric("interest_rate", { precision: 10, scale: 6 }).notNull().default("0"),
  startYear: integer("start_year").notNull(),
  endYear: integer("end_year"),
  repaymentType: text("repayment_type").notNull().default("interest_only"),
  annualPrincipalPayment: numeric("annual_principal_payment", { precision: 18, scale: 2 }).notNull().default("0"),
  annualInterestPayment: numeric("annual_interest_payment", { precision: 18, scale: 2 }).notNull().default("0"),
  settleOnAssetSell: boolean("settle_on_asset_sell").notNull().default(true),
  status: text("status").notNull().default("active"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const forecastLoanEventsTable = pgTable("forecast_loan_events", {
  id: serial("id").primaryKey(),
  loanId: integer("loan_id").notNull(),
  year: integer("year").notNull(),
  eventType: text("event_type").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  source: text("source").notNull().default("manual"),
  tradeId: integer("trade_id"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ForecastLoan = typeof forecastLoansTable.$inferSelect;
export type ForecastLoanEvent = typeof forecastLoanEventsTable.$inferSelect;
