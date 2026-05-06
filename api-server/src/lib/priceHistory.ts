import { holdingsTable, priceHistoryTable } from "../../../lib/db/src/index.ts";

type DbLike = {
  insert: (table: typeof priceHistoryTable) => {
    values: (value: typeof priceHistoryTable.$inferInsert | Array<typeof priceHistoryTable.$inferInsert>) => unknown;
  };
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function usesManualPortfolioValue(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized !== "stock" && normalized !== "gold" && normalized !== "crypto";
}

function resolveCurrentValue(input: { type: string; quantity: number | null; priceOrValue: number }): number {
  return usesManualPortfolioValue(input.type)
    ? input.priceOrValue
    : (input.quantity ?? 0) * input.priceOrValue;
}

export function buildPriceHistoryRow(input: {
  assetCode: string;
  assetType: string;
  priceOrValue: number;
  quantity?: number | null;
  currentValue?: number | null;
  source: string;
  note?: string | null;
  priceAt?: Date;
}): typeof priceHistoryTable.$inferInsert {
  const quantity = input.quantity ?? null;
  const currentValue = input.currentValue ?? resolveCurrentValue({
    type: input.assetType,
    quantity,
    priceOrValue: input.priceOrValue,
  });

  return {
    priceAt: input.priceAt ?? new Date(),
    assetCode: input.assetCode.trim().toUpperCase(),
    assetType: input.assetType.trim().toLowerCase(),
    priceOrValue: String(input.priceOrValue),
    quantity: quantity != null ? String(quantity) : null,
    currentValue: String(currentValue),
    source: input.source,
    note: input.note ?? null,
    updatedAt: new Date(),
  };
}

export function buildPriceHistoryRowFromHolding(input: {
  holding: typeof holdingsTable.$inferSelect;
  priceOrValue?: number | null;
  source: string;
  note?: string | null;
  priceAt?: Date;
}): typeof priceHistoryTable.$inferInsert | null {
  const priceOrValue = input.priceOrValue ?? toNumber(input.holding.manualPrice);
  if (priceOrValue == null) return null;

  return buildPriceHistoryRow({
    assetCode: input.holding.symbol,
    assetType: input.holding.type,
    priceOrValue,
    quantity: toNumber(input.holding.quantity),
    source: input.source,
    note: input.note,
    priceAt: input.priceAt,
  });
}

export async function insertPriceHistoryRows(
  dbOrTx: DbLike,
  rows: Array<typeof priceHistoryTable.$inferInsert | null | undefined>,
): Promise<void> {
  const values = rows.filter((row): row is typeof priceHistoryTable.$inferInsert => row != null);
  if (!values.length) return;
  await dbOrTx.insert(priceHistoryTable).values(values);
}

export function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return { start, end };
}
