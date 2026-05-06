import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  side: text("side").notNull(),
  origin: text("origin").notNull().default("manual"),
  fundingSource: text("funding_source").notNull(),
  assetType: text("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  totalValue: numeric("total_value", { precision: 18, scale: 2 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 18, scale: 2 }),
  grossAmount: numeric("gross_amount", { precision: 18, scale: 2 }),
  fee: numeric("fee", { precision: 18, scale: 2 }),
  tax: numeric("tax", { precision: 18, scale: 2 }),
  netAmount: numeric("net_amount", { precision: 18, scale: 2 }),
  realizedInterest: numeric("realized_interest", { precision: 18, scale: 2 }),
  note: text("note"),
  status: text("status").notNull().default("recorded"),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Transaction = typeof transactionsTable.$inferSelect;
