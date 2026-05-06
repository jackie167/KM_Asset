import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  db,
  holdingsTable,
  portfolioCashFlowsTable,
  priceHistoryTable,
  transactionsTable,
} from "../../../lib/db/src/index.ts";
import { eq } from "drizzle-orm";
import { ImportHoldingsResponse } from "../../../lib/api-zod/src/index.ts";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
    ];
    const extOk = /\.(csv|xls|xlsx)$/i.test(file.originalname);
    if (allowed.includes(file.mimetype) || extOk) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

interface RawRow {
  symbol?: string;
  asset_code?: string;
  asset?: string;
  type?: string;
  asset_type?: string;
  quantity?: string | number;
  total_value?: string | number;
  current_price?: string | number;
  current_value?: string | number;
  cost_of_capital?: string | number;
  interest?: string | number;
  [key: string]: unknown;
}

function inferType(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.startsWith("SJC")) return "gold";
  const CRYPTO = ["BTC","ETH","XRP","BNB","SOL","ADA","DOT","AVAX","LINK","MATIC","DOGE","USDT","USDC","PAXG","DAI","LTC","BCH","ATOM","UNI","AAVE"];
  if (CRYPTO.includes(s)) return "crypto";
  return "stock";
}

function parseVNNumber(v: string | number | undefined | null): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return isNaN(v) ? undefined : v;
  const s = String(v).trim().replace(/\s/g, "");
  if (!s) return undefined;

  // Both dot and comma present → dot=thousand sep, comma=decimal (e.g. "1.000,50")
  if (s.includes(",") && s.includes(".")) {
    const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    return isNaN(n) ? undefined : n;
  }

  // Only comma (no dot) → comma is decimal separator (e.g. "0,091" VN style)
  if (s.includes(",")) {
    const n = parseFloat(s.replace(",", "."));
    return isNaN(n) ? undefined : n;
  }

  // Only dot(s):
  if (s.includes(".")) {
    const parts = s.split(".");
    const dotCount = parts.length - 1;

    // Multiple dots → all are thousand separators (e.g. "1.000.000")
    if (dotCount > 1) {
      const n = parseFloat(parts.join(""));
      return isNaN(n) ? undefined : n;
    }

    // Single dot: check if it's a thousand separator or decimal point
    const afterDot = parts[1];
    const beforeDot = parts[0];
    // Thousand separator: non-zero integer part + exactly 3 digits after dot (e.g. "1.000", "83.700")
    // Decimal: starts with "0" (e.g. "0.091"), or afterDot ≠ 3 digits
    if (beforeDot !== "0" && afterDot.length === 3) {
      // Likely VN thousand separator (e.g. "83.700" = 83700)
      const n = parseFloat(beforeDot + afterDot);
      return isNaN(n) ? undefined : n;
    }

    // Otherwise treat as decimal (e.g. "0.0913", "3.9", "1.5")
    return parseFloat(s);
  }

  // No dot, no comma → plain integer
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

function parseCsvLine(line: string, separator: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      const next = line[i + 1];
      if (inQuotes && next === "\"") {
        cur += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === separator && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvRows(text: string, separator: string): RawRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0], separator).map((h) => h.trim().toLowerCase());
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i], separator);
    const row: RawRow = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (!key) continue;
      row[key] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

interface NormalizedRow {
  symbol: string;
  type?: string;
  quantity: number;
  manualPrice?: number | null;
  costOfCapital?: number | null;
  interest?: number | null;
}

type SyncInvestmentRow = {
  symbol: string;
  type: string;
  quantity: number;
  manualPrice: number | null;
  costOfCapital: number | null;
  interest: number | null;
};

type SyncTransactionRow = {
  side: string;
  origin: string;
  fundingSource: string;
  assetType: string;
  symbol: string;
  quantity: number;
  totalValue: number;
  unitPrice: number | null;
  grossAmount: number | null;
  fee: number | null;
  tax: number | null;
  netAmount: number | null;
  realizedInterest: number | null;
  note: string | null;
  status: string;
  executedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type SyncCashFlowRow = {
  kind: string;
  account: string;
  origin: string;
  amount: number;
  note: string | null;
  source: string;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type SyncPriceHistoryRow = {
  priceAt: Date;
  assetCode: string;
  assetType: string;
  priceOrValue: number;
  quantity: number | null;
  currentValue: number | null;
  source: string;
  note: string | null;
  updatedAt: Date;
};

function normalizeRow(raw: RawRow): NormalizedRow | null {
  const symbol = String(raw.symbol ?? raw.asset_code ?? raw.asset ?? "").trim().toUpperCase();
  if (!symbol) return null;

  const quantity = parseVNNumber(raw.quantity);
  if (quantity == null || quantity <= 0) return null;

  const typeRaw = String(raw.type ?? raw.asset_type ?? "").trim().toLowerCase();
  const type = typeRaw || undefined;
  const resolvedType = normalizeInvestmentType(type ?? inferType(symbol));
  const hasInput = (value: unknown) => value != null && String(value).trim() !== "";
  const hasCurrentInput = hasInput(raw.current_price) || hasInput(raw.current_value) || hasInput(raw.total_value);
  const hasCostInput = hasInput(raw.cost_of_capital);
  const hasInterestInput = hasInput(raw.interest);
  const currentPrice = parseVNNumber(raw.current_price);
  const currentValue = parseVNNumber(raw.current_value ?? raw.total_value);
  const manualPrice = shouldSyncManualPrice(resolvedType)
    ? hasCurrentInput ? currentPrice ?? (currentValue != null ? currentValue / quantity : null) : undefined
    : undefined;

  return {
    symbol,
    type,
    quantity,
    manualPrice,
    costOfCapital: hasCostInput ? parseVNNumber(raw.cost_of_capital) ?? null : undefined,
    interest: hasInterestInput ? parseVNNumber(raw.interest) ?? null : undefined,
  };
}

function normalizeHeaderName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeInvestmentType(rawType: unknown): string {
  const normalized = normalizeHeaderName(rawType);
  const aliases: Record<string, string> = {
    stock: "stock",
    equity: "stock",
    co_phieu: "stock",
    bond: "bond",
    trai_phieu: "bond",
    fund: "fund",
    funds: "fund",
    quy: "fund",
    quy_mo: "fund",
    ccq: "fund",
    crypto: "crypto",
    tien_ma_hoa: "crypto",
    gold: "gold",
    vang: "gold",
    cash: "cash",
    tien_mat: "cash",
    real_estate: "real_estate",
    bat_dong_san: "real_estate",
    other: "other",
  };
  return aliases[normalized] ?? normalized ?? "other";
}

function deriveInvestmentGroup(assetType: string): string {
  const normalized = assetType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "real_estate" || normalized === "realestate" ? "real_estate" : "financial";
}

function shouldSyncManualPrice(type: string): boolean {
  return type !== "stock" && type !== "gold" && type !== "crypto";
}

function parseDateCell(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H ?? 0, parsed.M ?? 0, parsed.S ?? 0));
  }
  const text = String(value).trim();
  if (!text) return null;
  const vnDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (vnDate) {
    const day = Number(vnDate[1]);
    const month = Number(vnDate[2]);
    const rawYear = Number(vnDate[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const date = new Date(year, month - 1, day, Number(vnDate[4] ?? 0), Number(vnDate[5] ?? 0), Number(vnDate[6] ?? 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sheetRows(workbook: XLSX.WorkBook, name: string): unknown[][] {
  const sheet = workbook.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true }) as unknown[][];
}

function headerMap(rows: unknown[][]): { headerIndex: number; headers: string[] } | null {
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map(normalizeHeaderName);
    return normalized.some((value) => value === "asset_code" || value === "symbol" || value === "asset" || value === "side" || value === "kind");
  });
  if (headerIndex === -1) return null;
  return { headerIndex, headers: rows[headerIndex].map(normalizeHeaderName) };
}

function col(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function stringCell(row: unknown[], index: number, fallback = ""): string {
  if (index < 0) return fallback;
  const value = String(row[index] ?? "").trim();
  return value || fallback;
}

function numCell(row: unknown[], index: number): number | null {
  if (index < 0) return null;
  return parseVNNumber(row[index] as string | number | null) ?? null;
}

function dateCell(row: unknown[], index: number, fallback = new Date()): Date {
  if (index < 0) return fallback;
  return parseDateCell(row[index]) ?? fallback;
}

function parseSyncInvestmentRows(workbook: XLSX.WorkBook): SyncInvestmentRow[] {
  const rows = sheetRows(workbook, "Investment");
  const meta = headerMap(rows);
  if (!meta) return [];
  const assetIndex = col(meta.headers, ["asset_code", "symbol", "asset", "tai_san"]);
  const typeIndex = col(meta.headers, ["asset_type", "type", "loai"]);
  const quantityIndex = col(meta.headers, ["quantity", "qty", "ql", "sl"]);
  const currentPriceIndex = col(meta.headers, ["current_price", "price", "price_or_value"]);
  const currentValueIndex = col(meta.headers, ["current_value", "current"]);
  const costIndex = col(meta.headers, ["cost_of_capital", "cost_basis", "cost"]);
  const interestIndex = col(meta.headers, ["interest"]);
  if (assetIndex < 0 || quantityIndex < 0) return [];

  return rows.slice(meta.headerIndex + 1).flatMap((row) => {
    const symbol = stringCell(row, assetIndex).toUpperCase();
    if (!symbol) return [];
    const type = normalizeInvestmentType(stringCell(row, typeIndex, inferType(symbol)));
    let quantity = numCell(row, quantityIndex);
    const currentPrice = numCell(row, currentPriceIndex);
    const currentValue = numCell(row, currentValueIndex);
    if ((quantity == null || quantity <= 0) && shouldSyncManualPrice(type) && currentValue != null && currentValue > 0) quantity = 1;
    if (quantity == null || quantity <= 0) return [];
    const derivedPrice = currentPrice ?? (currentValue != null ? currentValue / quantity : null);
    return [{
      symbol,
      type,
      quantity,
      manualPrice: shouldSyncManualPrice(type) ? derivedPrice : null,
      costOfCapital: numCell(row, costIndex),
      interest: numCell(row, interestIndex),
    }];
  });
}

function parseSyncTransactionRows(workbook: XLSX.WorkBook): SyncTransactionRow[] {
  const rows = sheetRows(workbook, "Transactions");
  const meta = headerMap(rows);
  if (!meta) return [];
  const sideIndex = col(meta.headers, ["side"]);
  const assetIndex = col(meta.headers, ["asset_code", "symbol", "asset", "tai_san"]);
  const typeIndex = col(meta.headers, ["asset_type", "type", "loai"]);
  const quantityIndex = col(meta.headers, ["quantity", "qty", "ql", "sl"]);
  const priceIndex = col(meta.headers, ["price", "unit_price", "gia"]);
  const grossIndex = col(meta.headers, ["gross_amount"]);
  const feeIndex = col(meta.headers, ["fee"]);
  const taxIndex = col(meta.headers, ["tax"]);
  const netIndex = col(meta.headers, ["net_amount", "total_value", "total", "tong_gia_tri"]);
  const fundingIndex = col(meta.headers, ["funding_source", "source", "nguon_tien"]);
  const realizedIndex = col(meta.headers, ["realized_pnl", "realized_interest", "interest"]);
  const noteIndex = col(meta.headers, ["note", "ghi_chu"]);
  const statusIndex = col(meta.headers, ["status"]);
  const originIndex = col(meta.headers, ["origin"]);
  const dateIndex = col(meta.headers, ["date", "executed_at", "ngay"]);
  const createdIndex = col(meta.headers, ["created_at"]);
  const updatedIndex = col(meta.headers, ["updated_at"]);
  if (sideIndex < 0 || assetIndex < 0 || typeIndex < 0 || quantityIndex < 0 || netIndex < 0) return [];

  return rows.slice(meta.headerIndex + 1).flatMap((row) => {
    const rawSide = stringCell(row, sideIndex).toLowerCase();
    const side = rawSide === "mua" ? "buy" : rawSide === "ban" || rawSide === "bán" ? "sell" : rawSide;
    if (side !== "buy" && side !== "sell") return [];
    const symbol = stringCell(row, assetIndex).toUpperCase();
    const quantity = numCell(row, quantityIndex);
    const netAmount = numCell(row, netIndex);
    if (!symbol || quantity == null || quantity <= 0 || netAmount == null || netAmount <= 0) return [];
    const createdAt = dateCell(row, createdIndex);
    return [{
      side,
      origin: stringCell(row, originIndex, "excel_sync"),
      fundingSource: stringCell(row, fundingIndex, "CASH").toUpperCase(),
      assetType: normalizeInvestmentType(stringCell(row, typeIndex)),
      symbol,
      quantity,
      totalValue: netAmount,
      unitPrice: numCell(row, priceIndex) ?? netAmount / quantity,
      grossAmount: numCell(row, grossIndex),
      fee: numCell(row, feeIndex) ?? 0,
      tax: numCell(row, taxIndex) ?? 0,
      netAmount,
      realizedInterest: numCell(row, realizedIndex) ?? 0,
      note: stringCell(row, noteIndex) || null,
      status: stringCell(row, statusIndex, "applied"),
      executedAt: dateCell(row, dateIndex),
      createdAt,
      updatedAt: dateCell(row, updatedIndex, createdAt),
    }];
  });
}

function parseSyncCashFlowRows(workbook: XLSX.WorkBook): SyncCashFlowRow[] {
  const rows = sheetRows(workbook, "CashFlows");
  const meta = headerMap(rows);
  if (!meta) return [];
  const dateIndex = col(meta.headers, ["date", "occurred_at"]);
  const kindIndex = col(meta.headers, ["kind"]);
  const accountIndex = col(meta.headers, ["account"]);
  const amountIndex = col(meta.headers, ["amount"]);
  const sourceIndex = col(meta.headers, ["source"]);
  const noteIndex = col(meta.headers, ["note"]);
  const originIndex = col(meta.headers, ["origin"]);
  const createdIndex = col(meta.headers, ["created_at"]);
  const updatedIndex = col(meta.headers, ["updated_at"]);
  if (kindIndex < 0 || amountIndex < 0) return [];

  return rows.slice(meta.headerIndex + 1).flatMap((row) => {
    const amount = numCell(row, amountIndex);
    if (amount == null || amount <= 0) return [];
    const createdAt = dateCell(row, createdIndex);
    return [{
      kind: stringCell(row, kindIndex, "contribution"),
      account: stringCell(row, accountIndex, "CASH"),
      origin: stringCell(row, originIndex, "import_sync"),
      amount,
      note: stringCell(row, noteIndex) || null,
      source: stringCell(row, sourceIndex, "import_sync"),
      occurredAt: dateCell(row, dateIndex),
      createdAt,
      updatedAt: dateCell(row, updatedIndex, createdAt),
    }];
  });
}

function parseSyncPriceHistoryRows(workbook: XLSX.WorkBook): SyncPriceHistoryRow[] {
  const rows = sheetRows(workbook, "PriceHistory");
  const meta = headerMap(rows);
  if (!meta) return [];
  const dateIndex = col(meta.headers, ["date"]);
  const assetIndex = col(meta.headers, ["asset_code", "symbol", "asset"]);
  const typeIndex = col(meta.headers, ["asset_type", "type"]);
  const priceIndex = col(meta.headers, ["price_or_value", "current_price", "price"]);
  const quantityIndex = col(meta.headers, ["quantity"]);
  const currentValueIndex = col(meta.headers, ["current_value"]);
  const sourceIndex = col(meta.headers, ["source"]);
  const noteIndex = col(meta.headers, ["note"]);
  const updatedIndex = col(meta.headers, ["updated_at"]);
  if (assetIndex < 0 || priceIndex < 0) return [];

  return rows.slice(meta.headerIndex + 1).flatMap((row) => {
    const assetCode = stringCell(row, assetIndex).toUpperCase();
    const priceOrValue = numCell(row, priceIndex);
    if (!assetCode || priceOrValue == null) return [];
    return [{
      priceAt: dateCell(row, dateIndex),
      assetCode,
      assetType: normalizeInvestmentType(stringCell(row, typeIndex)),
      priceOrValue,
      quantity: numCell(row, quantityIndex),
      currentValue: numCell(row, currentValueIndex),
      source: stringCell(row, sourceIndex, "import_sync"),
      note: stringCell(row, noteIndex) || null,
      updatedAt: dateCell(row, updatedIndex),
    }];
  });
}

function isInvestmentSyncWorkbook(workbook: XLSX.WorkBook): boolean {
  if (!workbook.Sheets["Investment"]) return false;
  const metaRows = sheetRows(workbook, "Meta");
  const hasSchema = metaRows.some((row) => row.some((cell) => String(cell ?? "").trim() === "investment_sync_v1"));
  if (hasSchema) return true;
  const investmentRows = sheetRows(workbook, "Investment");
  const meta = headerMap(investmentRows);
  return Boolean(meta && meta.headers.includes("asset_code") && meta.headers.includes("cost_of_capital"));
}

async function importInvestmentSyncWorkbook(workbook: XLSX.WorkBook) {
  const investmentRows = parseSyncInvestmentRows(workbook);
  if (investmentRows.length === 0) throw new Error("Investment sync workbook không có dòng Investment hợp lệ.");

  const transactionRows = parseSyncTransactionRows(workbook);
  const cashFlowRows = parseSyncCashFlowRows(workbook);
  const priceHistoryRows = parseSyncPriceHistoryRows(workbook);

  return db.transaction(async (tx) => {
    const existingHoldings = await tx.select().from(holdingsTable);
    const existingBySymbol = new Map(existingHoldings.map((holding) => [holding.symbol.toUpperCase(), holding]));
    const syncedSymbols = new Set(investmentRows.map((row) => row.symbol));
    const importedHoldings: typeof holdingsTable.$inferSelect[] = [];

    for (const row of investmentRows) {
      const existing = existingBySymbol.get(row.symbol);
      const values = {
        investmentGroup: deriveInvestmentGroup(row.type),
        type: row.type,
        quantity: String(row.quantity),
        manualPrice: row.manualPrice != null ? String(row.manualPrice) : null,
        costOfCapital: row.costOfCapital != null ? String(row.costOfCapital) : null,
        interest: row.interest != null ? String(row.interest) : null,
        updatedAt: new Date(),
      };
      if (existing) {
        const [updated] = await tx.update(holdingsTable).set(values).where(eq(holdingsTable.id, existing.id)).returning();
        importedHoldings.push(updated);
      } else {
        const [created] = await tx.insert(holdingsTable).values({ symbol: row.symbol, ...values }).returning();
        importedHoldings.push(created);
      }
    }

    let removed = 0;
    for (const holding of existingHoldings) {
      if (syncedSymbols.has(holding.symbol.toUpperCase())) continue;
      await tx.delete(holdingsTable).where(eq(holdingsTable.id, holding.id));
      removed += 1;
    }

    await tx.delete(transactionsTable);
    if (transactionRows.length) {
      await tx.insert(transactionsTable).values(transactionRows.map((row) => ({
        side: row.side,
        origin: row.origin,
        fundingSource: row.fundingSource,
        assetType: row.assetType,
        symbol: row.symbol,
        quantity: String(row.quantity),
        totalValue: String(row.totalValue),
        unitPrice: row.unitPrice != null ? String(row.unitPrice) : null,
        grossAmount: row.grossAmount != null ? String(row.grossAmount) : null,
        fee: row.fee != null ? String(row.fee) : null,
        tax: row.tax != null ? String(row.tax) : null,
        netAmount: row.netAmount != null ? String(row.netAmount) : null,
        realizedInterest: row.realizedInterest != null ? String(row.realizedInterest) : null,
        note: row.note,
        status: row.status,
        executedAt: row.executedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })));
    }

    await tx.delete(portfolioCashFlowsTable);
    if (cashFlowRows.length) {
      await tx.insert(portfolioCashFlowsTable).values(cashFlowRows.map((row) => ({
        kind: row.kind,
        account: row.account,
        origin: row.origin,
        amount: String(row.amount),
        note: row.note,
        source: row.source,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })));
    }

    await tx.delete(priceHistoryTable);
    if (priceHistoryRows.length) {
      await tx.insert(priceHistoryTable).values(priceHistoryRows.map((row) => ({
        priceAt: row.priceAt,
        assetCode: row.assetCode,
        assetType: row.assetType,
        priceOrValue: String(row.priceOrValue),
        quantity: row.quantity != null ? String(row.quantity) : null,
        currentValue: row.currentValue != null ? String(row.currentValue) : null,
        source: row.source,
        note: row.note,
        updatedAt: row.updatedAt,
      })));
    }

    return {
      importedHoldings,
      removed,
      transactionRows: transactionRows.length,
      cashFlowRows: cashFlowRows.length,
      priceHistoryRows: priceHistoryRows.length,
    };
  });
}

router.post("/holdings/import", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  console.log(`[Import] Processing file: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);

  let rows: RawRow[];

  try {
    const isCsv = req.file.originalname.toLowerCase().endsWith(".csv")
      || req.file.mimetype.includes("csv")
      || req.file.mimetype === "text/plain";

    if (isCsv) {
      const text = req.file.buffer.toString("utf8");
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const commaCount = (firstLine.match(/,/g) || []).length;
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      const separator = semicolonCount >= commaCount ? ";" : ",";
      rows = parseCsvRows(text, separator);
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      if (isInvestmentSyncWorkbook(workbook)) {
        const result = await importInvestmentSyncWorkbook(workbook);
        res.json(
          ImportHoldingsResponse.parse({
            imported: result.importedHoldings.length,
            skipped: result.removed,
            errors: [],
            holdings: result.importedHoldings.map((h) => ({
              ...h,
              quantity: parseFloat(String(h.quantity)),
              manualPrice: h.manualPrice != null ? parseFloat(String(h.manualPrice)) : null,
              costOfCapital: h.costOfCapital != null ? parseFloat(String(h.costOfCapital)) : null,
              interest: h.interest != null ? parseFloat(String(h.interest)) : null,
            })),
          })
        );
        return;
      }

      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: "" });
    }
    const sheetName = isCsv ? "CSV" : "Sheet1";
    console.log(`[Import] Parsed ${rows.length} row(s) from sheet "${sheetName}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Import] Failed to parse file: ${msg}`);
    res.status(400).json({ error: `Could not parse file: ${msg}` });
    return;
  }

  if (rows.length === 0) {
    res.status(400).json({ error: "File is empty or has no data rows" });
    return;
  }

  // Load all existing holdings once
  const existingHoldings = await db.select().from(holdingsTable);
  const bySymbol = new Map(existingHoldings.map((h) => [h.symbol.toUpperCase(), h]));

  const errors: string[] = [];
  const imported: typeof holdingsTable.$inferSelect[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const normalized = normalizeRow(rows[i]);
    if (!normalized) {
      errors.push(`Dòng ${i + 2}: thiếu hoặc sai dữ liệu — ${JSON.stringify(rows[i])}`);
      skipped++;
      continue;
    }

    const { symbol, type, quantity, manualPrice, costOfCapital, interest } = normalized;

    try {
      const existing = bySymbol.get(symbol);

      if (existing) {
        const resolvedType = type || existing.type;
        const updateData: Partial<typeof holdingsTable.$inferInsert> & { updatedAt: Date } = {
          investmentGroup: deriveInvestmentGroup(resolvedType),
          quantity: String(quantity),
          ...(manualPrice !== undefined ? { manualPrice: manualPrice != null ? String(manualPrice) : null } : {}),
          ...(costOfCapital !== undefined ? { costOfCapital: costOfCapital != null ? String(costOfCapital) : null } : {}),
          ...(interest !== undefined ? { interest: interest != null ? String(interest) : null } : {}),
          updatedAt: new Date(),
        };

        const [updated] = await db
          .update(holdingsTable)
          .set(updateData)
          .where(eq(holdingsTable.id, existing.id))
          .returning();
        imported.push(updated);
        console.log(`[Import] Updated ${existing.type} ${symbol}: qty=${quantity}`);
      } else {
        // New holding — use provided type or infer; do NOT import total/manual price
        const resolvedType = type || inferType(symbol);

        const [created] = await db
          .insert(holdingsTable)
          .values({
            type: resolvedType,
            investmentGroup: deriveInvestmentGroup(resolvedType),
            symbol,
            quantity: String(quantity),
            manualPrice: manualPrice != null ? String(manualPrice) : null,
            costOfCapital: costOfCapital != null ? String(costOfCapital) : null,
            interest: interest != null ? String(interest) : null,
          })
          .returning();
        imported.push(created);
        console.log(`[Import] Created ${resolvedType} ${symbol}: qty=${quantity}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${symbol}: lỗi DB — ${msg}`);
      skipped++;
    }
  }

  console.log(`[Import] Done: ${imported.length} imported, ${skipped} skipped, ${errors.length} errors`);

  res.json(
    ImportHoldingsResponse.parse({
      imported: imported.length,
      skipped,
      errors,
      holdings: imported.map((h) => ({
        ...h,
        quantity: parseFloat(String(h.quantity)),
        manualPrice: h.manualPrice != null ? parseFloat(String(h.manualPrice)) : null,
      })),
    })
  );
});

export default router;
