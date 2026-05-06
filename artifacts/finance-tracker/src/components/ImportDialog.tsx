import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function downloadTemplate() {
  const csv = [
    "asset_code,asset_type,quantity,current_price,current_value,cost_of_capital,interest",
    "HPG,stock,5400,,,,",
    "SJC_1L,gold,10.8,,,,",
    "BTC,crypto,0.091,,,,",
    "VESAF,fund,1000,15000,15000000,14000000,",
    "CASH,cash,1,6281734000,6281734000,7440694000,",
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tai-san-mau.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function ImportDialog({ open, onClose, onSuccess }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setFile(null);
    setResult(null);
    setError(null);
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
    setError(null);
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/api/holdings/import`, {
        method: "POST",
        body: formData,
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Import thất bại");
        return;
      }

      setResult({
        imported: json.imported,
        skipped: json.skipped,
        errors: json.errors ?? [],
      });

      if (json.imported > 0) {
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi kết nối");
    } finally {
      setLoading(false);
    }
  };

  const formatLabel = (f: File) => {
    const kb = (f.size / 1024).toFixed(1);
    return `${f.name} (${kb} KB)`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import tài sản từ file</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">Định dạng file: CSV, XLS, XLSX</p>
            <p>File import thường cần các cột sau; workbook sync export sẽ tự đọc các sheet Investment, Transactions, CashFlows, PriceHistory:</p>
            <ul className="space-y-1 pl-3 list-disc">
              <li>
                <code className="bg-muted px-1 rounded">asset_code</code>
                {" "}— mã tài sản (HPG, SJC_1L, BTC...)
              </li>
              <li>
                <code className="bg-muted px-1 rounded">asset_type</code>
                {" "}— loại tài sản (stock, gold, crypto, fund, cash...)
              </li>
              <li>
                <code className="bg-muted px-1 rounded">quantity</code>
                {" "}— số lượng <span className="text-foreground font-medium">(bắt buộc, thay thế số lượng hiện tại)</span>
              </li>
              <li>
                <code className="bg-muted px-1 rounded">current_price/current_value/cost_of_capital</code>
                {" "}— dùng cho tài sản manual/cash và tính P/L
              </li>
            </ul>
            <div className="pt-0.5 space-y-0.5 text-[10px]">
              <p>• CSV cũ symbol/type/quantity vẫn dùng được</p>
              <p>• File Export Sync Workbook có thể import lại để đồng bộ đủ holdings, giao dịch, cashflow và price history</p>
              <p>• Với sync workbook, holdings không còn trong sheet Investment sẽ bị loại khỏi danh mục</p>
            </div>
            <button
              onClick={downloadTemplate}
              className="mt-1 text-primary hover:underline font-medium inline-flex items-center gap-1"
            >
              ↓ Tải file mẫu CSV
            </button>
          </div>

          <div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xls,.xlsx"
              className="hidden"
              onChange={handleFileChange}
            />
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                file
                  ? "border-primary/60 bg-primary/5"
                  : "border-border hover:border-primary/40 hover:bg-muted/30"
              }`}
              onClick={() => inputRef.current?.click()}
            >
              {file ? (
                <div>
                  <p className="text-sm font-medium text-foreground">📄 {formatLabel(file)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Nhấp để chọn file khác</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground">Nhấp để chọn file CSV hoặc Excel</p>
                  <p className="text-xs text-muted-foreground mt-1">.csv, .xls, .xlsx — tối đa 5MB</p>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
              ⚠ {error}
            </div>
          )}

          {result && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="flex gap-4 text-sm">
                <span className="text-green-400 font-medium">✅ {result.imported} đã cập nhật</span>
                {result.skipped > 0 && (
                  <span className="text-muted-foreground">⊘ {result.skipped} bị loại khỏi danh mục</span>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="font-medium text-foreground">Lỗi chi tiết:</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-destructive/80">• {e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            {result ? "Đóng" : "Hủy"}
          </Button>
          {!result && (
            <Button onClick={handleImport} disabled={!file || loading}>
              {loading ? "Đang xử lý..." : "Import"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
