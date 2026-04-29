import type { HoldingItem } from "@/pages/assets/types";

export const CURRENT_ASSET_SHEET = "Current asset";

const FINANCIAL_TYPES = new Set(["financial"]);
const REAL_ESTATE_TYPES = new Set(["real_estate", "realestate", "real estate"]);

async function readJsonSafe(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    throw new Error(text?.slice(0, 120) || "Invalid response.");
  }
  return res.json();
}

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function normalizeWealthType(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "—" || raw === "-") return "other";
  return raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, "_");
}

function parseAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw || raw === "—" || raw === "-") return 0;
  const normalized = raw.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findColumn(headers: unknown[], aliases: string[]) {
  return headers.findIndex((header) => aliases.includes(normalizeHeader(header)));
}

function findColumnByPriority(headers: unknown[], aliases: string[]) {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.findIndex((header) => header === alias);
    if (index >= 0) return index;
  }
  return -1;
}

export function parseCurrentAssetRows(rows: Array<Array<string | number>>): HoldingItem[] {
  const headerIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes("asset") && headers.includes("type");
  });

  if (headerIndex < 0) return [];

  const headers = rows[headerIndex] ?? [];
  const assetCol = findColumn(headers, ["asset", "tai san", "tài sản"]);
  const typeCol = findColumn(headers, ["type", "loai", "loại"]);
  const valueCol = findColumnByPriority(headers, [
    "current asset",
    "current value",
    "current",
    "value",
    "usd",
    "current price",
  ]);

  if (assetCol < 0 || typeCol < 0 || valueCol < 0) return [];

  return rows
    .slice(headerIndex + 1)
    .map((row, index): HoldingItem | null => {
      const symbol = String(row[assetCol] ?? "").trim();
      const currentValue = parseAmount(row[valueCol]);
      if (!symbol || symbol === "—" || currentValue <= 0) return null;

      return {
        id: index + 1,
        symbol,
        type: normalizeWealthType(row[typeCol]),
        quantity: 1,
        currentPrice: currentValue,
        currentValue,
        change: null,
        changePercent: null,
        manualPrice: currentValue,
      } satisfies HoldingItem;
    })
    .filter((holding): holding is HoldingItem => holding !== null);
}

async function fetchPortfolioInvestmentHoldings(): Promise<HoldingItem[]> {
  const res = await fetch("/api/portfolio/summary");
  if (!res.ok) return [];
  const summary = await res.json().catch(() => null) as { holdings?: HoldingItem[] } | null;
  return (summary?.holdings ?? []).filter((holding) => {
    const type = String(holding.type ?? "").toLowerCase().trim();
    return !REAL_ESTATE_TYPES.has(type) && (holding.currentValue ?? 0) > 0;
  });
}

export async function fetchFinancialDetailHoldings(): Promise<HoldingItem[]> {
  return fetchPortfolioInvestmentHoldings();
}

export async function fetchWealthAllocationHoldings() {
  const [sheetRes, investmentHoldings] = await Promise.all([
    fetch(`/api/excel/sheet?name=${encodeURIComponent(CURRENT_ASSET_SHEET)}`),
    fetchPortfolioInvestmentHoldings(),
  ]);

  const sheetData = await readJsonSafe(sheetRes);
  if (!sheetRes.ok) throw new Error(sheetData?.error || "Unable to load wealth allocation sheet.");
  const rows = Array.isArray(sheetData?.rows) ? sheetData.rows : [];

  const sheetHoldings = parseCurrentAssetRows(rows).filter((holding) => !FINANCIAL_TYPES.has(holding.type));

  if (investmentHoldings.length === 0) return sheetHoldings;

  const financialTotal = investmentHoldings.reduce((sum, h) => sum + (h.currentValue ?? 0), 0);
  const financialHolding: HoldingItem = {
    id: -1,
    symbol: "Financial",
    type: "financial",
    quantity: 1,
    currentPrice: financialTotal,
    currentValue: financialTotal,
    change: null,
    changePercent: null,
    manualPrice: financialTotal,
  };

  return [...sheetHoldings, financialHolding];
}
