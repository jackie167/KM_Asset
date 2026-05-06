import { Router, type IRouter } from "express";
import { and, desc, eq, lte, gte } from "drizzle-orm";
import {
  GetLatestPricesResponse,
  RefreshPricesResponse,
} from "../../../lib/api-zod/src/index.ts";
import { db, holdingsTable, priceHistoryTable, transactionsTable } from "../../../lib/db/src/index.ts";
import { buildPriceHistoryRow, insertPriceHistoryRows } from "../lib/priceHistory.js";
import { fetchAndStorePrices, getLatestPrices } from "../lib/priceFetcher.js";

const router: IRouter = Router();

function usesManualPortfolioValue(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized !== "stock" && normalized !== "gold" && normalized !== "crypto";
}

router.get("/prices/latest", async (_req, res): Promise<void> => {
  const prices = await getLatestPrices();
  res.json(
    GetLatestPricesResponse.parse(
      prices.map((p) => ({
        ...p,
        price: parseFloat(String(p.price)),
        change: p.change != null ? parseFloat(String(p.change)) : null,
        changePercent: p.changePercent != null ? parseFloat(String(p.changePercent)) : null,
      }))
    )
  );
});

router.post("/prices/refresh", async (_req, res): Promise<void> => {
  const result = await fetchAndStorePrices();
  res.json(
    RefreshPricesResponse.parse({
      success: result.updated > 0,
      updated: result.updated,
      message: result.message,
    })
  );
});

router.post("/prices/history/backfill-current", async (_req, res): Promise<void> => {
  const [holdings, latestPrices] = await Promise.all([
    db.select().from(holdingsTable),
    getLatestPrices(),
  ]);
  const priceBySymbol = new Map(latestPrices.map((price) => [price.symbol.toUpperCase(), parseFloat(String(price.price))]));
  const goldBenchmark = latestPrices.find((price) => price.type.trim().toLowerCase() === "gold");
  const goldPrice = goldBenchmark ? parseFloat(String(goldBenchmark.price)) : null;
  const priceAt = new Date();
  const rows = holdings.map((holding) => {
    const type = holding.type.trim().toLowerCase();
    const manualPrice = holding.manualPrice != null ? parseFloat(String(holding.manualPrice)) : null;
    const priceOrValue = priceBySymbol.get(holding.symbol.toUpperCase()) ?? (type === "gold" ? goldPrice : null) ?? manualPrice;
    if (priceOrValue == null) return null;
    const quantity = parseFloat(String(holding.quantity));
    return buildPriceHistoryRow({
      assetCode: holding.symbol,
      assetType: holding.type,
      priceOrValue,
      quantity,
      currentValue: usesManualPortfolioValue(holding.type) ? priceOrValue : quantity * priceOrValue,
      source: "backfill_current",
      note: "current holdings baseline",
      priceAt,
    });
  });

  await insertPriceHistoryRows(db, rows);

  res.json({
    success: true,
    inserted: rows.filter(Boolean).length,
    source: "backfill_current",
    priceAt,
  });
});

router.get("/prices/history", async (req, res): Promise<void> => {
  const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim().toUpperCase() : "";
  const source = typeof req.query["source"] === "string" ? req.query["source"].trim() : "";
  const from = typeof req.query["from"] === "string" ? new Date(req.query["from"]) : null;
  const to = typeof req.query["to"] === "string" ? new Date(req.query["to"]) : null;
  const limitRaw = Number(req.query["limit"] ?? 500);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000) : 500;

  const filters = [
    symbol ? eq(priceHistoryTable.assetCode, symbol) : undefined,
    source ? eq(priceHistoryTable.source, source) : undefined,
    from && !Number.isNaN(from.getTime()) ? gte(priceHistoryTable.priceAt, from) : undefined,
    to && !Number.isNaN(to.getTime()) ? lte(priceHistoryTable.priceAt, to) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => filter != null);

  const rows = await db
    .select()
    .from(priceHistoryTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(priceHistoryTable.priceAt))
    .limit(limit);

  res.json(rows.map((row) => ({
    id: row.id,
    date: row.priceAt,
    assetCode: row.assetCode,
    assetType: row.assetType,
    priceOrValue: parseFloat(String(row.priceOrValue)),
    quantity: row.quantity != null ? parseFloat(String(row.quantity)) : null,
    currentValue: row.currentValue != null ? parseFloat(String(row.currentValue)) : null,
    source: row.source,
    note: row.note,
    updatedAt: row.updatedAt,
  })));
});

router.get("/assets/:symbol/timeline", async (req, res): Promise<void> => {
  const symbol = String(req.params["symbol"] ?? "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const from = typeof req.query["from"] === "string" ? new Date(req.query["from"]) : null;
  const to = typeof req.query["to"] === "string" ? new Date(req.query["to"]) : null;
  const limitRaw = Number(req.query["limit"] ?? 1000);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000) : 1000;

  const priceFilters = [
    eq(priceHistoryTable.assetCode, symbol),
    from && !Number.isNaN(from.getTime()) ? gte(priceHistoryTable.priceAt, from) : undefined,
    to && !Number.isNaN(to.getTime()) ? lte(priceHistoryTable.priceAt, to) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => filter != null);
  const transactionFilters = [
    eq(transactionsTable.symbol, symbol),
    from && !Number.isNaN(from.getTime()) ? gte(transactionsTable.executedAt, from) : undefined,
    to && !Number.isNaN(to.getTime()) ? lte(transactionsTable.executedAt, to) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => filter != null);

  const [priceRows, transactionRows] = await Promise.all([
    db
      .select()
      .from(priceHistoryTable)
      .where(and(...priceFilters))
      .orderBy(desc(priceHistoryTable.priceAt))
      .limit(limit),
    db
      .select()
      .from(transactionsTable)
      .where(and(...transactionFilters))
      .orderBy(desc(transactionsTable.executedAt))
      .limit(limit),
  ]);

  const events = [
    ...priceRows.map((row) => ({
      eventType: "price" as const,
      id: row.id,
      date: row.priceAt,
      assetCode: row.assetCode,
      assetType: row.assetType,
      priceOrValue: parseFloat(String(row.priceOrValue)),
      quantity: row.quantity != null ? parseFloat(String(row.quantity)) : null,
      currentValue: row.currentValue != null ? parseFloat(String(row.currentValue)) : null,
      source: row.source,
      note: row.note,
      updatedAt: row.updatedAt,
    })),
    ...transactionRows.map((row) => {
      const netAmount = parseFloat(String(row.totalValue));
      const realizedPnl = row.realizedInterest != null ? parseFloat(String(row.realizedInterest)) : null;
      const costBasisRemoved = row.side === "sell" && realizedPnl != null ? netAmount - realizedPnl : null;
      return {
        eventType: "transaction" as const,
        id: row.id,
        date: row.executedAt,
        assetCode: row.symbol,
        assetType: row.assetType,
        side: row.side,
        quantity: parseFloat(String(row.quantity)),
        unitPrice: row.unitPrice != null ? parseFloat(String(row.unitPrice)) : null,
        netAmount,
        realizedPnl,
        costBasisRemoved,
        fundingSource: row.fundingSource,
        origin: row.origin,
        status: row.status,
        note: row.note,
        updatedAt: row.updatedAt,
      };
    }),
  ].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime()).slice(0, limit);

  res.json({
    symbol,
    count: events.length,
    priceCount: priceRows.length,
    transactionCount: transactionRows.length,
    events,
  });
});

export default router;
