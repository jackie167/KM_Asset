import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV_LINKS = [
  { href: "/",                  label: "Dashboard" },
  { href: "/home",              label: "Home" },
  { href: "/assets",            label: "Investment" },
  { href: "/wealth-allocation", label: "Wealth Allocation" },
  { href: "/transactions",      label: "Transactions" },
  { href: "/excel",             label: "Excel" },
  { href: "/dashboard",         label: "Dashboard" },
  { href: "/fire",              label: "FIRE Planning" },
  { href: "/asset-forecast",    label: "Dự báo tài sản" },
  { href: "/expenses",          label: "Chi tiêu" },
  { href: "/income-forecast",   label: "Kế hoạch thu nhập" },
];

export type MenuAction =
  | { kind: "item";      label: string; onSelect: () => void; disabled?: boolean }
  | { kind: "separator" };

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  /** Extra controls rendered inline to the left of Menu (e.g. year selector) */
  inlineRight?: React.ReactNode;
  /** Page-specific actions appended after a separator in the dropdown */
  actions?: MenuAction[];
};

export default function PageHeader({ title, subtitle, inlineRight, actions = [] }: PageHeaderProps) {
  return (
    <header className="border-b border-border px-3 sm:px-4 md:px-6 py-3 sticky top-0 bg-background/95 backdrop-blur z-10">
      <div className="md:max-w-5xl xl:max-w-7xl mx-auto flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-semibold tracking-[0.18em] uppercase">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground leading-relaxed truncate">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {inlineRight}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs">Menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {NAV_LINKS.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href}>{link.label}</Link>
                </DropdownMenuItem>
              ))}
              {actions.length > 0 && <DropdownMenuSeparator />}
              {actions.map((action, i) =>
                action.kind === "separator" ? (
                  <DropdownMenuSeparator key={i} />
                ) : (
                  <DropdownMenuItem
                    key={i}
                    disabled={action.disabled}
                    onSelect={action.onSelect}
                  >
                    {action.label}
                  </DropdownMenuItem>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
