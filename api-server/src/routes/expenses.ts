import { Router } from "express";
import { z } from "zod";
import { db, expensesTable } from "@workspace/db";
import { eq, desc, and, gte, lt, sql } from "drizzle-orm";

const router = Router();

export const EXPENSE_CATEGORIES = [
  "shopping",
  "travel",
  "support",
  "personal",
  "other",
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  shopping: "Shopping",
  travel:   "Travel",
  support:  "Support",
  personal: "Personal",
  other:    "Other",
};

const CreateExpenseBody = z.object({
  amount: z.coerce.number().positive(),
  category: z.enum(EXPENSE_CATEGORIES),
  note: z.string().trim().max(500).optional().nullable(),
  occurredAt: z.coerce.date().optional(),
});

const UpdateExpenseBody = z.object({
  amount: z.coerce.number().positive().optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  note: z.string().trim().max(500).optional().nullable(),
  occurredAt: z.coerce.date().optional(),
});

function toRow(row: typeof expensesTable.$inferSelect) {
  return {
    id: row.id,
    amount: parseFloat(String(row.amount)),
    category: row.category,
    note: row.note,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseYearRange(raw: unknown): { start: Date; end: Date; label: string } | null {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), label: s };
}

// GET /api/expenses?year=YYYY
router.get("/expenses", async (req, res): Promise<void> => {
  const range = parseYearRange(req.query.year ?? new Date().getFullYear());
  const conditions = range
    ? [gte(expensesTable.occurredAt, range.start), lt(expensesTable.occurredAt, range.end)]
    : [];

  const rows = await db
    .select()
    .from(expensesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(expensesTable.occurredAt));

  res.json(rows.map(toRow));
});

// GET /api/expenses/summary?year=YYYY
router.get("/expenses/summary", async (req, res): Promise<void> => {
  const yearStr = String(req.query.year ?? new Date().getFullYear()).trim();
  const range = parseYearRange(yearStr);
  if (!range) {
    res.status(400).json({ error: "Invalid year format. Use YYYY." });
    return;
  }

  const rows = await db
    .select()
    .from(expensesTable)
    .where(and(gte(expensesTable.occurredAt, range.start), lt(expensesTable.occurredAt, range.end)));

  const totalSpent = rows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);

  const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((cat) => [cat, 0])) as Record<string, number>;
  for (const row of rows) {
    const cat = row.category as string;
    if (cat in byCategory) byCategory[cat] += parseFloat(String(row.amount));
  }

  res.json({
    year: yearStr,
    totalSpent,
    byCategory: Object.entries(byCategory).map(([category, amount]) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      amount,
      count: rows.filter((r) => r.category === category).length,
    })),
  });
});

// POST /api/expenses
router.post("/expenses", async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(expensesTable)
    .values({
      amount: String(parsed.data.amount),
      category: parsed.data.category,
      note: parsed.data.note ?? null,
      occurredAt: parsed.data.occurredAt ?? new Date(),
    })
    .returning();

  res.status(201).json(toRow(created!));
});

// PUT /api/expenses/:id
router.put("/expenses/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const update: Partial<typeof expensesTable.$inferInsert> = {};
  if (parsed.data.amount != null) update.amount = String(parsed.data.amount);
  if (parsed.data.category != null) update.category = parsed.data.category;
  if ("note" in parsed.data) update.note = parsed.data.note ?? null;
  if (parsed.data.occurredAt != null) update.occurredAt = parsed.data.occurredAt;

  const [updated] = await db
    .update(expensesTable)
    .set(update)
    .where(eq(expensesTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json(toRow(updated));
});

// DELETE /api/expenses/:id
router.delete("/expenses/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [deleted] = await db
    .delete(expensesTable)
    .where(eq(expensesTable.id, id))
    .returning();

  if (!deleted) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json({ success: true });
});

export default router;
