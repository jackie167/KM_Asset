import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { HoldingForm, HoldingItem, TypeMode } from "@/pages/assets/types";
import { formatVND, resolveMode } from "@/pages/assets/utils";

const holdingSchema = z.object({
  type: z.string().min(1, "Bắt buộc"),
  symbol: z.string().min(1, "Bắt buộc"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  manualPrice: z.coerce.number().min(0).optional().nullable(),
});

const BUILTIN_TYPES = ["stock", "gold", "crypto"];

function getDefaultSymbol(type: string) {
  return type === "gold" ? "SJC_1L" : "";
}

type AddEditDialogProps = {
  open: boolean;
  onClose: () => void;
  initialData?: HoldingItem | null;
  defaultType?: string;
  onSubmit: (data: HoldingForm) => void;
  isLoading: boolean;
  allHoldings?: HoldingItem[];
};

export default function AddEditDialog({
  open,
  onClose,
  initialData,
  defaultType = "stock",
  onSubmit,
  isLoading,
  allHoldings = [],
}: AddEditDialogProps) {
  const normalizedDefaultType = defaultType.toLowerCase();
  const initialMode: TypeMode = initialData ? resolveMode(initialData.type) : resolveMode(normalizedDefaultType);
  const [typeMode, setTypeMode] = useState<TypeMode>(initialMode);

  const baseCustomTypes = useMemo(() => {
    const fromHoldings = allHoldings
      .map((holding) => holding.type.toLowerCase())
      .filter((type) => !BUILTIN_TYPES.includes(type));
    const fromEdit =
      initialData && !BUILTIN_TYPES.includes(initialData.type.toLowerCase())
        ? [initialData.type.toLowerCase()]
        : [];
    return [...new Set([...fromHoldings, ...fromEdit])];
  }, [allHoldings, initialData]);

  const [extraTypes, setExtraTypes] = useState<string[]>([]);
  const customTypes = useMemo(
    () => [...new Set([...baseCustomTypes, ...extraTypes])],
    [baseCustomTypes, extraTypes]
  );
  const [showNewInput, setShowNewInput] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const newTypeInputRef = useRef<HTMLInputElement>(null);
  const initialTotalValue = initialData?.currentValue ? String(Math.round(initialData.currentValue)) : "";
  const [totalValueStr, setTotalValueStr] = useState(initialTotalValue);
  const isEditing = !!initialData;

  const form = useForm<HoldingForm>({
    resolver: zodResolver(holdingSchema as never) as Resolver<HoldingForm>,
    defaultValues: initialData
      ? {
          type: initialData.type,
          symbol: initialData.symbol,
          quantity: initialData.quantity,
          manualPrice: null,
        }
      : { type: normalizedDefaultType, symbol: getDefaultSymbol(normalizedDefaultType), quantity: 0, manualPrice: null },
  });

  useEffect(() => {
    if (showNewInput) newTypeInputRef.current?.focus();
  }, [showNewInput]);

  useEffect(() => {
    if (open && !initialData) {
      form.reset({
        type: normalizedDefaultType,
        symbol: getDefaultSymbol(normalizedDefaultType),
        quantity: 0,
        manualPrice: null,
      });
      setTotalValueStr("");
      setTypeMode(resolveMode(normalizedDefaultType));
    }
  }, [form, initialData, normalizedDefaultType, open]);

  const watchQty = form.watch("quantity");
  const watchSymbol = form.watch("symbol");

  const setCustomTypes = (nextTypes: string[]) => {
    setExtraTypes(nextTypes.filter((type) => !baseCustomTypes.includes(type)));
  };

  const handleTypeSelect = (value: string) => {
    if (value === "__add_new__") {
      setShowNewInput(true);
      return;
    }
    setShowNewInput(false);
    if (value === "stock") {
      setTypeMode("stock");
      form.setValue("type", "stock");
      if (!isEditing) form.setValue("symbol", "");
      return;
    }
    if (value === "gold") {
      setTypeMode("gold");
      form.setValue("type", "gold");
      const currentSymbol = form.getValues("symbol");
      if (!isEditing) {
        form.setValue("symbol", "SJC_1L");
      } else if (!["SJC_1L", "SJC_1C"].includes(currentSymbol)) {
        form.setValue("symbol", "SJC_1L");
      }
      return;
    }
    setTypeMode("other");
    form.setValue("type", value);
    if (!isEditing) form.setValue("symbol", "");
  };

  const handleConfirmNewType = () => {
    const trimmed = newTypeName.trim().toLowerCase();
    if (!trimmed) return;
    if (BUILTIN_TYPES.includes(trimmed)) {
      handleTypeSelect(trimmed);
      setShowNewInput(false);
      setNewTypeName("");
      return;
    }
    const existing = customTypes.find((type) => type.toLowerCase() === trimmed);
    const finalType = existing ?? trimmed;
    setCustomTypes(existing ? customTypes : [...customTypes, trimmed]);
    setTypeMode("other");
    form.setValue("type", finalType);
    form.setValue("symbol", "");
    setShowNewInput(false);
    setNewTypeName("");
  };

  const handleSubmit = form.handleSubmit((data) => {
    const raw = totalValueStr.replace(/\./g, "").replace(",", ".");
    const totalValue = parseFloat(raw);
    if (!Number.isNaN(totalValue) && totalValue > 0 && data.quantity > 0) {
      data.manualPrice = totalValue / data.quantity;
    } else {
      data.manualPrice = null;
    }
    onSubmit(data);
  });

  const goldSymbols = [
    { value: "SJC_1L", label: "SJC Gold 1 tael" },
    { value: "SJC_1C", label: "SJC Gold 1 mace" },
  ];

  const selectValue =
    typeMode === "stock" ? "stock" : typeMode === "gold" ? "gold" : form.getValues("type") || "";

  const typeLabel = (type: string) => {
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    return `💼 ${name}`;
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Asset" : "Add Asset"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="text-sm text-muted-foreground mb-1.5 block">Asset Type</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { value: "stock", label: "📈 Stock" },
                { value: "gold", label: "🥇 Gold" },
                { value: "crypto", label: "🪙 Crypto" },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleTypeSelect(value)}
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    selectValue === value
                      ? "bg-primary/10 border-primary text-foreground font-medium"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}

              {customTypes.filter((type) => type !== "crypto").map((type) => (
                <span key={type} className="inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => handleTypeSelect(type)}
                    className={`px-3 py-1.5 rounded-l-md text-sm border-y border-l transition-colors ${
                      selectValue === type
                        ? "bg-primary/10 border-primary text-foreground font-medium"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {typeLabel(type)}
                  </button>
                  {!isEditing && extraTypes.includes(type) && (
                    <button
                      type="button"
                      onClick={() => {
                        setExtraTypes((previous) => previous.filter((item) => item !== type));
                        if (form.getValues("type") === type) handleTypeSelect("stock");
                      }}
                      className={`px-1.5 py-1.5 rounded-r-md text-sm border-y border-r transition-colors text-destructive hover:bg-destructive/10 ${
                        selectValue === type ? "border-primary" : "border-border"
                      }`}
                      title={`Remove type "${type}"`}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}

              {!isEditing && !showNewInput && (
                <button
                  type="button"
                  onClick={() => setShowNewInput(true)}
                  className="px-3 py-1.5 rounded-md text-sm border border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
                >
                  + Add
                </button>
              )}
            </div>

            {showNewInput && (
              <div className="flex gap-2 mt-2">
                <Input
                  ref={newTypeInputRef}
                  value={newTypeName}
                  onChange={(event) => setNewTypeName(event.target.value)}
                  placeholder="Example: Real Estate, Bond..."
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleConfirmNewType();
                    }
                  }}
                  className="flex-1"
                />
                <Button type="button" size="sm" onClick={handleConfirmNewType} disabled={!newTypeName.trim()}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowNewInput(false);
                    setNewTypeName("");
                  }}
                >
                  ✕
                </Button>
              </div>
            )}
          </div>

          {typeMode === "stock" && (
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Stock Symbol</label>
              <Input
                {...form.register("symbol")}
                placeholder="VD: VNM, HPG, VIC"
                disabled={isEditing}
                className="uppercase"
                onChange={(event) => form.setValue("symbol", event.target.value.toUpperCase())}
              />
              {form.formState.errors.symbol && (
                <p className="text-xs text-destructive mt-1">{form.formState.errors.symbol.message}</p>
              )}
            </div>
          )}

          {typeMode === "gold" && (
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Gold Type</label>
              <div className="flex flex-col gap-2">
                {goldSymbols.map((goldSymbol) => (
                  <button
                    key={goldSymbol.value}
                    type="button"
                    onClick={() => form.setValue("symbol", goldSymbol.value)}
                    className={`py-2 px-3 rounded-md text-sm font-medium border transition-colors text-left ${
                      watchSymbol === goldSymbol.value
                        ? "bg-primary/10 border-primary text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {goldSymbol.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {typeMode === "other" && (
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Asset Name / Symbol</label>
              <Input
                {...form.register("symbol")}
                placeholder="Example: BTC, ETH, Apartment Q7..."
                disabled={isEditing}
                className="uppercase"
                onChange={(event) => form.setValue("symbol", event.target.value.toUpperCase())}
              />
              {form.formState.errors.symbol && (
                <p className="text-xs text-destructive mt-1">{form.formState.errors.symbol.message}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Quantity</label>
              <Input
                {...form.register("quantity", { valueAsNumber: true })}
                type="number"
                step="any"
                min="0"
                placeholder="Enter quantity"
                onFocus={(event) => {
                  if (event.target.value === "0") event.target.value = "";
                }}
              />
              {form.formState.errors.quantity && (
                <p className="text-xs text-destructive mt-1">{form.formState.errors.quantity.message}</p>
              )}
            </div>

            <div>
              <label className="text-sm text-muted-foreground mb-1 block">
                Total Value
                {watchQty > 0 && totalValueStr && (
                  <span className="ml-1 text-xs text-primary/70">
                    = {formatVND(parseFloat(totalValueStr.replace(/\./g, "").replace(",", ".")) / watchQty)}/unit
                  </span>
                )}
              </label>
              <Input
                value={totalValueStr}
                onChange={(event) => setTotalValueStr(event.target.value)}
                type="number"
                step="1000"
                placeholder="Optional"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : isEditing ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
