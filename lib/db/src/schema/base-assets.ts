import { integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const baseAssetsTable = pgTable("base_assets", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  baseYear: integer("base_year").notNull().default(2026),
  baseValue: numeric("base_value", { precision: 22, scale: 2 }).notNull(),
  assumedReturnRate: numeric("assumed_return_rate", { precision: 10, scale: 6 }).notNull().default("0"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type BaseAsset = typeof baseAssetsTable.$inferSelect;
