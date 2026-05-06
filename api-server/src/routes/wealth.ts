import { Router } from "express";
import { z } from "zod/v4";
import { eq, desc, inArray } from "drizzle-orm";
import { db, wealthSnapshotsTable, wealthSnapshotItemsTable } from "../../../lib/db/src/index.ts";

const router = Router();

function toSnapshot(row: typeof wealthSnapshotsTable.$inferSelect, items: typeof wealthSnapshotItemsTable.$inferSelect[]) {
  return {
    id: row.id,
    totalAsset: parseFloat(String(row.totalAsset)),
    debt: parseFloat(String(row.debt)),
    netAsset: parseFloat(String(row.netAsset)),
    note: row.note,
    snapshotAt: row.snapshotAt,
    createdAt: row.createdAt,
    items: items.map((i) => ({
      id: i.id,
      type: i.type,
      label: i.label,
      value: parseFloat(String(i.value)),
    })),
  };
}

// GET /api/wealth/snapshots — list latest 24, newest first
router.get("/wealth/snapshots", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(wealthSnapshotsTable)
    .orderBy(desc(wealthSnapshotsTable.snapshotAt))
    .limit(24);

  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db
        .select()
        .from(wealthSnapshotItemsTable)
        .where(inArray(wealthSnapshotItemsTable.snapshotId, ids))
    : [];

  const itemsBySnapshot = new Map<number, typeof items>();
  for (const item of items) {
    const list = itemsBySnapshot.get(item.snapshotId) ?? [];
    list.push(item);
    itemsBySnapshot.set(item.snapshotId, list);
  }

  res.json(rows.map((row) => toSnapshot(row, itemsBySnapshot.get(row.id) ?? [])));
});

// GET /api/wealth/snapshots/latest
router.get("/wealth/snapshots/latest", async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(wealthSnapshotsTable)
    .orderBy(desc(wealthSnapshotsTable.snapshotAt))
    .limit(1);

  if (!row) { res.json(null); return; }

  const items = await db
    .select()
    .from(wealthSnapshotItemsTable)
    .where(eq(wealthSnapshotItemsTable.snapshotId, row.id));

  res.json(toSnapshot(row, items));
});

const SaveSnapshotBody = z.object({
  totalAsset: z.number().nonnegative(),
  debt: z.number().nonnegative().default(0),
  netAsset: z.number(),
  note: z.string().trim().max(500).optional().nullable(),
  snapshotAt: z.coerce.date().optional(),
  items: z.array(z.object({
    type: z.string().trim().min(1),
    label: z.string().trim().optional().nullable(),
    value: z.number().nonnegative(),
  })).default([]),
});

// POST /api/wealth/snapshots
router.post("/wealth/snapshots", async (req, res): Promise<void> => {
  const parsed = SaveSnapshotBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { totalAsset, debt, netAsset, note, snapshotAt, items } = parsed.data;

  const [snapshot] = await db
    .insert(wealthSnapshotsTable)
    .values({
      totalAsset: String(totalAsset),
      debt: String(debt),
      netAsset: String(netAsset),
      note: note ?? null,
      snapshotAt: snapshotAt ?? new Date(),
    })
    .returning();

  // Group by type to avoid unique constraint violation
  const grouped = new Map<string, { label: string | null; value: number }>();
  for (const item of items) {
    const existing = grouped.get(item.type);
    if (existing) {
      existing.value += item.value;
    } else {
      grouped.set(item.type, { label: item.label ?? null, value: item.value });
    }
  }
  const groupedItems = Array.from(grouped.entries()).map(([type, { label, value }]) => ({ type, label, value }));

  const savedItems = groupedItems.length
    ? await db
        .insert(wealthSnapshotItemsTable)
        .values(groupedItems.map((item) => ({
          snapshotId: snapshot!.id,
          type: item.type,
          label: item.label,
          value: String(item.value),
        })))
        .returning()
    : [];

  res.status(201).json(toSnapshot(snapshot!, savedItems));
});

// DELETE /api/wealth/snapshots/:id
router.delete("/wealth/snapshots/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [deleted] = await db
    .delete(wealthSnapshotsTable)
    .where(eq(wealthSnapshotsTable.id, id))
    .returning();

  if (!deleted) { res.status(404).json({ error: "Snapshot not found" }); return; }
  res.json({ success: true });
});

export default router;
