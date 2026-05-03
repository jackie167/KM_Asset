import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { asc } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  baseAssetsTable,
  expenseForecastTable,
  incomeExpenseTable,
  incomeForecastTable,
  incomeSourcesTable,
  incomeProjectCalcTable,
} from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

const CURRENT_YEAR = new Date().getFullYear();
const YEARS_RANGE  = Array.from({ length: 19 }, (_, i) => CURRENT_YEAR + i);

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
  return `${v.toLocaleString()} đ`;
}

function computeGrowthIncome(base: number, rate: number, year: number): number {
  return base * Math.pow(1 + rate / 100, year - CURRENT_YEAR);
}

router.post("/ai/analyze", async (_req, res): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY chưa được cấu hình." });
    return;
  }

  // ── Collect data ─────────────────────────────────────────────────────────────

  const [sources, incomeEntries, expForecasts, baseAssets, incomeExp, projectCalcAll, allSettings] =
    await Promise.all([
      db.select().from(incomeSourcesTable).orderBy(asc(incomeSourcesTable.sortOrder)),
      db.select().from(incomeForecastTable).orderBy(asc(incomeForecastTable.year)),
      db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year)),
      db.select().from(baseAssetsTable),
      db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
      db.select().from(incomeProjectCalcTable),
      db.select().from(appSettingsTable),
    ]);

  const settings = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));

  // ── Expense forecast (source of truth for total income plan) ─────────────────

  const expCur  = expForecasts.find((r) => r.year === CURRENT_YEAR);
  // Use expense_forecast income as the authoritative total income
  const planIncome      = num(expCur?.income) + num(expCur?.otherIncome);
  const investRatio     = num(expCur?.investmentRatio);
  const investAmount    = planIncome * (investRatio / 100);
  const availSpend      = planIncome - investAmount;
  const needTotal       = num(expCur?.needLiving) + num(expCur?.needTuition) + num(expCur?.needAllowance) + num(expCur?.needMaintenance);
  const wantBudget      = num(expCur?.wantBudget);
  const actualNeed      = expCur?.actualNeed != null ? num(expCur.actualNeed) : null;
  const actualWant      = expCur?.actualWant != null ? num(expCur.actualWant) : null;

  // ── Income sources breakdown ─────────────────────────────────────────────────

  const manualBySource: Record<number, Record<number, number>> = {};
  for (const e of incomeEntries) {
    manualBySource[e.sourceId] ??= {};
    manualBySource[e.sourceId]![e.year] = num(e.amount);
  }

  const projectCalcBySource: Record<number, Record<string, Record<number, number>>> = {};
  for (const e of projectCalcAll) {
    if (e.year < 0) continue; // skip meta rows (_calc_type)
    projectCalcBySource[e.sourceId] ??= {};
    projectCalcBySource[e.sourceId]![e.rowId] ??= {};
    projectCalcBySource[e.sourceId]![e.rowId]![e.year] = num(e.value);
  }

  const sourceLines = sources.map((src) => {
    let curIncome = 0;
    let detail = "";

    if (src.type === "business") {
      // FCF from project calculator: income_forecast entries (auto-linked)
      curIncome = manualBySource[src.id]?.[CURRENT_YEAR] ?? 0;
      const hasCalc = !!projectCalcBySource[src.id];
      detail = hasCalc ? "bảng tính dự án" : "chưa có bảng tính";
    } else if (src.forecastMode === "growth") {
      const base = num(src.forecastBase);
      const rate = num(src.forecastRate);
      curIncome = base > 0 ? computeGrowthIncome(base, rate, CURRENT_YEAR) : 0;
      detail = `tăng trưởng ${rate}%/năm từ ${fmtB(base)}`;
    } else {
      curIncome = manualBySource[src.id]?.[CURRENT_YEAR] ?? 0;
      detail = "nhập thủ công";
    }

    return `  - ${src.name} (${src.type}): ${fmtB(curIncome)}${detail ? ` — ${detail}` : ""}`;
  }).join("\n");

  // ── Base assets ───────────────────────────────────────────────────────────────

  const totalBaseAssets = baseAssets.reduce((s, a) => s + num(a.baseValue), 0);
  const assetByType = new Map<string, number>();
  for (const a of baseAssets) {
    const t = a.assetType.toLowerCase().replace(/_/g, " ");
    assetByType.set(t, (assetByType.get(t) ?? 0) + num(a.baseValue));
  }
  const assetBreakdown = [...assetByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t}: ${fmtB(v)} (${((v / totalBaseAssets) * 100).toFixed(0)}%)`)
    .join(", ");

  // ── Historical ────────────────────────────────────────────────────────────────

  const history = incomeExp.slice(-4).map((r) => ({
    year: r.year,
    income: num(r.income),
    expense: num(r.expense),
    savingsRate: (num(r.savingsRate) * 100).toFixed(0),
  }));

  // ── FIRE settings ─────────────────────────────────────────────────────────────

  const fireTarget  = num(settings["fire_target"]) || 0;
  const fireMode    = settings["fire_asset_mode"] || "investment";
  const fireMonthly = num(settings["fire_monthly_expense"]) || 0;

  // ── Expense forecast trend ────────────────────────────────────────────────────

  const expTrend = expForecasts.slice(0, 5).map((r) => {
    const inc = num(r.income) + num(r.otherIncome);
    const invest = inc * (num(r.investmentRatio) / 100);
    return `${r.year}: thu ${fmtB(inc)}, đầu tư ${num(r.investmentRatio).toFixed(0)}% (${fmtB(invest)})`;
  }).join("; ");

  // ── Prompt ────────────────────────────────────────────────────────────────────

  const prompt = `Bạn là chuyên gia tài chính cá nhân. Phân tích tài chính sau và trả về TIẾNG VIỆT.

## Tài sản (đầu năm ${CURRENT_YEAR})
Tổng tài sản: ${fmtB(totalBaseAssets)}
Phân loại: ${assetBreakdown}

## Thu nhập & Chi tiêu năm ${CURRENT_YEAR}
Thu nhập kế hoạch: ${fmtB(planIncome)}
Tỷ lệ đầu tư: ${investRatio}% = ${fmtB(investAmount)}/năm
Chi tiêu khả dụng: ${fmtB(availSpend)}
  Need (thiết yếu): ${fmtB(needTotal)}${actualNeed != null ? ` | thực tế: ${fmtB(actualNeed)}` : ""}
  Want (muốn): ${fmtB(wantBudget)}${actualWant != null ? ` | thực tế: ${fmtB(actualWant)}` : ""}

## Nguồn thu nhập
${sourceLines || "  (chưa có dữ liệu)"}

## Xu hướng kế hoạch 5 năm tới
${expTrend || "(chưa có dữ liệu)"}

## Lịch sử thu chi
${history.map((r) => `${r.year}: thu ${fmtB(r.income)}, chi ${fmtB(r.expense)}, tiết kiệm ${r.savingsRate}%`).join("\n")}

## Mục tiêu FIRE
Mục tiêu: ${fireTarget > 0 ? fmtB(fireTarget) : "Chưa đặt"}
Chi tiêu/tháng sau FIRE: ${fireMonthly > 0 ? fmtB(fireMonthly) : "Chưa đặt"}
Chế độ: ${fireMode === "investment" ? "Tài sản đầu tư" : "Tổng tài sản ròng"}

## Yêu cầu
Trả về JSON THUẦN (không dùng markdown code block), đúng cấu trúc:
{"overview":"...","highlights":[{"type":"positive|warning|negative","text":"..."}],"suggestions":[{"area":"...","current":"...","suggested":"...","reason":"..."}],"risks":["..."]}

Giới hạn: overview 2-3 câu, tối đa 4 highlights, 3 suggestions, 2 risks. Ngắn gọn, cụ thể.`;

  // ── Call Claude ───────────────────────────────────────────────────────────────

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";

  // Strip markdown fences if present (```json ... ```)
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: unknown = null;
  try {
    // Try the full stripped text first, then fall back to first JSON object
    parsed = JSON.parse(stripped);
  } catch {
    try {
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch { /* give up, return raw */ }
  }

  res.json({
    analysis: parsed ?? { overview: rawText, highlights: [], suggestions: [], risks: [] },
  });
});

export default router;
