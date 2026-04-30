import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db, appSettingsTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

router.get("/settings/:key", async (req, res): Promise<void> => {
  const { key } = req.params;
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  if (!row) { res.status(404).json({ error: "Not found." }); return; }
  res.json({ key: row.key, value: row.value, updatedAt: row.updatedAt });
});

router.put("/settings/:key", async (req, res): Promise<void> => {
  const { key } = req.params;
  const parsed = z.object({ value: z.string() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [row] = await db
    .insert(appSettingsTable)
    .values({ key, value: parsed.data.value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: parsed.data.value } })
    .returning();

  res.json({ key: row!.key, value: row!.value, updatedAt: row!.updatedAt });
});

export default router;
