import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "@/pages/PageHeader";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import {
  getGetPortfolioSummaryQueryKey,
  getListHoldingsQueryKey,
  getListSnapshotsQueryKey,
} from "@workspace/api-client-react";

function formatExcelNumber(value: number) {
  return value.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function readJsonSafe(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    throw new Error(text?.slice(0, 120) || "Phản hồi không hợp lệ.");
  }
  return res.json();
}

function isInvestmentSheetName(name: string) {
  return name.trim().toLowerCase().startsWith("investment");
}

type ExcelSourceInfo = {
  mode: "local" | "google_drive";
  readOnly: boolean;
  label: string;
};

export default function ExcelPage() {
  const queryClient = useQueryClient();
  const [excelSheets, setExcelSheets] = useState<string[]>([]);
  const [excelSheet, setExcelSheet] = useState<string>("");
  const [excelRows, setExcelRows] = useState<Array<Array<string | number>>>([]);
  const [excelSyncingInvestment, setExcelSyncingInvestment] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);
  const [excelNotice, setExcelNotice] = useState<string | null>(null);
  const [excelSource, setExcelSource] = useState<ExcelSourceInfo>({
    mode: "local",
    readOnly: false,
    label: "Local file",
  });

  const yearHeaderCols = useMemo(() => {
    const header = excelRows[0] ?? [];
    const set = new Set<number>();
    header.forEach((cell, index) => {
      const label = String(cell ?? "").trim().toLowerCase();
      if (label === "year" || label.includes("năm")) set.add(index);
    });
    return set;
  }, [excelRows]);

  const loadExcelSheets = useCallback(async () => {
    setExcelError(null);
    setExcelNotice(null);
    setExcelLoading(true);
    try {
      const res = await fetch("/api/excel/sheets");
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data?.error || "Không thể tải danh sách sheet.");
      const sheets = Array.isArray(data?.sheets) ? data.sheets : [];
      if (data?.source) {
        setExcelSource(data.source as ExcelSourceInfo);
      }
      setExcelSheets(sheets);
      if (sheets.length && !excelSheet) setExcelSheet(sheets[0]);
    } catch (err) {
      setExcelError(err instanceof Error ? err.message : "Không thể tải danh sách sheet.");
    } finally {
      setExcelLoading(false);
    }
  }, [excelSheet]);

  const loadExcelSheet = useCallback(async (name: string) => {
    if (!name) return;
    setExcelError(null);
    setExcelNotice(null);
    setExcelLoading(true);
    try {
      const res = await fetch(`/api/excel/sheet?name=${encodeURIComponent(name)}`);
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data?.error || "Không thể tải dữ liệu sheet.");
      if (data?.source) {
        setExcelSource(data.source as ExcelSourceInfo);
      }
      if (typeof data?.name === "string" && data.name && data.name !== name) {
        setExcelSheet(data.name);
      }
      setExcelRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (err) {
      setExcelError(err instanceof Error ? err.message : "Không thể tải dữ liệu sheet.");
    } finally {
      setExcelLoading(false);
    }
  }, []);

  const syncInvestmentToAssets = useCallback(async () => {
    setExcelError(null);
    setExcelNotice(null);
    setExcelSyncingInvestment(true);
    try {
      const res = await fetch("/api/excel/investment/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: excelSheet,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data?.error || "Unable to sync Investment to assets.");
      queryClient.setQueryData(["transactions"], []);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListHoldingsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListSnapshotsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["portfolio-xirr"] }),
      ]);
      const warning = typeof data?.warning === "string" && data.warning ? ` Warning: ${data.warning}` : "";
      const clearedCount =
        typeof data?.clearedTransactions === "number"
          ? data.clearedTransactions
          : data?.clearedTransactions
            ? 1
            : 0;
      const cleared = clearedCount > 0 ? ` Trade history cleared: ${clearedCount}.` : "";
      const importedTransactions =
        typeof data?.importedTransactions === "number" && data.importedTransactions > 0
          ? ` Imported transactions: ${data.importedTransactions}.`
          : "";
      setExcelNotice(
        `${data?.message || "Sync completed."} Created: ${data?.created ?? 0}, updated: ${data?.updated ?? 0}, removed: ${data?.removed ?? 0}.${cleared}${importedTransactions}${warning}`
      );
    } catch (err) {
      setExcelError(err instanceof Error ? err.message : "Unable to sync Investment to assets.");
    } finally {
      setExcelSyncingInvestment(false);
    }
  }, [excelSheet, queryClient]);

  useEffect(() => {
    loadExcelSheets();
  }, [loadExcelSheets]);

  useEffect(() => {
    if (!excelSheet) return;
    loadExcelSheet(excelSheet);
  }, [excelSheet, loadExcelSheet]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader title="Excel Sheets" />

      <main className="w-full md:max-w-5xl xl:max-w-7xl mx-auto px-3 sm:px-4 md:px-6 xl:px-8 py-4 space-y-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-widest">Excel Sheets</p>
              <p className="text-xs text-muted-foreground">Chọn sheet để xem dạng bảng</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Nguồn dữ liệu: {excelSource.label}
                {excelSource.readOnly ? " • chỉnh sửa tại nguồn rồi app tự đọc" : ""}
              </p>
            </div>
          </div>

          {excelError && <p className="text-xs text-destructive mb-2">{excelError}</p>}
          {excelNotice && <p className="text-xs text-emerald-400 mb-2">{excelNotice}</p>}

          {excelSheets.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-3">
              {excelSheets.map((sheet) => (
                <button
                  key={sheet}
                  onClick={() => setExcelSheet(sheet)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    excelSheet === sheet
                      ? "border-primary/60 text-primary bg-primary/5"
                      : "border-border text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {sheet}
                </button>
              ))}
              {isInvestmentSheetName(excelSheet) && (
                <button
                  onClick={syncInvestmentToAssets}
                  disabled={excelSyncingInvestment}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    excelSyncingInvestment
                      ? "border-primary/40 text-primary/70 bg-primary/5"
                      : "border-primary/60 text-primary bg-primary/5 hover:border-primary"
                  }`}
                >
                  {excelSyncingInvestment ? "Syncing..." : "Sync Investment -> Assets"}
                </button>
              )}
            </div>
          )}

          {excelLoading ? (
            <p className="text-xs text-muted-foreground">Đang tải dữ liệu...</p>
          ) : excelRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có dữ liệu sheet.</p>
          ) : (
            <div className="overflow-auto border border-border rounded-lg">
              <table className="min-w-full text-xs">
                <tbody>
                  {excelRows.slice(0, 200).map((row, rowIndex) => (
                    <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/50 font-semibold" : ""}>
                      {row.map((cell, colIndex) => {
                        const isYearCol = yearHeaderCols.has(colIndex);
                        const isNumeric = typeof cell === "number" && !isYearCol;

                        return (
                          <td
                            key={colIndex}
                            className={`px-2 py-1 border-b border-border whitespace-nowrap ${
                              isNumeric ? "text-right tabular-nums" : ""
                            }`}
                          >
                            {cell === null || cell === undefined || cell === "" ? (
                              "—"
                            ) : typeof cell === "number" ? (
                              isYearCol ? String(Math.trunc(cell)) : formatExcelNumber(cell)
                            ) : (
                              String(cell)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
