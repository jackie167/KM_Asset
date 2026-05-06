import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  baseAssetsTable,
  expenseForecastTable,
  incomeExpenseTable,
  incomeSourcesTable,
  incomeProjectCalcTable,
  incomeForecastTable,
} from "../../../lib/db/src/index.ts";
import { buildAIContext } from "./aiContext.ts";
import { YEAR_START, FORECAST_YEARS, CalcType, computeFCF } from "../lib/income-calc.ts";

const router: IRouter = Router();

const CURRENT_YEAR = new Date().getFullYear();

function num(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtB(v: number) {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B đ`;
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(0)}M đ`;
  return `${sign}${abs.toLocaleString()} đ`;
}

// ── Fetch all financial data in one round-trip ─────────────────────────────────

async function fetchAllData() {
  return Promise.all([
    db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year)),
    db.select().from(baseAssetsTable),
    db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
    db.select().from(appSettingsTable),
    db.select().from(incomeSourcesTable).where(eq(incomeSourcesTable.active, true)),
    db.select().from(incomeProjectCalcTable),
    db.select().from(incomeForecastTable).orderBy(asc(incomeForecastTable.year)),
  ]);
}

// ── Build the shared financial context string (used by both endpoints) ──────────

function buildFinancialContext(
  expForecasts: Awaited<ReturnType<typeof fetchAllData>>[0],
  baseAssets:   Awaited<ReturnType<typeof fetchAllData>>[1],
  incomeExp:    Awaited<ReturnType<typeof fetchAllData>>[2],
  allSettings:  Awaited<ReturnType<typeof fetchAllData>>[3],
  activeSources:Awaited<ReturnType<typeof fetchAllData>>[4],
  calcEntries:  Awaited<ReturnType<typeof fetchAllData>>[5],
  forecastEntries: Awaited<ReturnType<typeof fetchAllData>>[6],
): string {
  const settings = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));

  // ── Tài sản ──────────────────────────────────────────────────────────────────
  const totalAssets = baseAssets.reduce((s, a) => s + num(a.baseValue), 0);
  const assetByType = new Map<string, number>();
  for (const a of baseAssets) {
    const t = a.assetType.toLowerCase().replace(/_/g, " ");
    assetByType.set(t, (assetByType.get(t) ?? 0) + num(a.baseValue));
  }
  const assetBreakdown = [...assetByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t}: ${fmtB(v)} (${((v / totalAssets) * 100).toFixed(0)}%)`)
    .join(", ");

  // ── Nguồn thu nhập ────────────────────────────────────────────────────────────
  const fcBySource: Record<number, Record<number, number>> = {};
  for (const e of forecastEntries) {
    fcBySource[e.sourceId] ??= {};
    fcBySource[e.sourceId]![e.year] = num(e.amount);
  }

  const sourceLines = activeSources.map((src) => {
    if (src.type === "business") return null; // handled separately below
    if (src.forecastMode === "growth" && num(src.forecastBase) > 0) {
      const base = num(src.forecastBase);
      const rate = num(src.forecastRate);
      const projected = FORECAST_YEARS.slice(0, 5).map((y) => `${y}: ${fmtB(base * Math.pow(1 + rate / 100, y - YEAR_START))}`).join(", ");
      return `- ${src.name} (${src.type}, tăng trưởng ${rate}%/năm): ${projected}…`;
    }
    const stored = fcBySource[src.id] ?? {};
    const byYear = FORECAST_YEARS.filter((y) => stored[y]).map((y) => `${y}: ${fmtB(stored[y]!)}`).join(", ");
    return `- ${src.name} (${src.type}): ${byYear || "chưa nhập"}`;
  }).filter(Boolean).join("\n");

  // ── Business project FCF ──────────────────────────────────────────────────────
  const bizSources = activeSources.filter((s) => s.type === "business");
  const calcBySource: Record<number, typeof calcEntries> = {};
  for (const e of calcEntries) {
    calcBySource[e.sourceId] ??= [];
    calcBySource[e.sourceId]!.push(e);
  }
  const bizLines = bizSources.map((src) => {
    const rows = calcBySource[src.id] ?? [];
    let calcType: CalcType = "direct";
    const vals: Record<string, Record<number, number>> = {};
    for (const e of rows) {
      if (e.rowId === "_calc_type") { calcType = num(e.value) === 1 ? "per_ha" : "direct"; continue; }
      vals[e.rowId] ??= {};
      vals[e.rowId]![e.year] = num(e.value);
    }
    const fcfYears = FORECAST_YEARS.map((year) => {
      const inp: Record<string, number> = {};
      for (const [rowId, ym] of Object.entries(vals)) inp[rowId] = ym[year] ?? 0;
      return { year, fcf: computeFCF(inp, calcType) };
    }).filter((x) => x.fcf !== 0).map((x) => `${x.year}: ${fmtB(x.fcf)}`);
    return `- ${src.name} (kinh doanh/${calcType === "per_ha" ? "nông nghiệp" : "trực tiếp"}): ` +
      (fcfYears.length > 0 ? fcfYears.join(", ") : "chưa nhập dữ liệu");
  });

  // ── Expense Forecast ─────────────────────────────────────────────────────────
  const fcRows = expForecasts.slice(0, 15);
  const fcTable = fcRows.map((r) => {
    const income      = num(r.income) + num(r.otherIncome);
    const investRatio = num(r.investmentRatio);
    const invest      = income * (investRatio / 100);
    const needTotal   = num(r.needLiving) + num(r.needTuition) + num(r.needAllowance) + num(r.needMaintenance);
    const want        = num(r.wantBudget);
    const balance     = income - invest - needTotal - want;
    const aN = r.actualNeed != null ? num(r.actualNeed) : null;
    const aW = r.actualWant != null ? num(r.actualWant) : null;
    const actualStr = (aN != null || aW != null)
      ? ` | thực tế: need ${aN != null ? fmtB(aN) : "—"}, want ${aW != null ? fmtB(aW) : "—"}`
      : "";
    return `${r.year}: thu ${fmtB(income)}, đầu tư ${investRatio.toFixed(0)}% (${fmtB(invest)}), need ${fmtB(needTotal)}, want ${fmtB(want)}, số dư ${fmtB(balance)}${actualStr}`;
  }).join("\n");

  // ── Lịch sử ──────────────────────────────────────────────────────────────────
  const history = incomeExp.slice(-5).map((r) => {
    const inc = num(r.income) + num(r.otherIncome);
    const exp = num(r.expense) + num(r.otherExpense);
    const savingsPct = inc > 0 ? (((inc - exp) / inc) * 100).toFixed(0) : "—";
    return `${r.year}: thu ${fmtB(inc)}, chi ${fmtB(exp)}, tiết kiệm ${savingsPct}%`;
  }).join("\n");

  // ── FIRE ─────────────────────────────────────────────────────────────────────
  const fireWR        = num(settings["fire_wr"]) || 4;
  const fireRet       = num(settings["fire_ret"]) || 8;
  const fireAge       = num(settings["fire_age"]) || 0;
  const fireTargetAge = num(settings["fire_target_age"]) || 0;
  const fireSpend     = num(settings["fire_spend"]) || 0;
  const fireMode      = settings["fire_asset_mode"] || "investment";
  const fireTarget    = fireWR > 0 ? (fireSpend * 12) / (fireWR / 100) : 0;
  const yearsToFire   = fireTargetAge > 0 && fireAge > 0 ? Math.max(0, fireTargetAge - fireAge) : 0;

  return `## Tài sản (đầu năm ${CURRENT_YEAR})
Tổng: ${fmtB(totalAssets)}
Phân loại: ${assetBreakdown}

## Nguồn thu nhập (không bao gồm kinh doanh)
${sourceLines || "(chưa có)"}

${bizLines.length > 0 ? `## Thu nhập dự án kinh doanh (FCF)\n${bizLines.join("\n")}` : ""}

## Kế hoạch thu/chi/đầu tư (Expense Forecast)
${fcTable || "(chưa có)"}

## Lịch sử thu chi thực tế
${history || "(chưa có)"}

## Mục tiêu FIRE
Mục tiêu tài sản: ${fireTarget > 0 ? fmtB(fireTarget) : "Chưa đặt"}
Chi tiêu/tháng sau FIRE: ${fireSpend > 0 ? fmtB(fireSpend) : "Chưa đặt"}
Tỷ lệ rút (WR): ${fireWR}% | Lãi suất kỳ vọng: ${fireRet}%
Tuổi hiện tại: ${fireAge > 0 ? fireAge : "Chưa đặt"} | Tuổi FIRE mục tiêu: ${fireTargetAge > 0 ? fireTargetAge : "Chưa đặt"}
${yearsToFire > 0 ? `Còn ${yearsToFire} năm đến FIRE mục tiêu` : ""}
Chế độ tính: ${fireMode === "investment" ? "Tài sản đầu tư" : "Tổng tài sản ròng"}`;
}

// ─── POST /ai/analyze ─────────────────────────────────────────────────────────

router.post("/ai/analyze", async (_req, res): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "ANTHROPIC_API_KEY chưa được cấu hình." }); return; }

  const context = await buildAIContext();

  const prompt = `Bạn là chuyên gia tài chính cá nhân. Phân tích toàn bộ tình hình tài chính dưới đây và trả về TIẾNG VIỆT.
Đơn vị VND: 1 tỷ = 1.000.000.000; 1 triệu = 1.000.000. Khi mô tả số, quy đổi đúng và ghi rõ đơn vị (ví dụ: 900.183.673 = 900 triệu, KHÔNG phải 900 tỷ).

Dữ liệu tài chính:
${JSON.stringify(context, null, 2)}

Yêu cầu — trả về JSON THUẦN (không markdown code block), đúng format sau:
{"overview":"2-3 câu tổng quan","highlights":[{"type":"positive","text":"nhận xét kèm số liệu"}],"suggestions":[{"area":"lĩnh vực","current":"giá trị hiện tại","suggested":"đề xuất","reason":"lý do"}],"risks":["chuỗi mô tả rủi ro","chuỗi mô tả rủi ro 2"]}

Lưu ý: risks là mảng STRING thuần, KHÔNG phải object. Giới hạn: 4 highlights, 3 suggestions, 2 risks.`;

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";

  // Extract JSON: try code block first, then bare object
  const codeBlock = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = codeBlock ? codeBlock[1]! : rawText;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);

  let parsed: unknown = null;
  try { parsed = JSON.parse(candidate.trim()); } catch { /* continue */ }
  if (!parsed && jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* raw fallback */ }
  }

  res.json({ analysis: parsed ?? { overview: rawText, highlights: [], suggestions: [], risks: [] } });
});

router.post("/ai/chat", async (req, res): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "ANTHROPIC_API_KEY chưa được cấu hình." }); return; }

  const body = req.body as {
    history?: { role: "user" | "assistant"; content: string }[];
    message?: string;
  };

  const userMessage = body.message?.trim();
  if (!userMessage) { res.status(400).json({ error: "Câu hỏi trống." }); return; }

  const historyMsgs: Anthropic.Messages.MessageParam[] = (body.history ?? [])
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content }));

  const client = new Anthropic({ apiKey });
  const context = await buildAIContext();

  const systemPrompt = `Bạn là trợ lý tài chính cá nhân. Dữ liệu tài chính cập nhật bên dưới là nguồn duy nhất — không đoán mò số liệu.
Nguyên tắc: chỉ đọc dữ liệu, KHÔNG đề xuất thao tác hệ thống. Trả lời bằng TIẾNG VIỆT, ngắn gọn, kèm số liệu cụ thể. Tính toán thì trình bày từng bước.
Đơn vị tiền VND: 1 tỷ = 1.000.000.000; 1 triệu = 1.000.000. Khi đọc số nguyên từ dữ liệu, quy đổi đúng: ví dụ 900.183.673 = 900 TRIỆU (không phải 900 tỷ); 6.134.067.650 = 6,13 tỷ. LUÔN ghi rõ đơn vị (tỷ hoặc triệu) để tránh nhầm lẫn.
Nếu data_quality.issues_count > 0, hãy note cho user về dữ liệu có thể chưa cập nhật.

${JSON.stringify(context, null, 2)}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [...historyMsgs, { role: "user", content: userMessage }],
  });

  const text = response.content.find((b) => b.type === "text")
    ? (response.content.find((b) => b.type === "text") as Anthropic.Messages.TextBlock).text.trim()
    : "";

  res.json({ response: text });
});

export default router;
