export type CashflowData = {
  year: number;
  income: number;
  expense: number;
  interest: number;
  savingsRate: number | null;
  interestBurden: number | null;
};

export type TotalAssetData = {
  year: number;
  totalAsset: number;
  netAsset: number;
  debt: number;
  debtRatio: number | null;
};

export const CASHFLOW_SOURCE_SHEET = "Function";

export function parseNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.,-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function findColIdx(headers: unknown[], names: string[]): number {
  const normalizedNames = names.map((n) => n.normalize("NFKC").toLowerCase());
  return headers.findIndex((h) =>
    normalizedNames.includes(String(h ?? "").normalize("NFKC").trim().toLowerCase())
  );
}

export async function fetchCashflowData(): Promise<CashflowData | null> {
  const res = await fetch(`/api/excel/sheet?name=${encodeURIComponent(CASHFLOW_SOURCE_SHEET)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const rows: unknown[][] = data?.rows ?? [];
  if (rows.length < 2) return null;

  const headers = rows[0];
  const yearCol = findColIdx(headers, ["year", "năm"]);
  const incomeCol = findColIdx(headers, ["income", "thu nhập", "thu nhap"]);
  const expenseCol = findColIdx(headers, ["tiêu dùng", "tieu dung", "expense", "tiêu dụng"]);
  const interestCol = findColIdx(headers, ["total interest", "interest"]);
  if (yearCol < 0 || incomeCol < 0) return null;

  const currentYear = new Date().getFullYear();
  const targetRow =
    rows.slice(1).find((r) => Number(r[yearCol]) === currentYear) ??
    rows.slice(1).findLast((r) => Number(r[yearCol]) <= currentYear) ??
    rows[1];

  if (!targetRow) return null;
  const year = Number(targetRow[yearCol]);
  const income = parseNum(targetRow[incomeCol]);
  const expense = Math.abs(parseNum(expenseCol >= 0 ? targetRow[expenseCol] : 0));
  const interest = Math.abs(parseNum(interestCol >= 0 ? targetRow[interestCol] : 0));
  const savings = income - expense;

  return {
    year,
    income,
    expense,
    interest,
    savingsRate: income > 0 ? savings / income : null,
    interestBurden: income > 0 ? interest / income : null,
  };
}

export type TotalAssetRow = {
  year: number;
  totalAsset: number;
  netAsset: number;
  debt: number;
};

export async function fetchTotalAssetRows(): Promise<TotalAssetRow[]> {
  const res = await fetch("/api/excel/sheet?name=Total Asset");
  if (!res.ok) return [];
  const data = await res.json();
  const rows: unknown[][] = data?.rows ?? [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  const yearCol  = findColIdx(headers, ["year", "năm"]);
  const totalCol = findColIdx(headers, ["net asset", "tổng tài sản", "tong tai san"]);
  const netCol   = findColIdx(headers, ["asset", "tài sản ròng", "tai san rong"]);
  const debtCol  = findColIdx(headers, ["total loan", "loan", "nợ", "no"]);
  if (yearCol < 0) return [];

  return rows
    .slice(1)
    .map((r) => ({
      year:       Number(r[yearCol]),
      totalAsset: parseNum(totalCol >= 0 ? r[totalCol] : 0),
      netAsset:   netCol >= 0 ? parseNum(r[netCol]) : 0,
      debt:       Math.abs(parseNum(debtCol >= 0 ? r[debtCol] : 0)),
    }))
    .filter((r) => r.year > 1900 && r.year < 2200);
}

export async function fetchTotalAssetData(): Promise<TotalAssetData | null> {
  const res = await fetch("/api/excel/sheet?name=Total Asset");
  if (!res.ok) return null;
  const data = await res.json();
  const rows: unknown[][] = data?.rows ?? [];
  if (rows.length < 2) return null;

  const headers = rows[0];
  const yearCol  = findColIdx(headers, ["year", "năm"]);
  // Sheet column "Net asset" = gross total; "Asset" = gross minus debt (actual net)
  const totalCol = findColIdx(headers, ["net asset", "tổng tài sản", "tong tai san"]);
  const netCol   = findColIdx(headers, ["asset", "tài sản ròng", "tai san rong"]);
  const debtCol  = findColIdx(headers, ["total loan", "loan", "nợ", "no"]);
  if (yearCol < 0) return null;

  const currentYear = new Date().getFullYear();
  const targetRow =
    rows.slice(1).find((r) => Number(r[yearCol]) === currentYear) ??
    rows.slice(1).findLast((r) => Number(r[yearCol]) <= currentYear) ??
    rows[1];

  if (!targetRow) return null;
  const year = Number(targetRow[yearCol]);
  const totalAsset = parseNum(targetRow[totalCol]);
  const netAsset = netCol >= 0 ? parseNum(targetRow[netCol]) : totalAsset;
  const debt = Math.abs(parseNum(debtCol >= 0 ? targetRow[debtCol] : 0));

  return {
    year,
    totalAsset,
    netAsset,
    debt,
    debtRatio: totalAsset > 0 ? debt / totalAsset : null,
  };
}
