import AssetsPage from "@/pages/AssetsPage";
import ExcelPage from "@/pages/ExcelPage";

type DashboardMode = "assets" | "excel";

export default function Dashboard({ mode = "assets" }: { mode?: DashboardMode }) {
  return mode === "excel" ? <ExcelPage /> : <AssetsPage />;
}
