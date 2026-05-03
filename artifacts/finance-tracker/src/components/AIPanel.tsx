import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
type ChatMsg  = { role: "user" | "assistant"; content: string };
type Tab      = "analyze" | "chat";

// ─── helpers ──────────────────────────────────────────────────────────────────

const HIGHLIGHT_STYLE: Record<Highlight["type"], string> = {
  positive: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  warning:  "text-amber-400  bg-amber-500/10  border-amber-500/20",
  negative: "text-red-400    bg-red-500/10    border-red-500/20",
};
const HIGHLIGHT_ICON: Record<Highlight["type"], string> = {
  positive: "✓", warning: "⚠", negative: "✕",
};

// ─── cache ────────────────────────────────────────────────────────────────────

const ANALYSIS_KEY = "ai_analysis_v1";
const CHAT_KEY     = "ai_chat_v1";
type AnalysisCache = { analysis: AIAnalysis; ts: number };

function loadAnalysis(): AIAnalysis | null {
  try {
    const raw = localStorage.getItem(ANALYSIS_KEY);
    return raw ? (JSON.parse(raw) as AnalysisCache).analysis : null;
  } catch { return null; }
}
function saveAnalysis(a: AIAnalysis) {
  try { localStorage.setItem(ANALYSIS_KEY, JSON.stringify({ analysis: a, ts: Date.now() } satisfies AnalysisCache)); } catch { /* ignore */ }
}
function analysisAge(): string | null {
  try {
    const raw = localStorage.getItem(ANALYSIS_KEY);
    if (!raw) return null;
    const { ts } = JSON.parse(raw) as AnalysisCache;
    const mins = Math.round((Date.now() - ts) / 60_000);
    if (mins < 1) return "vừa xong";
    if (mins < 60) return `${mins} phút trước`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs} giờ trước` : `${Math.round(hrs / 24)} ngày trước`;
  } catch { return null; }
}
function loadChat(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
  } catch { return []; }
}
function saveChat(msgs: ChatMsg[]) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-60))); } catch { /* ignore */ }
}

// ─── component ────────────────────────────────────────────────────────────────

export default function AIPanel() {
  const [open, setOpen]         = useState(false);
  const [tab, setTab]           = useState<Tab>("analyze");

  // analyze tab state
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [age, setAge]           = useState<string | null>(null);

  // chat tab state
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput]     = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError]     = useState<string | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  // load persisted data on mount
  useEffect(() => {
    const cached = loadAnalysis();
    if (cached) { setAnalysis(cached); setAge(analysisAge()); }
    setChatHistory(loadChat());
  }, []);

  // auto-scroll chat to bottom
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatLoading]);

  // ── analyze tab ──────────────────────────────────────────────────────────────

  const triggerAnalyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/ai/analyze", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lỗi không xác định");
      const a = data.analysis as AIAnalysis;
      setAnalysis(a);
      saveAnalysis(a);
      setAge(analysisAge());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thể kết nối AI.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    setOpen(true);
  };

  // ── chat tab ─────────────────────────────────────────────────────────────────

  const sendMessage = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    setChatError(null);
    const withUser: ChatMsg[] = [...chatHistory, { role: "user", content: msg }];
    setChatHistory(withUser);
    setChatLoading(true);
    try {
      const res  = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: chatHistory, message: msg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lỗi không xác định");
      const updated: ChatMsg[] = [...withUser, { role: "assistant", content: data.response as string }];
      setChatHistory(updated);
      saveChat(updated);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Không thể kết nối AI.");
    } finally {
      setChatLoading(false);
    }
  };

  const clearChat = () => {
    setChatHistory([]);
    localStorage.removeItem(CHAT_KEY);
  };

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={handleOpen}
        disabled={loading}
      >
        <span className="text-base leading-none">✦</span>
        {loading ? "Đang phân tích…" : "Phân tích AI"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg flex flex-col max-h-[88vh] p-0 gap-0 overflow-hidden">

          {/* Header */}
          <DialogHeader className="px-5 pt-5 pb-0 shrink-0">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <span className="text-base">✦</span> Trợ lý AI
            </DialogTitle>
          </DialogHeader>

          {/* Tab switcher */}
          <div className="flex gap-0 px-5 pt-3 pb-0 border-b border-border shrink-0">
            {(["analyze", "chat"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`pb-2 px-3 text-xs font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "analyze" ? "Phân tích" : "Hỏi đáp"}
              </button>
            ))}
          </div>

          {/* ── Analyze tab ─────────────────────────────────────────────────── */}
          {tab === "analyze" && (
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {!analysis && !loading && !error && (
                <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                  <span className="text-3xl opacity-20">✦</span>
                  <p className="text-xs text-muted-foreground max-w-[220px] leading-relaxed">
                    Bấm để AI đọc toàn bộ dữ liệu tài chính và đưa ra nhận xét, đề xuất.
                  </p>
                  <Button size="sm" className="text-xs h-8 gap-1.5 mt-1" onClick={triggerAnalyze}>
                    <span className="text-sm leading-none">✦</span> Bắt đầu phân tích
                  </Button>
                </div>
              )}

              {loading && (
                <div className="space-y-3 py-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-4 rounded bg-muted animate-pulse" style={{ width: `${70 + i * 8}%` }} />
                  ))}
                  <p className="text-xs text-muted-foreground pt-2 text-center">
                    Đang đọc dữ liệu tài chính và phân tích…
                  </p>
                </div>
              )}

              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-4 py-3 border border-red-500/20">
                  {error}
                </div>
              )}

              {analysis && !loading && (
                <div className="space-y-5">
                  <p className="text-sm leading-relaxed text-muted-foreground">{analysis.overview}</p>

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

                  {analysis.suggestions.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Đề xuất</p>
                      <div className="space-y-2">
                        {analysis.suggestions.map((s, i) => (
                          <div key={i} className="rounded-lg border border-border bg-muted/20 px-3 py-3 space-y-2">
                            <p className="text-xs font-semibold">{s.area}</p>
                            <div className="flex items-center gap-2 text-xs flex-wrap">
                              <span className="text-muted-foreground line-through break-all">{s.current}</span>
                              <span className="text-muted-foreground shrink-0">→</span>
                              <span className="text-primary font-semibold break-all">{s.suggested}</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed">{s.reason}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

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
                </div>
              )}

              {/* Footer */}
              <div className="pt-1 border-t border-border/40 flex items-center gap-2">
                {age && !loading && (
                  <span className="text-[10px] text-muted-foreground flex-1">Phân tích lần cuối: {age}</span>
                )}
                <Button size="sm" variant="ghost" className="text-xs h-7 shrink-0" onClick={triggerAnalyze} disabled={loading}>
                  {loading ? "Đang phân tích…" : "Phân tích lại"}
                </Button>
              </div>
            </div>
          )}

          {/* ── Chat tab ────────────────────────────────────────────────────── */}
          {tab === "chat" && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {chatHistory.length === 0 && !chatLoading && (
                  <div className="flex flex-col items-center justify-center h-full gap-3 py-10 text-center">
                    <span className="text-3xl opacity-30">✦</span>
                    <p className="text-xs text-muted-foreground max-w-[240px] leading-relaxed">
                      Hỏi bất kỳ điều gì về dữ liệu tài chính của bạn. AI sẽ đọc số liệu và trả lời trực tiếp.
                    </p>
                    <div className="flex flex-col gap-1.5 w-full max-w-xs">
                      {[
                        "Thu nhập dự phóng năm 2028 là bao nhiêu?",
                        "FCF dự án kinh doanh lớn nhất là bao nhiêu?",
                        "Tôi còn bao nhiêu năm để đạt FIRE?",
                      ].map((q) => (
                        <button
                          key={q}
                          onClick={() => { setChatInput(q); }}
                          className="text-[11px] text-left px-3 py-2 rounded-lg border border-border hover:bg-muted/50 text-muted-foreground transition-colors"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {chatHistory.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}

                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5 items-center">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
                          style={{ animationDelay: `${i * 150}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {chatError && (
                  <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">
                    {chatError}
                  </div>
                )}

                <div ref={msgEndRef} />
              </div>

              {/* Input */}
              <div className="px-4 pb-4 pt-2 border-t border-border shrink-0">
                {chatHistory.length > 0 && (
                  <div className="flex justify-end mb-1.5">
                    <button
                      onClick={clearChat}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Xóa lịch sử
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    placeholder="Hỏi về dữ liệu tài chính…"
                    className="h-9 text-xs"
                    disabled={chatLoading}
                  />
                  <Button
                    size="sm"
                    className="h-9 px-3 text-xs shrink-0"
                    onClick={sendMessage}
                    disabled={chatLoading || !chatInput.trim()}
                  >
                    Gửi
                  </Button>
                </div>
              </div>
            </div>
          )}

        </DialogContent>
      </Dialog>
    </>
  );
}
