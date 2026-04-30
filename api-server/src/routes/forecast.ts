import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, desc, eq } from "drizzle-orm";
import { db, forecastLoanEventsTable, forecastLoansTable, forecastTradesTable } from "../../../lib/db/src/index.ts";

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

function serializeForecastLoan(row: typeof forecastLoansTable.$inferSelect) {
  return {
    id: row.id,
    assetType: row.assetType,
    assetSymbol: row.assetSymbol,
    loanName: row.loanName,
    principalStart: parseFloat(String(row.principalStart)),
    interestRate: parseFloat(String(row.interestRate)),
    startYear: row.startYear,
    endYear: row.endYear,
    repaymentType: row.repaymentType,
    annualPrincipalPayment: parseFloat(String(row.annualPrincipalPayment)),
    annualInterestPayment: parseFloat(String(row.annualInterestPayment)),
    settleOnAssetSell: row.settleOnAssetSell,
    status: row.status,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeForecastLoanEvent(row: typeof forecastLoanEventsTable.$inferSelect) {
  return {
    id: row.id,
    loanId: row.loanId,
    year: row.year,
    eventType: row.eventType,
    amount: parseFloat(String(row.amount)),
    source: row.source,
    tradeId: row.tradeId,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ForecastTradeBody = z.object({
  side: z.literal("sell"),
  year: z.number().int().min(2026).max(2044),
  assetType: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  amount: z.number().positive(),
  note: z.string().trim().max(500).optional().nullable(),
});

const ForecastLoanUpdateBody = z.object({
  assetType: z.string().trim().min(1).optional(),
  assetSymbol: z.string().trim().min(1).optional(),
  loanName: z.string().trim().min(1).optional(),
  principalStart: z.number().nonnegative().optional(),
  interestRate: z.number().min(0).optional(),
  startYear: z.number().int().min(2020).max(2044).optional(),
  endYear: z.number().int().min(2020).max(2100).nullable().optional(),
  repaymentType: z.enum(["interest_only", "principal_interest", "bullet", "custom"]).optional(),
  annualPrincipalPayment: z.number().nonnegative().optional(),
  annualInterestPayment: z.number().nonnegative().optional(),
  settleOnAssetSell: z.boolean().optional(),
  status: z.enum(["active", "settled"]).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const ForecastLoanEventBody = z.object({
  loanId: z.number().int().positive(),
  year: z.number().int().min(2026).max(2044),
  eventType: z.enum(["drawdown", "interest", "principal_payment", "settlement"]),
  amount: z.number().nonnegative(),
  source: z.string().trim().min(1).default("manual"),
  tradeId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const FINANCIAL_ASSET_KEYS = new Set(["cash", "stock", "gold", "fund", "crypto"]);

function isFinancialForecastAsset(assetType: string, symbol: string) {
  return FINANCIAL_ASSET_KEYS.has(assetType.trim().toLowerCase()) ||
    FINANCIAL_ASSET_KEYS.has(symbol.trim().toLowerCase());
}

function validateFixedAssetTrade(input: z.infer<typeof ForecastTradeBody>) {
  if (isFinancialForecastAsset(input.assetType, input.symbol)) {
    return "Forecast trade chỉ cho phép bán fixed asset, không bán financial asset.";
  }
  return null;
}

router.get("/asset-forecast/trades", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(forecastTradesTable)
    .orderBy(desc(forecastTradesTable.year), desc(forecastTradesTable.createdAt));

  res.json(rows.map(serializeForecastTrade));
});

router.get("/asset-forecast/loans", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(forecastLoansTable)
    .orderBy(asc(forecastLoansTable.startYear), asc(forecastLoansTable.assetSymbol));

  res.json(rows.map(serializeForecastLoan));
});

router.put("/asset-forecast/loans/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid loan id." });
    return;
  }

  const parsed = ForecastLoanUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const values: Partial<typeof forecastLoansTable.$inferInsert> = {};
  if (parsed.data.assetType !== undefined) values.assetType = parsed.data.assetType;
  if (parsed.data.assetSymbol !== undefined) values.assetSymbol = parsed.data.assetSymbol;
  if (parsed.data.loanName !== undefined) values.loanName = parsed.data.loanName;
  if (parsed.data.principalStart !== undefined) values.principalStart = String(parsed.data.principalStart);
  if (parsed.data.interestRate !== undefined) values.interestRate = String(parsed.data.interestRate);
  if (parsed.data.startYear !== undefined) values.startYear = parsed.data.startYear;
  if (parsed.data.endYear !== undefined) values.endYear = parsed.data.endYear;
  if (parsed.data.repaymentType !== undefined) values.repaymentType = parsed.data.repaymentType;
  if (parsed.data.annualPrincipalPayment !== undefined) values.annualPrincipalPayment = String(parsed.data.annualPrincipalPayment);
  if (parsed.data.annualInterestPayment !== undefined) values.annualInterestPayment = String(parsed.data.annualInterestPayment);
  if (parsed.data.settleOnAssetSell !== undefined) values.settleOnAssetSell = parsed.data.settleOnAssetSell;
  if (parsed.data.status !== undefined) values.status = parsed.data.status;
  if (parsed.data.note !== undefined) values.note = parsed.data.note;

  const [row] = await db
    .update(forecastLoansTable)
    .set(values)
    .where(eq(forecastLoansTable.id, id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Forecast loan not found." });
    return;
  }

  res.json(serializeForecastLoan(row));
});

router.get("/asset-forecast/loan-events", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(forecastLoanEventsTable)
    .orderBy(asc(forecastLoanEventsTable.year), asc(forecastLoanEventsTable.loanId));

  res.json(rows.map(serializeForecastLoanEvent));
});

router.post("/asset-forecast/loan-events", async (req, res): Promise<void> => {
  const parsed = ForecastLoanEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [row] = await db
    .insert(forecastLoanEventsTable)
    .values({
      loanId: parsed.data.loanId,
      year: parsed.data.year,
      eventType: parsed.data.eventType,
      amount: String(parsed.data.amount),
      source: parsed.data.source,
      tradeId: parsed.data.tradeId ?? null,
      note: parsed.data.note ?? null,
    })
    .returning();

  res.status(201).json(serializeForecastLoanEvent(row!));
});

router.put("/asset-forecast/loan-events/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid loan event id." });
    return;
  }

  const parsed = ForecastLoanEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [row] = await db
    .update(forecastLoanEventsTable)
    .set({
      loanId: parsed.data.loanId,
      year: parsed.data.year,
      eventType: parsed.data.eventType,
      amount: String(parsed.data.amount),
      source: parsed.data.source,
      tradeId: parsed.data.tradeId ?? null,
      note: parsed.data.note ?? null,
    })
    .where(eq(forecastLoanEventsTable.id, id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Forecast loan event not found." });
    return;
  }

  res.json(serializeForecastLoanEvent(row));
});

router.delete("/asset-forecast/loan-events/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid loan event id." });
    return;
  }

  const [deleted] = await db
    .delete(forecastLoanEventsTable)
    .where(eq(forecastLoanEventsTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Forecast loan event not found." });
    return;
  }

  res.json({ ok: true });
});

router.post("/asset-forecast/trades", async (req, res): Promise<void> => {
  const parsed = ForecastTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const businessError = validateFixedAssetTrade(parsed.data);
  if (businessError) {
    res.status(400).json({ error: businessError });
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

router.put("/asset-forecast/trades/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid trade id." }); return; }

  const parsed = ForecastTradeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const businessError = validateFixedAssetTrade(parsed.data);
  if (businessError) { res.status(400).json({ error: businessError }); return; }

  const [row] = await db
    .update(forecastTradesTable)
    .set({
      side: parsed.data.side,
      year: parsed.data.year,
      assetType: parsed.data.assetType,
      symbol: parsed.data.symbol,
      amount: String(parsed.data.amount),
      note: parsed.data.note ?? null,
    })
    .where(eq(forecastTradesTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Forecast trade not found." }); return; }
  res.json(serializeForecastTrade(row));
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
