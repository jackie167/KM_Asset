import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const priceHistoryTable = pgTable("price_history", {
  id: serial("id").primaryKey(),
  priceAt: timestamp("date", { withTimezone: true }).notNull().defaultNow(),
  assetCode: text("asset_code").notNull(),
  assetType: text("asset_type").notNull(),
  priceOrValue: numeric("price_or_value", { precision: 22, scale: 2 }).notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }),
  currentValue: numeric("current_value", { precision: 22, scale: 2 }),
  source: text("source").notNull().default("manual"),
  note: text("note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPriceHistorySchema = createInsertSchema(priceHistoryTable).omit({ id: true });
export type InsertPriceHistory = z.infer<typeof insertPriceHistorySchema>;
export type PriceHistory = typeof priceHistoryTable.$inferSelect;
