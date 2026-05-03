import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── types ────────────────────────────────────────────────────────────────────

type Highlight = { type: "positive" | "warning" | "negative"; text: string };
type Suggestion = { area: string; current: string; suggested: string; reason: string };

type AIAnalysis = {
  overview: string;
  highlights: Highlight[];
  suggestions: Suggestion[];
  risks: string[];
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const HIGHLIGHT_STYLE: Record<Highlight["type"], string> = {
  positive: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  warning:  "text-amber-400  bg-amber-500/10  border-amber-500/20",
  negative: "text-red-400    bg-red-500/10    border-red-500/20",
};

const HIGHLIGHT_ICON: Record<Highlight["type"], string> = {
  positive: "✓",
  warning:  "⚠",
  negative: "✕",
};

// ─── component ────────────────────────────────────────────────────────────────

export default function AIPanel() {
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setOpen(true);
    try {
      const res = await fetch("/api/ai/analyze", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lỗi không xác định");
      setAnalysis(data.analysis as AIAnalysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thể kết nối AI.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={handleAnalyze}
        disabled={loading}
      >
        <span className="text-base leading-none">✦</span>
        {loading ? "Đang phân tích…" : "Phân tích AI"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="text-lg">✦</span> Phân tích AI
            </DialogTitle>
          </DialogHeader>

          {loading && (
            <div className="space-y-3 py-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-4 rounded bg-muted animate-pulse" style={{ width: `${70 + i * 8}%` }} />
              ))}
              <p className="text-xs text-muted-foreground pt-2 text-center">
                Đang đọc dữ liệu tài chính và phân tích…
              </p>
            </div>
          )}

          {error && (
            <div className="py-4 text-sm text-red-400 bg-red-500/10 rounded-lg px-4 border border-red-500/20">
              {error}
            </div>
          )}

          {analysis && !loading && (
            <div className="space-y-5 py-1">

              {/* Overview */}
              <p className="text-sm leading-relaxed text-muted-foreground">
                {analysis.overview}
              </p>

              {/* Highlights */}
              {analysis.highlights.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Nhận xét</p>
                  <div className="space-y-1.5">
                    {analysis.highlights.map((h, i) => (
                      <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-md border text-xs ${HIGHLIGHT_STYLE[h.type]}`}>
                        <span className="shrink-0 font-bold">{HIGHLIGHT_ICON[h.type]}</span>
                        <span>{h.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggestions */}
              {analysis.suggestions.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Đề xuất thông số</p>
                  <div className="space-y-2">
                    {analysis.suggestions.map((s, i) => (
                      <div key={i} className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold">{s.area}</span>
                          <div className="flex items-center gap-1.5 shrink-0 text-[10px]">
                            <span className="text-muted-foreground line-through">{s.current}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-primary font-semibold">{s.suggested}</span>
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{s.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Risks */}
              {analysis.risks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Rủi ro cần lưu ý</p>
                  <ul className="space-y-1">
                    {analysis.risks.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="shrink-0 text-amber-400 mt-0.5">·</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="pt-2 border-t border-border/40">
                <Button size="sm" variant="ghost" className="w-full text-xs h-7" onClick={handleAnalyze}>
                  Phân tích lại
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
