import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, eq, inArray } from "drizzle-orm";
import { db, incomeForecastTable, incomeProjectCalcTable, incomeSourcesTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

// ── Sources ───────────────────────────────────────────────────────────────────

router.get("/income-sources", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(incomeSourcesTable)
    .orderBy(asc(incomeSourcesTable.sortOrder), asc(incomeSourcesTable.id));
  res.json(rows);
});

const SourceInput = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().trim().max(50).default("other"),
  color: z.string().trim().max(30).default("#6366f1"),
  note: z.string().trim().max(500).nullable().optional(),
});

router.post("/income-sources", async (req, res): Promise<void> => {
  const parsed = SourceInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const maxOrder = await db
    .select({ sortOrder: incomeSourcesTable.sortOrder })
    .from(incomeSourcesTable)
    .orderBy(asc(incomeSourcesTable.sortOrder));
  const nextOrder = maxOrder.length > 0 ? (maxOrder[maxOrder.length - 1]?.sortOrder ?? 0) + 1 : 0;

  const [row] = await db
    .insert(incomeSourcesTable)
    .values({ ...parsed.data, sortOrder: nextOrder })
    .returning();
  res.json(row);
});

const SourcePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: z.string().trim().max(50).optional(),
  color: z.string().trim().max(30).optional(),
  sortOrder: z.number().int().optional(),
  forecastMode: z.enum(["manual", "growth"]).optional(),
  forecastBase: z.number().nonnegative().nullable().optional(),
  forecastRate: z.number().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

router.patch("/income-sources/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id." }); return; }

  const parsed = SourcePatch.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { forecastBase, forecastRate, ...rest } = parsed.data;
  const [row] = await db
    .update(incomeSourcesTable)
    .set({
      ...rest,
      ...(forecastBase !== undefined ? { forecastBase: forecastBase != null ? String(forecastBase) : null } : {}),
      ...(forecastRate !== undefined ? { forecastRate: forecastRate != null ? String(forecastRate) : null } : {}),
    })
    .where(eq(incomeSourcesTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Source not found." }); return; }
  res.json(row);
});

router.delete("/income-sources/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id." }); return; }

  // cascade deletes forecast rows via FK, but we do it explicitly for safety
  await db.delete(incomeForecastTable).where(eq(incomeForecastTable.sourceId, id));
  await db.delete(incomeSourcesTable).where(eq(incomeSourcesTable.id, id));
  res.json({ ok: true });
});

// ── Forecast entries ──────────────────────────────────────────────────────────

router.get("/income-forecast", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(incomeForecastTable)
    .orderBy(asc(incomeForecastTable.sourceId), asc(incomeForecastTable.year));
  res.json(rows);
});

const EntryInput = z.object({
  sourceId: z.number().int().positive(),
  year: z.number().int().min(2020).max(2100),
  amount: z.number().nonnegative(),
  note: z.string().trim().max(200).nullable().optional(),
});

const PutBody = z.object({
  entries: z.array(EntryInput),
});

router.put("/income-forecast", async (req, res): Promise<void> => {
  const parsed = PutBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  await db.delete(incomeForecastTable);

  if (parsed.data.entries.length === 0) { res.json([]); return; }

  const rows = await db
    .insert(incomeForecastTable)
    .values(
      parsed.data.entries.map((e) => ({
        sourceId: e.sourceId,
        year: e.year,
        amount: String(e.amount),
        note: e.note ?? null,
      })),
    )
    .returning();

  res.json(rows);
});

// ── Project calculator ────────────────────────────────────────────────────────

router.get("/income-project-calc", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(incomeProjectCalcTable)
    .orderBy(asc(incomeProjectCalcTable.sourceId), asc(incomeProjectCalcTable.rowId), asc(incomeProjectCalcTable.year));
  res.json(rows);
});

router.get("/income-project-calc/:sourceId", async (req, res): Promise<void> => {
  const sourceId = Number(req.params.sourceId);
  if (!Number.isInteger(sourceId)) { res.status(400).json({ error: "Invalid sourceId." }); return; }

  const rows = await db
    .select()
    .from(incomeProjectCalcTable)
    .where(eq(incomeProjectCalcTable.sourceId, sourceId))
    .orderBy(asc(incomeProjectCalcTable.rowId), asc(incomeProjectCalcTable.year));
  res.json(rows);
});

const CalcEntryInput = z.object({
  rowId: z.string().trim().min(1).max(50),
  year: z.number().int().min(-1).max(2100), // -1 for meta rows (_calc_type)
  value: z.number().finite(),
});

router.put("/income-project-calc/:sourceId", async (req, res): Promise<void> => {
  const sourceId = Number(req.params.sourceId);
  if (!Number.isInteger(sourceId)) { res.status(400).json({ error: "Invalid sourceId." }); return; }

  const parsed = z.object({ entries: z.array(CalcEntryInput) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  await db.delete(incomeProjectCalcTable).where(eq(incomeProjectCalcTable.sourceId, sourceId));

  if (parsed.data.entries.length === 0) { res.json([]); return; }

  const rows = await db
    .insert(incomeProjectCalcTable)
    .values(parsed.data.entries.map((e) => ({
      sourceId,
      rowId: e.rowId,
      year: e.year,
      value: String(e.value),
    })))
    .returning();

  res.json(rows);
});

export default router;
