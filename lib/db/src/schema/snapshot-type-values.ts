import { pgTable, serial, integer, numeric, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { snapshotsTable } from "./snapshots";

export const snapshotTypeValuesTable = pgTable(
  "snapshot_type_values",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => snapshotsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: numeric("value", { precision: 22, scale: 2 }).notNull(),
  },
  (table) => ({
    snapshotTypeValueUnique: uniqueIndex("snapshot_type_values_snapshot_id_type_idx").on(table.snapshotId, table.type),
  }),
);

export const insertSnapshotTypeValueSchema = createInsertSchema(snapshotTypeValuesTable).omit({ id: true });
export type InsertSnapshotTypeValue = z.infer<typeof insertSnapshotTypeValueSchema>;
export type SnapshotTypeValue = typeof snapshotTypeValuesTable.$inferSelect;
