import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, holdingsTable, transactionsTable } from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

const CreateTransactionBody = z.object({
  side: z.enum(["buy", "sell"]),
  fundingSource: z.string().trim().min(1),
  assetType: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  quantity: z.coerce.number().positive().optional(),
  price: z.coerce.number().positive().optional(),
  grossAmount: z.coerce.number().positive().optional(),
  fee: z.coerce.number().nonnegative().optional(),
  tax: z.coerce.number().nonnegative().optional(),
  totalValue: z.coerce.number().positive().optional(),
  netAmount: z.coerce.number().positive().optional(),
  note: z.string().trim().optional().nullable(),
  executedAt: z.coerce.date().optional(),
}).refine((value) => value.totalValue != null || value.netAmount != null, {
  message: "totalValue or netAmount is required",
});
const UpdateTransactionParams = z.object({
  id: z.coerce.number().int().positive(),
});
const UpdateTransactionBody = CreateTransactionBody;

function serializeTransaction(transaction: typeof transactionsTable.$inferSelect) {
  const quantity = parseFloat(String(transaction.quantity));
  const netAmount = transaction.netAmount != null
    ? parseFloat(String(transaction.netAmount))
    : parseFloat(String(transaction.totalValue));
  const grossAmount = transaction.grossAmount != null ? parseFloat(String(transaction.grossAmount)) : netAmount;
  const fee = transaction.fee != null ? parseFloat(String(transaction.fee)) : 0;
  const tax = transaction.tax != null ? parseFloat(String(transaction.tax)) : 0;

  return {
    id: transaction.id,
    side: transaction.side,
    origin: transaction.origin,
    fundingSource: transaction.fundingSource,
    assetType: transaction.assetType,
    symbol: transaction.symbol,
    quantity,
    totalValue: netAmount,
    grossAmount,
    fee,
    tax,
    netAmount,
    unitPrice: transaction.unitPrice != null ? parseFloat(String(transaction.unitPrice)) : null,
    realizedInterest: transaction.realizedInterest != null ? parseFloat(String(transaction.realizedInterest)) : null,
    realizedPnl: transaction.realizedInterest != null ? parseFloat(String(transaction.realizedInterest)) : null,
    note: transaction.note,
    status: transaction.status,
    executedAt: transaction.executedAt,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function rejectImportedTransactionMutation(res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  res.status(409).json({
    error: "This transaction was imported from the Excel sheet. Update the sheet and sync again instead of editing or deleting it here.",
  });
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function usesManualPortfolioValue(assetType: string): boolean {
  const normalized = assetType.trim().toLowerCase();
  return normalized !== "stock" && normalized !== "gold" && normalized !== "crypto";
}

function deriveInvestmentGroup(assetType: string): string {
  const normalized = assetType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "real_estate" || normalized === "realestate" ? "real_estate" : "financial";
}

function normalizeTradeQuantity(input: { assetType: string; quantity?: number }): number {
  if (usesManualPortfolioValue(input.assetType)) {
    return 1;
  }
  return input.quantity ?? 0;
}

function resolveTradeAmounts(input: {
  side: "buy" | "sell";
  quantity: number;
  price?: number;
  grossAmount?: number;
  fee?: number;
  tax?: number;
  totalValue?: number;
  netAmount?: number;
}) {
  const fee = input.fee ?? 0;
  const tax = input.tax ?? 0;
  const grossAmount = input.grossAmount ?? (input.price != null ? input.price * input.quantity : null);
  const netAmount = input.netAmount
    ?? input.totalValue
    ?? (grossAmount != null
      ? input.side === "buy"
        ? grossAmount + fee + tax
        : Math.max(0, grossAmount - fee - tax)
      : 0);
  const resolvedGrossAmount = grossAmount ?? (input.side === "buy" ? Math.max(0, netAmount - fee - tax) : netAmount + fee + tax);
  const unitPrice = input.price ?? (input.quantity > 0 ? resolvedGrossAmount / input.quantity : netAmount);

  return {
    grossAmount: resolvedGrossAmount,
    fee,
    tax,
    netAmount,
    unitPrice,
  };
}

async function getHoldingBySymbol(tx: any, symbol: string) {
  const [holding] = await tx
    .select()
    .from(holdingsTable)
    .where(eq(holdingsTable.symbol, symbol.toUpperCase()))
    .limit(1);
  return holding as typeof holdingsTable.$inferSelect | undefined;
}

async function adjustCash(tx: any, delta: number) {
  const cash = await getHoldingBySymbol(tx, "CASH");
  if (!cash) {
    await tx.insert(holdingsTable).values({
      investmentGroup: "financial",
      type: "cash",
      symbol: "CASH",
      quantity: "1",
      manualPrice: String(delta),
      costOfCapital: "0",
    });
    return;
  }

  const currentValue = toNumber(cash.quantity) * toNumber(cash.manualPrice);
  const nextValue = currentValue + delta;
  await tx
    .update(holdingsTable)
    .set({
      quantity: "1",
      manualPrice: String(nextValue),
      updatedAt: new Date(),
    })
    .where(eq(holdingsTable.id, cash.id));
}

async function increaseAsset(tx: any, input: {
  symbol: string;
  assetType: string;
  quantity: number;
  costIncrease: number;
  valueIncrease?: number;
  interestDelta?: number;
}) {
  const symbol = input.symbol.toUpperCase();
  const usesManualValue = usesManualPortfolioValue(input.assetType);
  const holding = await getHoldingBySymbol(tx, input.symbol);
  if (!holding) {
    await tx.insert(holdingsTable).values({
      investmentGroup: deriveInvestmentGroup(input.assetType),
      type: input.assetType,
      symbol,
      quantity: String(usesManualValue ? 1 : input.quantity),
      manualPrice: usesManualValue ? String(input.valueIncrease ?? input.costIncrease) : null,
      costOfCapital: String(input.costIncrease),
      interest: input.interestDelta ? String(input.interestDelta) : null,
    });
    return;
  }

  const shouldRepairCashType = holding.type === "cash" && symbol !== "CASH" && input.assetType !== "cash";
  const nextType = shouldRepairCashType ? input.assetType : holding.type;
  const nextUsesManualValue = usesManualPortfolioValue(nextType);
  await tx
    .update(holdingsTable)
    .set({
      type: nextType,
      investmentGroup: deriveInvestmentGroup(nextType),
      quantity: String(nextUsesManualValue ? 1 : toNumber(holding.quantity) + input.quantity),
      manualPrice: nextUsesManualValue
        ? String(toNumber(holding.manualPrice) + (input.valueIncrease ?? input.costIncrease))
        : null,
      costOfCapital: String(toNumber(holding.costOfCapital) + input.costIncrease),
      interest: String(toNumber(holding.interest) + (input.interestDelta ?? 0)),
      updatedAt: new Date(),
    })
    .where(eq(holdingsTable.id, holding.id));
}

async function decreaseAsset(tx: any, input: { symbol: string; quantity: number; costDecrease: number; interestDelta?: number }) {
  const holding = await getHoldingBySymbol(tx, input.symbol);
  if (!holding) throw new Error(`Asset ${input.symbol} not found`);

  if (usesManualPortfolioValue(holding.type)) {
    const currentManualValue = toNumber(holding.manualPrice);
    if (currentManualValue + 1e-9 < input.quantity) {
      throw new Error(`Not enough value for ${input.symbol}`);
    }

    const nextManualValue = Math.max(0, currentManualValue - input.quantity);
    const nextCost = Math.max(0, toNumber(holding.costOfCapital) - input.costDecrease);

    await tx
      .update(holdingsTable)
      .set({
        quantity: String(nextManualValue > 0 ? 1 : 0),
        manualPrice: String(nextManualValue),
        costOfCapital: String(nextManualValue === 0 ? 0 : nextCost),
        interest: String(toNumber(holding.interest) + (input.interestDelta ?? 0)),
        updatedAt: new Date(),
      })
      .where(eq(holdingsTable.id, holding.id));
    return;
  }

  const currentQuantity = toNumber(holding.quantity);
  if (currentQuantity + 1e-9 < input.quantity) {
    throw new Error(`Not enough quantity for ${input.symbol}`);
  }

  const nextQuantity = Math.max(0, currentQuantity - input.quantity);
  const nextCost = Math.max(0, toNumber(holding.costOfCapital) - input.costDecrease);

  await tx
    .update(holdingsTable)
    .set({
      quantity: String(nextQuantity),
      costOfCapital: String(nextQuantity === 0 ? 0 : nextCost),
      interest: String(toNumber(holding.interest) + (input.interestDelta ?? 0)),
      updatedAt: new Date(),
    })
    .where(eq(holdingsTable.id, holding.id));
}

async function applyTransactionEffect(tx: any, input: {
  side: "buy" | "sell";
  assetType: string;
  symbol: string;
  quantity: number;
  totalValue: number;
}) {
  if (input.side === "buy") {
    await increaseAsset(tx, {
      symbol: input.symbol,
      assetType: input.assetType,
      quantity: input.quantity,
      costIncrease: input.totalValue,
    });
    await adjustCash(tx, -input.totalValue);
    return 0;
  }

  const holding = await getHoldingBySymbol(tx, input.symbol);
  if (!holding) throw new Error(`Asset ${input.symbol} not found`);

  if (usesManualPortfolioValue(input.assetType)) {
    const currentManualValue = toNumber(holding.manualPrice);
    if (currentManualValue + 1e-9 < input.totalValue) {
      throw new Error(`Not enough value for ${input.symbol}`);
    }

    const costOfCapital = toNumber(holding.costOfCapital);
    const costDecrease = currentManualValue > 0 ? (costOfCapital * input.totalValue) / currentManualValue : 0;
    const realizedInterest = input.totalValue - costDecrease;

    await decreaseAsset(tx, {
      symbol: input.symbol,
      quantity: input.totalValue,
      costDecrease,
      interestDelta: realizedInterest,
    });
    await adjustCash(tx, input.totalValue);
    return realizedInterest;
  }

  const currentQuantity = toNumber(holding.quantity);
  if (currentQuantity + 1e-9 < input.quantity) {
    throw new Error(`Not enough quantity for ${input.symbol}`);
  }

  const averageCost = currentQuantity > 0 ? toNumber(holding.costOfCapital) / currentQuantity : 0;
  const costDecrease = averageCost * input.quantity;
  const realizedInterest = input.totalValue - costDecrease;

  await decreaseAsset(tx, {
    symbol: input.symbol,
    quantity: input.quantity,
    costDecrease,
    interestDelta: realizedInterest,
  });
  await adjustCash(tx, input.totalValue);
  return realizedInterest;
}

async function reverseTransactionEffect(tx: any, transaction: typeof transactionsTable.$inferSelect) {
  if (transaction.status !== "applied") return;

  const quantity = toNumber(transaction.quantity);
  const totalValue = toNumber(transaction.totalValue);
  const realizedInterest = toNumber(transaction.realizedInterest);

  if (transaction.side === "buy") {
    await decreaseAsset(tx, {
      symbol: transaction.symbol,
      quantity: usesManualPortfolioValue(transaction.assetType) ? totalValue : quantity,
      costDecrease: totalValue,
    });
    await adjustCash(tx, totalValue);
    return;
  }

  await increaseAsset(tx, {
    symbol: transaction.symbol,
    assetType: transaction.assetType,
    quantity,
    costIncrease: totalValue - realizedInterest,
    valueIncrease: usesManualPortfolioValue(transaction.assetType) ? totalValue : undefined,
    interestDelta: -realizedInterest,
  });
  await adjustCash(tx, -totalValue);
}

router.get("/transactions", async (_req, res): Promise<void> => {
  const transactions = await db.select().from(transactionsTable).orderBy(desc(transactionsTable.executedAt));
  res.json(transactions.map(serializeTransaction));
});

router.post("/transactions", async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const transaction = await db.transaction(async (tx) => {
      const assetType = parsed.data.assetType.toLowerCase();
      const symbol = parsed.data.symbol.toUpperCase();
      const quantity = normalizeTradeQuantity(parsed.data);
      if (!usesManualPortfolioValue(assetType) && quantity <= 0) {
        throw new Error("Quantity is required for online-priced assets.");
      }
      const amounts = resolveTradeAmounts({ ...parsed.data, quantity });
      const realizedInterest = await applyTransactionEffect(tx, {
        side: parsed.data.side,
        assetType,
        symbol,
        quantity,
        totalValue: amounts.netAmount,
      });

      const [created] = await tx
        .insert(transactionsTable)
        .values({
          side: parsed.data.side,
          origin: "manual",
          fundingSource: "CASH",
          assetType,
          symbol,
          quantity: String(quantity),
          totalValue: String(amounts.netAmount),
          unitPrice: String(usesManualPortfolioValue(assetType) ? amounts.netAmount : amounts.unitPrice),
          grossAmount: String(amounts.grossAmount),
          fee: String(amounts.fee),
          tax: String(amounts.tax),
          netAmount: String(amounts.netAmount),
          realizedInterest: String(realizedInterest),
          note: parsed.data.note || null,
          status: "applied",
          executedAt: parsed.data.executedAt ?? new Date(),
        })
        .returning();
      return created;
    });

    res.status(201).json(serializeTransaction(transaction));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to apply transaction" });
  }
});

router.put("/transactions/:id", async (req, res): Promise<void> => {
  const params = UpdateTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const transaction = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(transactionsTable)
        .where(eq(transactionsTable.id, params.data.id))
        .limit(1);

      if (!existing) return null;
      if (existing.origin === "excel_sync") {
        rejectImportedTransactionMutation(res);
        return "__blocked__" as const;
      }

      await reverseTransactionEffect(tx, existing);

      const assetType = parsed.data.assetType.toLowerCase();
      const symbol = parsed.data.symbol.toUpperCase();
      const quantity = normalizeTradeQuantity(parsed.data);
      if (!usesManualPortfolioValue(assetType) && quantity <= 0) {
        throw new Error("Quantity is required for online-priced assets.");
      }
      const amounts = resolveTradeAmounts({ ...parsed.data, quantity });
      const realizedInterest = await applyTransactionEffect(tx, {
        side: parsed.data.side,
        assetType,
        symbol,
        quantity,
        totalValue: amounts.netAmount,
      });

      const [updated] = await tx
        .update(transactionsTable)
        .set({
          side: parsed.data.side,
          fundingSource: "CASH",
          assetType,
          symbol,
          quantity: String(quantity),
          totalValue: String(amounts.netAmount),
          unitPrice: String(usesManualPortfolioValue(assetType) ? amounts.netAmount : amounts.unitPrice),
          grossAmount: String(amounts.grossAmount),
          fee: String(amounts.fee),
          tax: String(amounts.tax),
          netAmount: String(amounts.netAmount),
          realizedInterest: String(realizedInterest),
          note: parsed.data.note || null,
          status: "applied",
          executedAt: parsed.data.executedAt ?? existing.executedAt,
          updatedAt: new Date(),
        })
        .where(eq(transactionsTable.id, params.data.id))
        .returning();
      return updated;
    });

    if (transaction === "__blocked__") {
      return;
    }

    if (!transaction) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }

    res.json(serializeTransaction(transaction));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update transaction" });
  }
});

router.delete("/transactions/:id", async (req, res): Promise<void> => {
  const params = UpdateTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const deleted = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(transactionsTable)
        .where(eq(transactionsTable.id, params.data.id))
        .limit(1);

      if (!existing) return null;
      if (existing.origin === "excel_sync") {
        rejectImportedTransactionMutation(res);
        return "__blocked__" as const;
      }

      await reverseTransactionEffect(tx, existing);
      const [removed] = await tx
        .delete(transactionsTable)
        .where(eq(transactionsTable.id, params.data.id))
        .returning();
      return removed;
    });

    if (deleted === "__blocked__") {
      return;
    }

    if (!deleted) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }

    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to delete transaction" });
  }
});

export default router;
