import { boolean, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const incomeSourcesTable = pgTable("income_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("other"),
  color: text("color").notNull().default("#6366f1"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const incomeForecastTable = pgTable(
  "income_forecast",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id").notNull().references(() => incomeSourcesTable.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    amount: numeric("amount", { precision: 22, scale: 2 }).notNull().default("0"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    uniqueSourceYear: uniqueIndex("income_forecast_source_year_idx").on(t.sourceId, t.year),
  }),
);

export const incomeProjectCalcTable = pgTable(
  "income_project_calc",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id").notNull().references(() => incomeSourcesTable.id, { onDelete: "cascade" }),
    rowId: text("row_id").notNull(),
    year: integer("year").notNull(),
    value: numeric("value", { precision: 22, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    uniqueSourceRowYear: uniqueIndex("income_project_calc_idx").on(t.sourceId, t.rowId, t.year),
  }),
);

export type IncomeSource = typeof incomeSourcesTable.$inferSelect;
export type IncomeForecastRow = typeof incomeForecastTable.$inferSelect;
export type IncomeProjectCalcRow = typeof incomeProjectCalcTable.$inferSelect;
