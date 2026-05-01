import { Router, type IRouter } from "express";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  appSettingsTable,
  baseAssetsTable,
  db,
  forecastTradesTable,
  holdingsTable,
  portfolioCashFlowsTable,
  snapshotsTable,
  transactionsTable,
} from "../../../lib/db/src/index.ts";
import {
  ListHoldingsResponse,
  CreateHoldingBody,
  UpdateHoldingParams,
  UpdateHoldingBody,
  UpdateHoldingResponse,
  DeleteHoldingParams,
  GetPortfolioSummaryResponse,
} from "../../../lib/api-zod/src/index.ts";
import { getLatestPrices } from "../lib/priceFetcher.js";

const router: IRouter = Router();
const STOCK_RETURN_INITIAL_AT = new Date("2026-01-01T00:00:00.000Z");
const ASSET_RETURN_SETTING_KEY = "asset_forecast_asset_returns";
const FINANCIAL_FORECAST_TYPES = new Set(["cash", "stock", "gold", "fund", "crypto"]);

function normalizeHoldingType(type: string): string {
  return type.trim().toLowerCase();
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function fixedAssetKey(type: string, symbol: string): string {
  return `${normalizeHoldingType(type)}::${normalizeSymbol(symbol)}`;
}

function usesManualPortfolioValue(type: string): boolean {
  const normalized = normalizeHoldingType(type);
  return normalized !== "stock" && normalized !== "gold" && normalized !== "crypto";
}

function isFinancialForecastAsset(type: string, symbol: string): boolean {
  return FINANCIAL_FORECAST_TYPES.has(normalizeHoldingType(type)) ||
    FINANCIAL_FORECAST_TYPES.has(normalizeHoldingType(symbol));
}

function resolveHoldingCurrentValue(input: { type: string; quantity: number; currentPrice: number | null }): number | null {
  if (input.currentPrice == null) return null;
  return usesManualPortfolioValue(input.type) ? input.currentPrice : input.quantity * input.currentPrice;
}

function buildHoldingPnLFields(input: {
  type: string;
  quantity: number;
  costOfCapital: number | null;
  interest: number | null;
  currentValue: number | null;
}) {
  const quantityRemaining = input.quantity;
  const costBasisRemaining = input.costOfCapital;
  const realizedPnl = input.interest ?? 0;
  const avgCost =
    costBasisRemaining != null && quantityRemaining > 0 && !usesManualPortfolioValue(input.type)
      ? costBasisRemaining / quantityRemaining
      : costBasisRemaining;
  const unrealizedPnl =
    input.currentValue != null && costBasisRemaining != null
      ? input.currentValue - costBasisRemaining
      : null;
  const totalPnl = unrealizedPnl != null ? unrealizedPnl + realizedPnl : null;

  return {
    quantityRemaining,
    avgCost,
    costBasisRemaining,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
  };
}

function rejectManualPortfolioWrite(res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  res.status(403).json({
    error: "Danh muc Tai san dang dong bo tu Investment sheet. Hay cap nhat Excel roi bam Sync.",
  });
}

function yearFraction(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
}

function calculateXirr(cashFlows: Array<{ date: Date; amount: number }>): number | null {
  const merged = new Map<number, number>();
  for (const flow of cashFlows) {
    const time = flow.date.getTime();
    if (!Number.isFinite(time) || !Number.isFinite(flow.amount) || Math.abs(flow.amount) < 1e-9) continue;
    merged.set(time, (merged.get(time) ?? 0) + flow.amount);
  }

  const sorted = [...merged.entries()]
    .map(([time, amount]) => ({ date: new Date(time), amount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (!sorted.some((flow) => flow.amount < 0) || !sorted.some((flow) => flow.amount > 0)) {
    return null;
  }

  const startDate = sorted[0].date;
  const npv = (rate: number) => {
    if (rate <= -0.999999999) return Number.NaN;
    return sorted.reduce((sum, flow) => {
      const years = yearFraction(startDate, flow.date);
      return sum + flow.amount / Math.pow(1 + rate, years);
    }, 0);
  };
  const dNpv = (rate: number) => {
    if (rate <= -0.999999999) return Number.NaN;
    return sorted.reduce((sum, flow) => {
      const years = yearFraction(startDate, flow.date);
      if (years === 0) return sum;
      return sum - (years * flow.amount) / Math.pow(1 + rate, years + 1);
    }, 0);
  };

  const guesses = [-0.9, -0.5, -0.2, -0.05, 0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  for (const guess of guesses) {
    let rate = guess;
    for (let i = 0; i < 100; i += 1) {
      const value = npv(rate);
      if (!Number.isFinite(value)) break;
      if (Math.abs(value) < 0.0001) return rate;
      const derivative = dNpv(rate);
      if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-10) break;
      const next = rate - value / derivative;
      if (!Number.isFinite(next) || next <= -0.999999999) break;
      if (Math.abs(next - rate) < 1e-10) return next;
      rate = next;
    }
  }

  const brackets = [
    [-0.9999, -0.9],
    [-0.9, -0.5],
    [-0.5, -0.2],
    [-0.2, -0.05],
    [-0.05, 0.05],
    [0.05, 0.2],
    [0.2, 0.5],
    [0.5, 1],
    [1, 2],
    [2, 5],
    [5, 10],
    [10, 50],
    [50, 200],
  ] as const;

  for (const [lowStart, highStart] of brackets) {
    let low = lowStart;
    let high = highStart;
    let lowValue = npv(low);
    const highValue = npv(high);
    if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || lowValue * highValue > 0) continue;

    for (let i = 0; i < 120; i += 1) {
      const mid = (low + high) / 2;
      const midValue = npv(mid);
      if (!Number.isFinite(midValue)) break;
      if (Math.abs(midValue) < 0.0001) return mid;
      if (lowValue * midValue <= 0) {
        high = mid;
      } else {
        low = mid;
        lowValue = midValue;
      }
    }

    return (low + high) / 2;
  }

  return null;
}

function latestPriceMap(latestPrices: Awaited<ReturnType<typeof getLatestPrices>>) {
  const priceMap = new Map<string, number>();
  for (const price of latestPrices) {
    priceMap.set(price.symbol.toUpperCase(), parseFloat(String(price.price)));
  }
  return priceMap;
}

function parsePercentSetting(value: unknown): number {
  const cleaned = String(value ?? "").trim().replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed / 100 : 0;
}

function elapsedMonthsFromBaseYear(baseYear = 2026, now = new Date()): number {
  return Math.max(0, (now.getFullYear() - baseYear) * 12 + now.getMonth());
}

function currentYearFixedAssetValue(input: {
  baseValue: number;
  baseYear: number;
  annualRate: number;
  tradeAdjustment: number;
}) {
  const months = elapsedMonthsFromBaseYear(input.baseYear);
  const valueBeforeTrades = input.baseValue * Math.pow(1 + input.annualRate, months / 12);
  return Math.max(0, Math.round(valueBeforeTrades + input.tradeAdjustment));
}

async function getPortfolioCurrentValueSnapshot() {
  const [holdings, latestPrices, baseAssets, assetReturnSettingRows, currentYearForecastTrades] = await Promise.all([
    db.select().from(holdingsTable).orderBy(holdingsTable.createdAt),
    getLatestPrices(),
    db.select().from(baseAssetsTable),
    db.select().from(appSettingsTable).where(eq(appSettingsTable.key, ASSET_RETURN_SETTING_KEY)).limit(1),
    db.select().from(forecastTradesTable).where(eq(forecastTradesTable.year, new Date().getFullYear())),
  ]);

  const assetReturnInputs = (() => {
    const raw = assetReturnSettingRows[0]?.value;
    if (!raw) return {} as Record<string, string>;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      return {} as Record<string, string>;
    }
  })();

  const baseAssetByKey = new Map(baseAssets.map((asset) => [fixedAssetKey(asset.assetType, asset.symbol), asset]));
  const forecastTradeAdjustmentByKey = new Map<string, number>();
  for (const trade of currentYearForecastTrades) {
    if (isFinancialForecastAsset(trade.assetType, trade.symbol)) continue;
    const amount = parseFloat(String(trade.amount));
    if (!Number.isFinite(amount)) continue;
    const key = fixedAssetKey(trade.assetType, trade.symbol);
    const signedAmount = trade.side === "sell" ? -amount : amount;
    forecastTradeAdjustmentByKey.set(key, (forecastTradeAdjustmentByKey.get(key) ?? 0) + signedAmount);
  }

  const priceMap = new Map<string, { price: number; change: number | null; changePercent: number | null }>();
  for (const p of latestPrices) {
    priceMap.set(p.symbol.toUpperCase(), {
      price: parseFloat(String(p.price)),
      change: p.change != null ? parseFloat(String(p.change)) : null,
      changePercent: p.changePercent != null ? parseFloat(String(p.changePercent)) : null,
    });
  }
  const goldBenchmark = latestPrices.find((price) => normalizeHoldingType(price.type) === "gold");

  let stockValue = 0;
  let goldValue = 0;
  let otherValue = 0;
  let lastUpdatedDate: Date | null = null;

  if (latestPrices.length > 0) {
    lastUpdatedDate = latestPrices.reduce((max, p) =>
      p.fetchedAt > max ? p.fetchedAt : max, latestPrices[0].fetchedAt
    );
  }

  const holdingsWithValue = holdings.map((h) => {
    const qty = parseFloat(String(h.quantity));
    const sym = normalizeSymbol(h.symbol);
    const normalizedType = normalizeHoldingType(h.type);
    const fixedAsset = baseAssetByKey.get(fixedAssetKey(h.type, h.symbol));
    const priceData = priceMap.get(sym) ?? (normalizedType === "gold" && goldBenchmark
      ? {
          price: parseFloat(String(goldBenchmark.price)),
          change: goldBenchmark.change != null ? parseFloat(String(goldBenchmark.change)) : null,
          changePercent: goldBenchmark.changePercent != null ? parseFloat(String(goldBenchmark.changePercent)) : null,
        }
      : undefined);
    const manualUnitPrice = h.manualPrice != null ? parseFloat(String(h.manualPrice)) : null;
    const fixedAssetCurrentValue = fixedAsset
      ? currentYearFixedAssetValue({
          baseValue: parseFloat(String(fixedAsset.baseValue)),
          baseYear: fixedAsset.baseYear,
          annualRate: parsePercentSetting(assetReturnInputs[fixedAssetKey(fixedAsset.assetType, fixedAsset.symbol)]),
          tradeAdjustment: forecastTradeAdjustmentByKey.get(fixedAssetKey(fixedAsset.assetType, fixedAsset.symbol)) ?? 0,
        })
      : null;
    const currentPrice = fixedAssetCurrentValue ?? priceData?.price ?? manualUnitPrice;
    const currentValue = fixedAssetCurrentValue ?? resolveHoldingCurrentValue({ type: h.type, quantity: qty, currentPrice });

    if (currentValue != null) {
      if (normalizedType === "stock") stockValue += currentValue;
      else if (normalizedType === "gold") goldValue += currentValue;
      else otherValue += currentValue;
    }

    const costOfCapital = h.costOfCapital != null ? parseFloat(String(h.costOfCapital)) : null;
    const interest = h.interest != null ? parseFloat(String(h.interest)) : null;

    return {
      id: h.id,
      type: h.type,
      symbol: h.symbol,
      quantity: qty,
      currentPrice,
      currentValue,
      change: priceData?.change ?? null,
      changePercent: priceData?.changePercent ?? null,
      manualPrice: manualUnitPrice,
      costOfCapital,
      interest,
      ...buildHoldingPnLFields({
        type: h.type,
        quantity: qty,
        costOfCapital,
        interest,
        currentValue,
      }),
    };
  });

  return {
    totalValue: stockValue + goldValue + otherValue,
    stockValue,
    goldValue,
    lastUpdatedDate,
    holdingsWithValue,
  };
}

async function buildPortfolioXirrSnapshot() {
  const [portfolioSnapshot, snapshotBeforeStart, tradeTransactions] = await Promise.all([
    getPortfolioCurrentValueSnapshot(),
    db
      .select()
      .from(snapshotsTable)
      .where(lte(snapshotsTable.snapshotAt, STOCK_RETURN_INITIAL_AT))
      .orderBy(desc(snapshotsTable.snapshotAt))
      .limit(1),
    db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.status, "applied"),
          gte(transactionsTable.executedAt, STOCK_RETURN_INITIAL_AT),
          lte(transactionsTable.executedAt, new Date()),
        )
      ),
  ]);
  const asOf = new Date();
  const currentValue = portfolioSnapshot.totalValue;
  const currentCostBasis = portfolioSnapshot.holdingsWithValue.reduce(
    (sum, holding) => sum + (holding.costBasisRemaining ?? holding.costOfCapital ?? 0),
    0
  );
  const buyTransactionTotal = tradeTransactions.reduce((sum, transaction) => {
    if (transaction.side !== "buy") return sum;
    if (transaction.fundingSource.trim().toUpperCase() !== "CASH") return sum;
    return sum + parseFloat(String(transaction.totalValue));
  }, 0);
  const sellCostBasisRemoved = tradeTransactions.reduce((sum, transaction) => {
    if (transaction.side !== "sell") return sum;
    const netAmount = parseFloat(String(transaction.totalValue));
    const realizedPnl = parseFloat(String(transaction.realizedInterest ?? 0));
    return sum + Math.max(0, netAmount - realizedPnl);
  }, 0);
  const reconstructedBeginningNav = Math.max(0, currentCostBasis - buyTransactionTotal + sellCostBasisRemoved);
  const beginningSnapshot = snapshotBeforeStart[0] ?? null;
  const beginningNav = beginningSnapshot
    ? parseFloat(String(beginningSnapshot.totalValue))
    : reconstructedBeginningNav;
  const beginningAt = beginningSnapshot?.snapshotAt ?? STOCK_RETURN_INITIAL_AT;
  const beginningSnapshotSource = beginningSnapshot
    ? "latest_snapshot_before_or_at_start"
    : "reconstructed_from_current_cost_basis_and_internal_trades";

  const externalCashFlows = beginningSnapshot
    ? await db
      .select()
      .from(portfolioCashFlowsTable)
      .where(
        and(
          gt(portfolioCashFlowsTable.occurredAt, beginningAt),
          lte(portfolioCashFlowsTable.occurredAt, asOf),
        )
      )
    : await db
      .select()
      .from(portfolioCashFlowsTable)
      .where(
        and(
          gte(portfolioCashFlowsTable.occurredAt, STOCK_RETURN_INITIAL_AT),
          lte(portfolioCashFlowsTable.occurredAt, asOf),
        )
      );

  const externalCashFlowRows = externalCashFlows.flatMap((flow) => {
    const amount = parseFloat(String(flow.amount));
    if (!Number.isFinite(amount) || amount <= 0) return [];

    const normalizedKind = flow.kind.trim().toLowerCase();
    const signedAmount =
      normalizedKind === "deposit" || normalizedKind === "contribution"
        ? -amount
        : normalizedKind === "withdrawal"
          ? amount
          : null;

    if (signedAmount == null) return [];

    return [{
      date: flow.occurredAt,
      amount: signedAmount,
      kind: normalizedKind,
      source: flow.source || flow.origin || "portfolio_cash_flows",
      note: flow.note,
      rowType: "external_cash_flow" as const,
    }];
  });

  const cashFlows = [
    {
      date: beginningAt,
      amount: -beginningNav,
      kind: "beginning_nav",
      source: beginningSnapshotSource,
      note: beginningSnapshot
        ? `Snapshot #${beginningSnapshot.id} total NAV`
        : "No beginning portfolio snapshot found",
      rowType: "portfolio_beginning_nav" as const,
    },
    ...externalCashFlowRows,
    {
      date: asOf,
      amount: currentValue,
      kind: "current_value",
      source: "portfolio_snapshot",
      note: "Current portfolio value",
      rowType: "portfolio_current_value" as const,
    },
  ];

  const xirrAnnual = calculateXirr(cashFlows);
  const xirrMonthly = xirrAnnual == null ? null : Math.pow(1 + xirrAnnual, 1 / 12) - 1;

  return {
    asOf,
    startDate: STOCK_RETURN_INITIAL_AT,
    beginningAt,
    beginningSnapshotId: beginningSnapshot?.id ?? null,
    beginningSnapshotSource,
    beginningNav,
    endingNav: currentValue,
    currentValue,
    initialCapital: beginningNav,
    rawInitialCapital: beginningNav,
    currentCostBasis,
    buyTransactionTotal,
    sellCostBasisRemoved,
    externalCashFlowTotal: externalCashFlowRows.reduce((sum, flow) => sum + flow.amount, 0),
    cashFlowCount: cashFlows.length,
    hasNegativeCashFlow: cashFlows.some((flow) => flow.amount < 0),
    hasPositiveCashFlow: cashFlows.some((flow) => flow.amount > 0),
    mode: "portfolio_nav_external_cash_flow_xirr" as const,
    ignoredInternalTradeFlows: true,
    reason: beginningNav <= 0 || currentValue <= 0
      ? "Portfolio XIRR needs a beginning NAV snapshot and current portfolio value."
      : null,
    xirrAnnual,
    xirrMonthly,
    cashFlows,
  };
}

const CreatePortfolioCashFlowBody = z.object({
  kind: z.enum(["deposit", "withdrawal", "cash_yield", "manual_adjustment", "contribution"]),
  account: z.string().trim().min(1).default("CASH"),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
  occurredAt: z.coerce.date().optional(),
});

router.get("/holdings", async (_req, res): Promise<void> => {
  const holdings = await db.select().from(holdingsTable).orderBy(holdingsTable.createdAt);
  res.json(
    ListHoldingsResponse.parse(
      holdings.map((h) => ({
        ...h,
        quantity: parseFloat(String(h.quantity)),
        manualPrice: h.manualPrice != null ? parseFloat(String(h.manualPrice)) : null,
        costOfCapital: h.costOfCapital != null ? parseFloat(String(h.costOfCapital)) : null,
        interest: h.interest != null ? parseFloat(String(h.interest)) : null,
      }))
    )
  );
});

router.post("/holdings", async (req, res): Promise<void> => {
  rejectManualPortfolioWrite(res);
  return;

  const parsed = CreateHoldingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [holding] = await db
    .insert(holdingsTable)
    .values({
      type: parsed.data.type,
      symbol: parsed.data.symbol.toUpperCase(),
      quantity: String(parsed.data.quantity),
      manualPrice: parsed.data.manualPrice != null ? String(parsed.data.manualPrice) : null,
    })
    .returning();

  res.status(201).json({
    ...holding,
    quantity: parseFloat(String(holding.quantity)),
    manualPrice: holding.manualPrice != null ? parseFloat(String(holding.manualPrice)) : null,
    costOfCapital: holding.costOfCapital != null ? parseFloat(String(holding.costOfCapital)) : null,
    interest: holding.interest != null ? parseFloat(String(holding.interest)) : null,
  });
});

router.put("/holdings/:id", async (req, res): Promise<void> => {
  rejectManualPortfolioWrite(res);
  return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateHoldingParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateHoldingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [holding] = await db
    .update(holdingsTable)
    .set({
      type: parsed.data.type,
      quantity: String(parsed.data.quantity),
      manualPrice: parsed.data.manualPrice != null ? String(parsed.data.manualPrice) : null,
      updatedAt: new Date(),
    })
    .where(eq(holdingsTable.id, params.data.id))
    .returning();

  if (!holding) {
    res.status(404).json({ error: "Holding not found" });
    return;
  }

  res.json(UpdateHoldingResponse.parse({
    ...holding,
    quantity: parseFloat(String(holding.quantity)),
    manualPrice: holding.manualPrice != null ? parseFloat(String(holding.manualPrice)) : null,
    costOfCapital: holding.costOfCapital != null ? parseFloat(String(holding.costOfCapital)) : null,
    interest: holding.interest != null ? parseFloat(String(holding.interest)) : null,
  }));
});

router.delete("/holdings/:id", async (req, res): Promise<void> => {
  rejectManualPortfolioWrite(res);
  return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteHoldingParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(holdingsTable)
    .where(eq(holdingsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Holding not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/portfolio/summary", async (_req, res): Promise<void> => {
  const { totalValue, stockValue, goldValue, lastUpdatedDate, holdingsWithValue } = await getPortfolioCurrentValueSnapshot();

  res.json(
    GetPortfolioSummaryResponse.parse({
      totalValue,
      stockValue,
      goldValue,
      lastUpdated: lastUpdatedDate,
      holdings: holdingsWithValue,
    })
  );
});

router.get("/portfolio/closed-positions", async (_req, res): Promise<void> => {
  const [transactions, holdings] = await Promise.all([
    db.select().from(transactionsTable).where(eq(transactionsTable.status, "applied")),
    db.select().from(holdingsTable),
  ]);
  const holdingsBySymbol = new Map(holdings.map((holding) => [holding.symbol.toUpperCase(), holding]));
  const totalsBySymbol = new Map<string, {
    symbol: string;
    assetType: string;
    sellCount: number;
    soldQuantity: number;
    netProceeds: number;
    realizedPnl: number;
    costBasisRemoved: number;
    lastSoldAt: Date;
  }>();

  for (const transaction of transactions) {
    if (transaction.side !== "sell") continue;

    const symbol = transaction.symbol.toUpperCase();
    const netAmount = parseFloat(String(transaction.netAmount ?? transaction.totalValue));
    const realizedPnl = parseFloat(String(transaction.realizedInterest ?? 0));
    const costBasisRemoved = netAmount - realizedPnl;
    const existing = totalsBySymbol.get(symbol);

    if (existing) {
      existing.sellCount += 1;
      existing.soldQuantity += parseFloat(String(transaction.quantity));
      existing.netProceeds += netAmount;
      existing.realizedPnl += realizedPnl;
      existing.costBasisRemoved += costBasisRemoved;
      if (transaction.executedAt > existing.lastSoldAt) existing.lastSoldAt = transaction.executedAt;
      continue;
    }

    totalsBySymbol.set(symbol, {
      symbol,
      assetType: transaction.assetType,
      sellCount: 1,
      soldQuantity: parseFloat(String(transaction.quantity)),
      netProceeds: netAmount,
      realizedPnl,
      costBasisRemoved,
      lastSoldAt: transaction.executedAt,
    });
  }

  const rows = [...totalsBySymbol.values()]
    .filter((row) => {
      const holding = holdingsBySymbol.get(row.symbol);
      if (!holding) return true;
      return parseFloat(String(holding.quantity)) <= 0;
    })
    .sort((left, right) => right.lastSoldAt.getTime() - left.lastSoldAt.getTime())
    .map((row) => ({
      ...row,
      realizedPnlPercent: row.costBasisRemoved > 0 ? row.realizedPnl / row.costBasisRemoved : null,
    }));

  res.json(rows);
});

router.get("/portfolio/xirr", async (_req, res): Promise<void> => {
  const snapshot = await buildPortfolioXirrSnapshot();
  res.json(snapshot);
});

router.get("/portfolio/xirr/export", async (_req, res): Promise<void> => {
  const snapshot = await buildPortfolioXirrSnapshot();
  const rows = [
    [
      "meta",
      "",
      snapshot.asOf.toISOString(),
      "",
      "",
      "",
      "",
      snapshot.initialCapital,
      snapshot.currentValue,
      snapshot.beginningAt.toISOString(),
      snapshot.beginningSnapshotId ?? "",
      snapshot.beginningSnapshotSource,
      snapshot.endingNav,
      snapshot.currentCostBasis,
      snapshot.buyTransactionTotal,
      snapshot.sellCostBasisRemoved,
      snapshot.xirrAnnual ?? "",
      snapshot.xirrMonthly ?? "",
      snapshot.hasNegativeCashFlow ? "true" : "false",
      snapshot.hasPositiveCashFlow ? "true" : "false",
      snapshot.reason ?? "",
    ],
    ...snapshot.cashFlows.map((flow) => [
      flow.rowType,
      flow.kind,
      flow.date.toISOString(),
      flow.source,
      flow.note ?? "",
      flow.amount < 0 ? "out" : "in",
      flow.amount,
      snapshot.initialCapital,
      snapshot.currentValue,
      snapshot.beginningAt.toISOString(),
      snapshot.beginningSnapshotId ?? "",
      snapshot.beginningSnapshotSource,
      snapshot.endingNav,
      snapshot.currentCostBasis,
      snapshot.buyTransactionTotal,
      snapshot.sellCostBasisRemoved,
      snapshot.xirrAnnual ?? "",
      snapshot.xirrMonthly ?? "",
      snapshot.hasNegativeCashFlow ? "true" : "false",
      snapshot.hasPositiveCashFlow ? "true" : "false",
      "",
    ]),
  ];

  const header = [
    "row_type",
    "kind",
    "date",
    "source",
    "note",
    "direction",
    "amount",
    "initial_capital",
    "current_portfolio_value",
    "beginning_nav_at",
    "beginning_snapshot_id",
    "beginning_snapshot_source",
    "ending_nav",
    "current_cost_basis",
    "buy_internal_total",
    "sell_cost_basis_removed",
    "xirr_annual",
    "xirr_monthly",
    "has_negative_cash_flow",
    "has_positive_cash_flow",
    "reason",
  ];
  const csv = [header, ...rows]
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="portfolio-xirr-debug-${snapshot.asOf.toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${csv}`);
});

router.get("/portfolio/cash-flows", async (_req, res): Promise<void> => {
  const rows = await db.select().from(portfolioCashFlowsTable).orderBy(portfolioCashFlowsTable.occurredAt);
  res.json(rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    account: row.account,
    origin: row.origin,
    amount: parseFloat(String(row.amount)),
    note: row.note,
    source: row.source,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })));
});

router.post("/portfolio/cash-flows", async (req, res): Promise<void> => {
  const parsed = CreatePortfolioCashFlowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const kind = parsed.data.kind === "contribution" ? "deposit" : parsed.data.kind;
  const amount = parsed.data.amount;
  const delta = kind === "deposit" ? amount : -amount;

  // 1. Log the cash flow
  const [created] = await db
    .insert(portfolioCashFlowsTable)
    .values({
      kind,
      account: parsed.data.account.toUpperCase(),
      origin: "manual",
      amount: String(amount),
      note: parsed.data.note || null,
      source: "manual",
      occurredAt: parsed.data.occurredAt ?? new Date(),
    })
    .returning();

  // 2. Update the Cash holding balance
  await adjustCashHolding(delta);

  res.status(201).json({
    id: created.id,
    kind: created.kind,
    account: created.account,
    origin: created.origin,
    amount: parseFloat(String(created.amount)),
    note: created.note,
    source: created.source,
    occurredAt: created.occurredAt,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });
});

async function adjustCashHolding(delta: number): Promise<void> {
  if (delta === 0) return;
  const cashHolding = await db
    .select()
    .from(holdingsTable)
    .where(sql`lower(${holdingsTable.type}) = 'cash' OR lower(${holdingsTable.symbol}) = 'cash'`)
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!cashHolding) {
    if (delta > 0) {
      await db.insert(holdingsTable).values({ symbol: "CASH", type: "cash", quantity: "1", manualPrice: String(delta), costOfCapital: String(delta) });
    }
    return;
  }

  const current = cashHolding.manualPrice != null
    ? parseFloat(String(cashHolding.manualPrice))
    : parseFloat(String(cashHolding.quantity));
  const newPrice = Math.max(0, current + delta);
  await db.update(holdingsTable).set({
    manualPrice: String(newPrice),
    updatedAt: new Date(),
  }).where(eq(holdingsTable.id, cashHolding.id));

  try {
    await fetch(`http://localhost:${process.env["PORT"] ?? 4000}/api/excel/investment/update-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: cashHolding.symbol.toUpperCase(), price: newPrice }),
    });
  } catch { /* non-fatal */ }
}

const UpdatePortfolioCashFlowBody = z.object({
  kind: z.enum(["deposit", "withdrawal"]),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
  occurredAt: z.coerce.date().optional(),
});

router.post("/portfolio/cash-flows/recalculate", async (_req, res): Promise<void> => {
  const [flows, transactions] = await Promise.all([
    db.select().from(portfolioCashFlowsTable),
    db.select().from(transactionsTable),
  ]);
  const total = flows.reduce((sum, flow) => {
    const amount = parseFloat(String(flow.amount));
    return flow.kind === "deposit" ? sum + amount : sum - amount;
  }, 0);
  const tradeCashFlow = transactions.reduce((sum, transaction) => {
    if (transaction.status !== "applied") return sum;
    if (transaction.fundingSource.trim().toUpperCase() !== "CASH") return sum;
    const amount = parseFloat(String(transaction.totalValue));
    return sum + (transaction.side === "buy" ? -amount : amount);
  }, 0);
  const newPrice = Math.max(0, total + tradeCashFlow);

  let cashHolding = await db
    .select()
    .from(holdingsTable)
    .where(sql`lower(${holdingsTable.type}) = 'cash' OR lower(${holdingsTable.symbol}) = 'cash'`)
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (cashHolding) {
    await db.update(holdingsTable).set({
      manualPrice: String(newPrice),
      updatedAt: new Date(),
    }).where(eq(holdingsTable.id, cashHolding.id));
  } else {
    const [created] = await db.insert(holdingsTable).values({
      symbol: "CASH",
      type: "cash",
      quantity: "1",
      manualPrice: String(newPrice),
      costOfCapital: String(Math.max(0, total)),
    }).returning();
    cashHolding = created ?? null;
  }

  if (cashHolding) {
    try {
      await fetch(`http://localhost:${process.env["PORT"] ?? 4000}/api/excel/investment/update-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: cashHolding.symbol.toUpperCase(), price: newPrice }),
      });
    } catch { /* non-fatal */ }
  }

  res.json({ success: true, newCashBalance: newPrice, flowCount: flows.length });
});

router.put("/portfolio/cash-flows/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdatePortfolioCashFlowBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(portfolioCashFlowsTable).where(eq(portfolioCashFlowsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Cash flow not found" }); return; }

  const oldDelta = existing.kind === "deposit" ? parseFloat(String(existing.amount)) : -parseFloat(String(existing.amount));
  const newDelta = parsed.data.kind === "deposit" ? parsed.data.amount : -parsed.data.amount;
  const netDelta = newDelta - oldDelta;

  const [updated] = await db
    .update(portfolioCashFlowsTable)
    .set({
      kind: parsed.data.kind,
      amount: String(parsed.data.amount),
      note: parsed.data.note ?? null,
      occurredAt: parsed.data.occurredAt ?? existing.occurredAt,
    })
    .where(eq(portfolioCashFlowsTable.id, id))
    .returning();

  await adjustCashHolding(netDelta);

  res.json({
    id: updated!.id, kind: updated!.kind, account: updated!.account, origin: updated!.origin,
    amount: parseFloat(String(updated!.amount)), note: updated!.note, source: updated!.source,
    occurredAt: updated!.occurredAt, createdAt: updated!.createdAt, updatedAt: updated!.updatedAt,
  });
});

router.delete("/portfolio/cash-flows/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(portfolioCashFlowsTable).where(eq(portfolioCashFlowsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Cash flow not found" }); return; }

  const reverseDelta = existing.kind === "deposit"
    ? -parseFloat(String(existing.amount))
    : parseFloat(String(existing.amount));

  await db.delete(portfolioCashFlowsTable).where(eq(portfolioCashFlowsTable.id, id));
  await adjustCashHolding(reverseDelta);

  res.json({ success: true });
});

router.get("/portfolio/returns/stock/:symbol", async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "Missing stock symbol" });
    return;
  }

  const [holding] = await db
    .select()
    .from(holdingsTable)
    .where(eq(holdingsTable.symbol, symbol))
    .limit(1);

  if (!holding || holding.type !== "stock") {
    res.status(404).json({ error: `Stock ${symbol} not found` });
    return;
  }

  const qty = parseFloat(String(holding.quantity));
  const costOfCapital = holding.costOfCapital != null ? parseFloat(String(holding.costOfCapital)) : null;
  if (costOfCapital == null || costOfCapital <= 0) {
    res.status(400).json({ error: `Stock ${symbol} does not have cost of capital` });
    return;
  }

  const prices = await getLatestPrices();
  const priceMap = latestPriceMap(prices);
  const currentPrice = priceMap.get(symbol) ?? (holding.manualPrice != null ? parseFloat(String(holding.manualPrice)) : null);
  if (currentPrice == null) {
    res.status(400).json({ error: `Stock ${symbol} does not have a current price` });
    return;
  }

  const currentValue = qty * currentPrice;
  const today = new Date();
  const cashFlows = [
    { date: STOCK_RETURN_INITIAL_AT, amount: -costOfCapital },
    { date: today, amount: currentValue },
  ];
  const xirrAnnual = calculateXirr(cashFlows);
  const xirrMonthly = xirrAnnual == null ? null : Math.pow(1 + xirrAnnual, 1 / 12) - 1;

  res.json({
    symbol,
    mode: "basic_current_value_estimate",
    initialAt: STOCK_RETURN_INITIAL_AT,
    asOf: today,
    quantity: qty,
    costOfCapital,
    currentPrice,
    currentValue,
    unrealizedPnL: currentValue - costOfCapital,
    unrealizedPnLPercent: costOfCapital > 0 ? (currentValue - costOfCapital) / costOfCapital : null,
    xirrAnnual,
    xirrMonthly,
    cashFlows,
  });
});

router.get("/portfolio/returns", async (_req, res): Promise<void> => {
  const [holdings, prices] = await Promise.all([
    db.select().from(holdingsTable).orderBy(holdingsTable.createdAt),
    getLatestPrices(),
  ]);
  const priceMap = latestPriceMap(prices);
  const goldBenchmark = prices.find((price) => normalizeHoldingType(price.type) === "gold");
  const goldPrice = goldBenchmark ? parseFloat(String(goldBenchmark.price)) : null;
  const today = new Date();

  const rows = holdings.map((holding) => {
    const symbol = holding.symbol.toUpperCase();
    const quantity = parseFloat(String(holding.quantity));
    const costOfCapital = holding.costOfCapital != null ? parseFloat(String(holding.costOfCapital)) : null;
    const manualPrice = holding.manualPrice != null ? parseFloat(String(holding.manualPrice)) : null;
    const normalizedType = normalizeHoldingType(holding.type);
    const currentPrice = priceMap.get(symbol) ?? (normalizedType === "gold" ? goldPrice : null) ?? manualPrice;
    const currentValue = resolveHoldingCurrentValue({ type: holding.type, quantity, currentPrice });
    const unrealizedPnL =
      costOfCapital != null && currentValue != null ? currentValue - costOfCapital : null;
    const unrealizedPnLPercent =
      costOfCapital != null && costOfCapital > 0 && unrealizedPnL != null
        ? unrealizedPnL / costOfCapital
        : null;

    const xirrAnnual =
      costOfCapital != null && costOfCapital > 0 && currentValue != null
        ? calculateXirr([
            { date: STOCK_RETURN_INITIAL_AT, amount: -costOfCapital },
            { date: today, amount: currentValue },
          ])
        : null;
    const xirrMonthly = xirrAnnual == null ? null : Math.pow(1 + xirrAnnual, 1 / 12) - 1;

    return {
      symbol,
      type: holding.type,
      initialAt: STOCK_RETURN_INITIAL_AT,
      asOf: today,
      quantity,
      costOfCapital,
      currentPrice,
      currentValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      xirrAnnual,
      xirrMonthly,
    };
  });

  res.json(rows);
});

export default router;
