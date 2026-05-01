import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const holdingsTable = pgTable("holdings", {
  id: serial("id").primaryKey(),
  investmentGroup: text("investment_group").notNull().default("financial"),
  type: text("type").notNull(),
  symbol: text("symbol").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  manualPrice: numeric("manual_price", { precision: 18, scale: 2 }),
  costOfCapital: numeric("cost_of_capital", { precision: 18, scale: 2 }),
  interest: numeric("interest", { precision: 18, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertHoldingSchema = createInsertSchema(holdingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHolding = z.infer<typeof insertHoldingSchema>;
export type Holding = typeof holdingsTable.$inferSelect;
