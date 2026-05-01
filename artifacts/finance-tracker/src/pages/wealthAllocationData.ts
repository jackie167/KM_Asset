import type { HoldingItem } from "@/pages/assets/types";

export const CURRENT_ASSET_SHEET = "Current asset";

const FINANCIAL_TYPES = new Set(["financial"]);
const REAL_ESTATE_TYPES = new Set(["real_estate", "realestate", "real estate"]);
const ASSET_RETURN_SETTING_KEY = "asset_forecast_asset_returns";

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

function parsePercentInput(value: unknown): number {
  const cleaned = String(value ?? "").trim().replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fixedAssetReturnKey(holding: HoldingItem) {
  return `${holding.type.trim().toLowerCase()}::${holding.symbol.trim().toUpperCase()}`;
}

function elapsedMonthsFromBaseYear(baseYear = 2026, now = new Date()) {
  return Math.max(0, (now.getFullYear() - baseYear) * 12 + now.getMonth());
}

async function fetchAssetReturnInputs(): Promise<Record<string, string>> {
  const localValue = localStorage.getItem(ASSET_RETURN_SETTING_KEY);
  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(ASSET_RETURN_SETTING_KEY)}`);
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.value === "string" && data.value.trim()) return JSON.parse(data.value);
    }
  } catch { /* fall back to localStorage */ }

  try {
    return localValue ? JSON.parse(localValue) : {};
  } catch {
    return {};
  }
}

function applyMonthlyForecastValue(holding: HoldingItem, returnInputs: Record<string, string>) {
  const baseValue = holding.currentValue ?? 0;
  const annualRate = parsePercentInput(returnInputs[fixedAssetReturnKey(holding)] ?? 0) / 100;
  const months = elapsedMonthsFromBaseYear(2026);
  const currentValue = baseValue * ((1 + annualRate) ** (months / 12));
  return {
    ...holding,
    currentPrice: currentValue,
    currentValue,
    manualPrice: currentValue,
  };
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

export type BaseAsset = {
  id: number;
  assetType: string;
  symbol: string;
  baseYear: number;
  baseValue: number;
  assumedReturnRate: number;
  note: string | null;
};

function baseAssetToHolding(asset: BaseAsset): HoldingItem {
  return {
    id: asset.id,
    symbol: asset.symbol,
    type: normalizeWealthType(asset.assetType),
    quantity: 1,
    currentPrice: asset.baseValue,
    currentValue: asset.baseValue,
    change: null,
    changePercent: null,
    manualPrice: asset.baseValue,
  };
}

async function importBaseAssets(holdings: HoldingItem[]): Promise<BaseAsset[]> {
  const res = await fetch("/api/base-assets/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replace: false,
      assets: holdings.map((holding) => ({
        assetType: holding.type,
        symbol: holding.symbol,
        baseYear: 2026,
        baseValue: holding.currentValue ?? 0,
        assumedReturnRate: 0,
        note: "Imported from Current asset sheet",
      })),
    }),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchBaseAssetHoldings(): Promise<HoldingItem[]> {
  const dbRes = await fetch("/api/base-assets");
  if (dbRes.ok) {
    const baseAssets = await dbRes.json() as BaseAsset[];
    if (baseAssets.length > 0) return baseAssets.map(baseAssetToHolding);
  }

  const sheetRes = await fetch(`/api/excel/sheet?name=${encodeURIComponent(CURRENT_ASSET_SHEET)}`);
  const sheetData = await readJsonSafe(sheetRes);
  if (!sheetRes.ok) throw new Error(sheetData?.error || "Unable to load base assets.");
  const parsed = parseCurrentAssetRows(Array.isArray(sheetData?.rows) ? sheetData.rows : []);
  if (parsed.length === 0) return [];

  const imported = await importBaseAssets(parsed).catch(() => []);
  return imported.length > 0 ? imported.map(baseAssetToHolding) : parsed;
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
  const [baseHoldings, investmentHoldings, returnInputs] = await Promise.all([
    fetchBaseAssetHoldings(),
    fetchPortfolioInvestmentHoldings(),
    fetchAssetReturnInputs(),
  ]);

  const sheetHoldings = baseHoldings
    .filter((holding) => !FINANCIAL_TYPES.has(holding.type))
    .map((holding) => applyMonthlyForecastValue(holding, returnInputs));

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
