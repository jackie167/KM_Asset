import { integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const forecastTradesTable = pgTable("forecast_trades", {
  id: serial("id").primaryKey(),
  side: text("side").notNull(),
  year: integer("year").notNull(),
  assetType: text("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ForecastTrade = typeof forecastTradesTable.$inferSelect;
