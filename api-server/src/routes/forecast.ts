import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { desc, eq } from "drizzle-orm";
import { db, forecastTradesTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

function serializeForecastTrade(row: typeof forecastTradesTable.$inferSelect) {
  return {
    id: row.id,
    side: row.side,
    year: row.year,
    assetType: row.assetType,
    symbol: row.symbol,
    amount: parseFloat(String(row.amount)),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ForecastTradeBody = z.object({
  side: z.enum(["buy", "sell"]),
  year: z.number().int().min(2026).max(2044),
  assetType: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  amount: z.number().positive(),
  note: z.string().trim().max(500).optional().nullable(),
});

router.get("/asset-forecast/trades", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(forecastTradesTable)
    .orderBy(desc(forecastTradesTable.year), desc(forecastTradesTable.createdAt));

  res.json(rows.map(serializeForecastTrade));
});

router.post("/asset-forecast/trades", async (req, res): Promise<void> => {
  const parsed = ForecastTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [row] = await db
    .insert(forecastTradesTable)
    .values({
      side: parsed.data.side,
      year: parsed.data.year,
      assetType: parsed.data.assetType,
      symbol: parsed.data.symbol,
      amount: String(parsed.data.amount),
      note: parsed.data.note ?? null,
    })
    .returning();

  res.status(201).json(serializeForecastTrade(row!));
});

router.delete("/asset-forecast/trades/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid trade id." });
    return;
  }

  const [deleted] = await db
    .delete(forecastTradesTable)
    .where(eq(forecastTradesTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Forecast trade not found." });
    return;
  }

  res.json({ ok: true });
});

export default router;
