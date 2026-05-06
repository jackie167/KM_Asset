import { integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const baseAssetsTable = pgTable("base_assets", {
  id: serial("id").primaryKey(),
  assetType: text("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  baseYear: integer("base_year").notNull().default(2026),
  baseValue: numeric("base_value", { precision: 22, scale: 2 }).notNull(),
  assumedReturnRate: numeric("assumed_return_rate", { precision: 10, scale: 6 }).notNull().default("0"),
  note: text("note"),
  // UI-only display overrides — join keys (asset_type, symbol) are never changed
  displayName: text("display_name"),
  displayType: text("display_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type BaseAsset = typeof baseAssetsTable.$inferSelect;

export const baseAssetValueHistoryTable = pgTable("base_asset_value_history", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull(),
  field: text("field").notNull(),
  oldValue: numeric("old_value", { precision: 22, scale: 2 }).notNull(),
  newValue: numeric("new_value", { precision: 22, scale: 2 }).notNull(),
  note: text("note"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BaseAssetValueHistory = typeof baseAssetValueHistoryTable.$inferSelect;
