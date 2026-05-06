import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, desc, eq } from "drizzle-orm";
import { baseAssetsTable, baseAssetValueHistoryTable, db } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

function serializeBaseAsset(row: typeof baseAssetsTable.$inferSelect) {
  return {
    id: row.id,
    assetType: row.assetType,
    symbol: row.symbol,
    baseYear: row.baseYear,
    baseValue: parseFloat(String(row.baseValue)),
    assumedReturnRate: parseFloat(String(row.assumedReturnRate ?? 0)),
    note: row.note,
    displayName: row.displayName ?? null,
    displayType: row.displayType ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const BaseAssetInput = z.object({
  assetType: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  baseYear: z.number().int().min(1900).max(2100).default(2026),
  baseValue: z.number().positive(),
  assumedReturnRate: z.number().min(-1).optional().default(0),
  note: z.string().trim().max(500).optional().nullable(),
});

const ImportBody = z.object({
  replace: z.boolean().optional().default(false),
  assets: z.array(BaseAssetInput).min(1),
});

const UpdateBody = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  displayType: z.string().trim().max(100).nullable().optional(),
  baseValue: z.number().positive().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  changeNote: z.string().trim().max(500).optional(),
});

router.get("/base-assets", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(baseAssetsTable)
    .orderBy(asc(baseAssetsTable.baseYear), asc(baseAssetsTable.assetType), asc(baseAssetsTable.symbol));

  res.json(rows.map(serializeBaseAsset));
});

router.put("/base-assets/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id." }); return; }

  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(baseAssetsTable).where(eq(baseAssetsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Asset not found." }); return; }

  const { displayName, displayType, baseValue, note, changeNote } = parsed.data;

  // Log history when baseValue changes
  if (baseValue !== undefined && baseValue !== parseFloat(String(existing.baseValue))) {
    await db.insert(baseAssetValueHistoryTable).values({
      assetId: id,
      field: "base_value",
      oldValue: String(existing.baseValue),
      newValue: String(baseValue),
      note: changeNote ?? null,
    });
  }

  const updatePayload: Partial<typeof baseAssetsTable.$inferInsert> = {};
  if (displayName !== undefined) updatePayload.displayName = displayName;
  if (displayType !== undefined) updatePayload.displayType = displayType;
  if (baseValue !== undefined) updatePayload.baseValue = String(baseValue);
  if (note !== undefined) updatePayload.note = note;

  const [updated] = await db
    .update(baseAssetsTable)
    .set(updatePayload)
    .where(eq(baseAssetsTable.id, id))
    .returning();

  res.json(serializeBaseAsset(updated!));
});

router.get("/base-assets/:id/history", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id." }); return; }

  const rows = await db
    .select()
    .from(baseAssetValueHistoryTable)
    .where(eq(baseAssetValueHistoryTable.assetId, id))
    .orderBy(desc(baseAssetValueHistoryTable.changedAt));

  res.json(rows.map((r) => ({
    id: r.id,
    field: r.field,
    oldValue: parseFloat(String(r.oldValue)),
    newValue: parseFloat(String(r.newValue)),
    note: r.note,
    changedAt: r.changedAt,
  })));
});

router.post("/base-assets/import", async (req, res): Promise<void> => {
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.replace) {
    await db.delete(baseAssetsTable).where(eq(baseAssetsTable.baseYear, 2026));
  } else {
    const existing = await db.select({ id: baseAssetsTable.id }).from(baseAssetsTable).limit(1);
    if (existing.length > 0) {
      const rows = await db
        .select()
        .from(baseAssetsTable)
        .orderBy(asc(baseAssetsTable.baseYear), asc(baseAssetsTable.assetType), asc(baseAssetsTable.symbol));
      res.json(rows.map(serializeBaseAsset));
      return;
    }
  }

  const rows = await db
    .insert(baseAssetsTable)
    .values(parsed.data.assets.map((asset) => ({
      assetType: asset.assetType,
      symbol: asset.symbol,
      baseYear: asset.baseYear,
      baseValue: String(asset.baseValue),
      assumedReturnRate: String(asset.assumedReturnRate ?? 0),
      note: asset.note ?? null,
    })))
    .returning();

  res.status(201).json(rows.map(serializeBaseAsset));
});

export default router;
