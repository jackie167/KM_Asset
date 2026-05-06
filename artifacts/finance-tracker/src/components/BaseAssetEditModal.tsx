import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { formatVNDFull } from "@/pages/assets/utils";

type BaseAsset = {
  id: number;
  assetType: string;
  symbol: string;
  baseValue: number;
  note: string | null;
  displayName: string | null;
  displayType: string | null;
};

type HistoryEntry = {
  id: number;
  field: string;
  oldValue: number;
  newValue: number;
  note: string | null;
  changedAt: string;
};

async function fetchAsset(id: number): Promise<BaseAsset | null> {
  const res = await fetch("/api/base-assets");
  if (!res.ok) return null;
  const list: BaseAsset[] = await res.json();
  return list.find((a) => a.id === id) ?? null;
}

async function fetchHistory(id: number): Promise<HistoryEntry[]> {
  const res = await fetch(`/api/base-assets/${id}/history`);
  if (!res.ok) return [];
  return res.json();
}

type Props = {
  assetId: number;
  onClose: () => void;
  onSaved: () => void;
};

export default function BaseAssetEditModal({ assetId, onClose, onSaved }: Props) {
  const queryClient = useQueryClient();

  const assetQuery = useQuery({
    queryKey: ["base-asset-detail", assetId],
    queryFn: () => fetchAsset(assetId),
  });

  const historyQuery = useQuery({
    queryKey: ["base-asset-history", assetId],
    queryFn: () => fetchHistory(assetId),
  });

  const asset = assetQuery.data;

  const [displayName, setDisplayName] = useState("");
  const [displayType, setDisplayType] = useState("");
  const [baseValue, setBaseValue] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [confirmStep, setConfirmStep] = useState(false);

  useEffect(() => {
    if (!asset) return;
    setDisplayName(asset.displayName ?? asset.symbol);
    setDisplayType(asset.displayType ?? asset.assetType);
    setBaseValue(String(asset.baseValue));
  }, [asset]);

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/base-assets/${assetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Save failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["base-asset-detail", assetId] });
      queryClient.invalidateQueries({ queryKey: ["base-asset-history", assetId] });
      queryClient.invalidateQueries({ queryKey: ["wealth-allocation-holdings-total"] });
      setConfirmStep(false);
      setChangeNote("");
      onSaved();
    },
  });

  if (!asset) {
    return (
      <Overlay onClose={onClose}>
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Đang tải...</div>
      </Overlay>
    );
  }

  const newValue = parseFloat(baseValue.replace(/[^0-9.]/g, ""));
  const valueChanged = !isNaN(newValue) && newValue !== asset.baseValue;

  function handleSave() {
    if (valueChanged && !confirmStep) {
      setConfirmStep(true);
      return;
    }
    const payload: Record<string, unknown> = {
      displayName: displayName.trim() === asset!.symbol ? null : displayName.trim() || null,
      displayType: displayType.trim() === asset!.assetType ? null : displayType.trim() || null,
    };
    if (valueChanged) {
      payload.baseValue = newValue;
      payload.changeNote = changeNote.trim() || undefined;
    }
    saveMutation.mutate(payload);
  }

  return (
    <Overlay onClose={onClose}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-widest">Chỉnh sửa tài sản</p>
            <p className="text-sm font-semibold mt-0.5">{asset.displayName ?? asset.symbol}</p>
            <p className="text-[10px] text-muted-foreground">{asset.symbol} · {asset.assetType}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none mt-0.5">✕</button>
        </div>

        {!confirmStep ? (
          <>
            {/* Edit fields */}
            <div className="space-y-3">
              <Field label="Tên hiển thị">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="Danh mục hiển thị">
                <input
                  value={displayType}
                  onChange={(e) => setDisplayType(e.target.value)}
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="Giá trị gốc (VNĐ)">
                <input
                  value={baseValue}
                  onChange={(e) => setBaseValue(e.target.value)}
                  className={`w-full bg-muted border rounded px-2 py-1.5 text-sm outline-none focus:border-primary ${
                    valueChanged ? "border-amber-400" : "border-border"
                  }`}
                />
                {valueChanged && (
                  <p className="text-[10px] text-amber-400 mt-1">
                    {formatVNDFull(asset.baseValue)} → {formatVNDFull(newValue)} · ảnh hưởng P/L
                  </p>
                )}
              </Field>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="flex-1 text-sm py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50"
              >
                {saveMutation.isPending ? "Đang lưu..." : valueChanged ? "Tiếp theo →" : "Lưu"}
              </button>
              <button onClick={onClose} className="px-4 text-sm py-1.5 rounded border border-border text-muted-foreground hover:text-foreground transition">
                Huỷ
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Confirmation step */}
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 space-y-1.5">
                <p className="text-xs font-semibold text-amber-400">Xác nhận thay đổi giá trị</p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground tabular-nums">{formatVNDFull(asset.baseValue)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-semibold tabular-nums">{formatVNDFull(newValue)}</span>
                </div>
                <p className="text-[10px] text-muted-foreground">Thay đổi này sẽ ảnh hưởng đến P/L và được lưu vào lịch sử.</p>
              </div>
              <Field label="Ghi chú lý do (tuỳ chọn)">
                <input
                  autoFocus
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  placeholder="VD: Định giá lại Q2/2026..."
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm outline-none focus:border-primary"
                />
              </Field>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="flex-1 text-sm py-1.5 rounded bg-amber-500 text-white hover:bg-amber-400 transition disabled:opacity-50"
              >
                {saveMutation.isPending ? "Đang lưu..." : "Xác nhận lưu"}
              </button>
              <button onClick={() => setConfirmStep(false)} className="px-4 text-sm py-1.5 rounded border border-border text-muted-foreground hover:text-foreground transition">
                Quay lại
              </button>
            </div>
          </>
        )}

        {/* History */}
        {(historyQuery.data?.length ?? 0) > 0 && (
          <div className="pt-1 border-t border-border space-y-1.5">
            <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Lịch sử thay đổi giá trị</p>
            {historyQuery.data!.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-2 text-[11px]">
                <div>
                  <span className="text-muted-foreground tabular-nums">{formatVNDFull(h.oldValue)}</span>
                  <span className="text-muted-foreground mx-1">→</span>
                  <span className="tabular-nums font-medium">{formatVNDFull(h.newValue)}</span>
                  {h.note && <span className="text-muted-foreground ml-1">· {h.note}</span>}
                </div>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {new Date(h.changedAt).toLocaleDateString("vi-VN")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Card className="w-full sm:max-w-md mx-3 mb-3 sm:mb-0 p-4 max-h-[90vh] overflow-y-auto">
        {children}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
