import { format } from "date-fns";
import PageHeader, { type MenuAction } from "@/pages/PageHeader";

type AssetsHeaderProps = {
  title?: string;
  lastUpdated?: string | null;
  hasHoldings: boolean;
  onExport: () => void;
  onSyncExport?: () => void;
  onDebugExport?: () => void;
  onTrade?: () => void;
  onImport?: () => void;
  onAdd?: () => void;
};

export default function AssetsHeader({
  title = "INVESTMENT",
  lastUpdated,
  hasHoldings,
  onExport,
  onSyncExport,
  onDebugExport,
  onTrade,
  onImport,
  onAdd,
}: AssetsHeaderProps) {
  const actions: MenuAction[] = [];

  if (onTrade)  actions.push({ kind: "item", label: "Trade",  onSelect: onTrade });
                actions.push({ kind: "item", label: "Export CSV", onSelect: onExport, disabled: !hasHoldings });
  if (onSyncExport) actions.push({ kind: "item", label: "Export Sync Workbook", onSelect: onSyncExport, disabled: !hasHoldings });
  if (onDebugExport) actions.push({ kind: "item", label: "Export Debug", onSelect: onDebugExport, disabled: !hasHoldings });
  if (onImport) actions.push({ kind: "item", label: "Import", onSelect: onImport });
  if (onAdd)    actions.push({ kind: "item", label: "Add",    onSelect: onAdd });

  return (
    <PageHeader
      title={title}
      subtitle={lastUpdated ? `Updated: ${format(new Date(lastUpdated), "HH:mm dd/MM/yyyy")}` : undefined}
      actions={actions}
    />
  );
}
