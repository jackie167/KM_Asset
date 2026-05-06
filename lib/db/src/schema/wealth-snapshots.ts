import { pgTable, serial, integer, numeric, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const wealthSnapshotsTable = pgTable("wealth_snapshots", {
  id: serial("id").primaryKey(),
  totalAsset: numeric("total_asset", { precision: 22, scale: 2 }).notNull(),
  debt: numeric("debt", { precision: 22, scale: 2 }).notNull().default("0"),
  netAsset: numeric("net_asset", { precision: 22, scale: 2 }).notNull(),
  note: text("note"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wealthSnapshotItemsTable = pgTable(
  "wealth_snapshot_items",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => wealthSnapshotsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    label: text("label"),
    value: numeric("value", { precision: 22, scale: 2 }).notNull(),
  },
  (t) => ({
    uniqueTypePerSnapshot: uniqueIndex("wealth_snapshot_items_snapshot_id_type_idx").on(
      t.snapshotId,
      t.type
    ),
  })
);

export type WealthSnapshot = typeof wealthSnapshotsTable.$inferSelect;
export type WealthSnapshotItem = typeof wealthSnapshotItemsTable.$inferSelect;
