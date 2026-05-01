import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, eq } from "drizzle-orm";
import { baseAssetsTable, db } from "../../../lib/db/src/index.ts";

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

router.get("/base-assets", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(baseAssetsTable)
    .orderBy(asc(baseAssetsTable.baseYear), asc(baseAssetsTable.assetType), asc(baseAssetsTable.symbol));

  res.json(rows.map(serializeBaseAsset));
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
