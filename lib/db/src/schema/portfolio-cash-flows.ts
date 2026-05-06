import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";

export const portfolioCashFlowsTable = pgTable("portfolio_cash_flows", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("contribution"),
  account: text("account").notNull().default("CASH"),
  origin: text("origin").notNull().default("manual"),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  note: text("note"),
  source: text("source").notNull().default("manual"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PortfolioCashFlow = typeof portfolioCashFlowsTable.$inferSelect;
