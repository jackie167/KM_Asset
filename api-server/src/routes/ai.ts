import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { asc, gte, eq } from "drizzle-orm";
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

function num(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtB(v: number) {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B đ`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M đ`;
  return `${v.toLocaleString()} đ`;
}

async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettingsTable)
    .where(eq(appSettingsTable.key, keys[0]!)); // minimal: fetch one by one if needed
  // Fetch all in one query via in-clause workaround: just select all and filter
  const all = await db.select().from(appSettingsTable);
  return Object.fromEntries(
    all.filter((r) => keys.includes(r.key)).map((r) => [r.key, r.value ?? ""])
  );
}

router.post("/ai/analyze", async (_req, res): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY chưa được cấu hình." });
    return;
  }

  // ── Collect data ────────────────────────────────────────────────────────────

  const [
    sources,
    incomeEntries,
    expForecasts,
    baseAssets,
    incomeExp,
    projectCalcAll,
    settings,
  ] = await Promise.all([
    db.select().from(incomeSourcesTable).orderBy(asc(incomeSourcesTable.sortOrder)),
    db.select().from(incomeForecastTable).orderBy(asc(incomeForecastTable.year)),
    db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year)),
    db.select().from(baseAssetsTable),
    db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
    db.select().from(incomeProjectCalcTable),
    getSettings(["fire_target", "fire_monthly_expense", "fire_asset_mode", "fire_investment_ratio"]),
  ]);

  // ── Build income summary ────────────────────────────────────────────────────

  const incomeBySource: Record<number, Record<number, number>> = {};
  for (const e of incomeEntries) {
    incomeBySource[e.sourceId] ??= {};
    incomeBySource[e.sourceId]![e.year] = num(e.amount);
  }

  const incomeSummary = sources.map((src) => {
    const yearVals = YEARS_RANGE.map((y) => incomeBySource[src.id]?.[y] ?? 0);
    const curVal = incomeBySource[src.id]?.[CURRENT_YEAR] ?? 0;
    const hasGrowth = src.forecastMode === "growth";
    return {
      name: src.name,
      type: src.type,
      mode: src.forecastMode,
      currentYear: curVal,
      forecastRate: hasGrowth ? num(src.forecastRate) : null,
      forecastBase: hasGrowth ? num(src.forecastBase) : null,
      next3Years: yearVals.slice(0, 3),
    };
  });

  const totalIncomeCurrentYear = incomeSummary.reduce((s, src) => s + src.currentYear, 0);

  // ── Base assets ─────────────────────────────────────────────────────────────

  const totalBaseAssets = baseAssets.reduce((s, a) => s + num(a.baseValue), 0);
  const assetByType = new Map<string, number>();
  for (const a of baseAssets) {
    const t = a.assetType.toLowerCase();
    assetByType.set(t, (assetByType.get(t) ?? 0) + num(a.baseValue));
  }

  // ── Expense forecast current year ───────────────────────────────────────────

  const expCur = expForecasts.find((r) => r.year === CURRENT_YEAR);
  const expIncome = num(expCur?.income) + num(expCur?.otherIncome);
  const expInvestRatio = num(expCur?.investmentRatio);
  const expNeedTotal = num(expCur?.needLiving) + num(expCur?.needTuition) + num(expCur?.needAllowance) + num(expCur?.needMaintenance);
  const expWantBudget = num(expCur?.wantBudget);
  const expAvailAfterInvest = expIncome * (1 - expInvestRatio / 100);

  // ── FIRE ────────────────────────────────────────────────────────────────────

  const fireTarget = num(settings["fire_target"]) || 0;
  const fireMode = settings["fire_asset_mode"] || "investment";

  // ── Historical income/expense ────────────────────────────────────────────────

  const recentHistory = incomeExp.slice(-3).map((r) => ({
    year: r.year,
    income: num(r.income),
    expense: num(r.expense),
    savingsRate: num(r.savingsRate),
  }));

  // ── Project calc business sources (FCF summary) ──────────────────────────────

  const projectCalcBySource: Record<number, Record<string, Record<number, number>>> = {};
  for (const e of projectCalcAll) {
    projectCalcBySource[e.sourceId] ??= {};
    projectCalcBySource[e.sourceId]![e.rowId] ??= {};
    projectCalcBySource[e.sourceId]![e.rowId]![e.year] = num(e.value);
  }

  const businessSummary = sources
    .filter((s) => s.type === "business")
    .map((src) => {
      const calc = projectCalcBySource[src.id];
      if (!calc) return { name: src.name, hasFCF: false };
      // Rough FCF: find fcf-like values from the income forecast
      const fcfVals = YEARS_RANGE.slice(0, 5).map((y) => incomeBySource[src.id]?.[y] ?? 0);
      return { name: src.name, hasFCF: true, fcfNext5Years: fcfVals };
    });

  // ── Build prompt ─────────────────────────────────────────────────────────────

  const prompt = `Bạn là chuyên gia tài chính cá nhân. Hãy phân tích tình hình tài chính dưới đây và trả lời BẰNG TIẾNG VIỆT.

## Thông tin tài chính (năm ${CURRENT_YEAR})

**Tổng tài sản cơ sở (đầu năm ${CURRENT_YEAR}):** ${fmtB(totalBaseAssets)}
Phân loại: ${[...assetByType.entries()].map(([t, v]) => `${t}: ${fmtB(v)}`).join(", ")}

**Thu nhập dự báo năm ${CURRENT_YEAR}:** ${fmtB(totalIncomeCurrentYear)}
Chi tiết nguồn thu:
${incomeSummary.map((s) => `- ${s.name} (${s.type}): ${fmtB(s.currentYear)}${s.mode === "growth" ? `, tăng trưởng ${s.forecastRate}%/năm` : ""}`).join("\n")}

**Kế hoạch chi tiêu năm ${CURRENT_YEAR}:**
- Thu nhập dùng cho chi tiêu: ${fmtB(expAvailAfterInvest)}
- Tỷ lệ đầu tư: ${expInvestRatio}%
- Chi tiêu thiết yếu (Need): ${fmtB(expNeedTotal)}
- Chi tiêu muốn (Want): ${fmtB(expWantBudget)}

**Lịch sử thu nhập/chi tiêu gần đây:**
${recentHistory.map((r) => `- ${r.year}: Thu ${fmtB(r.income)}, Chi ${fmtB(r.expense)}, Tiết kiệm ${(num(r.savingsRate) * 100).toFixed(0)}%`).join("\n")}

**Mục tiêu FIRE:**
- Mục tiêu: ${fireTarget > 0 ? fmtB(fireTarget) : "Chưa đặt"}
- Chế độ tính: ${fireMode === "investment" ? "Tài sản đầu tư" : "Tổng tài sản ròng"}

${businessSummary.length > 0 ? `**Dự án kinh doanh:**\n${businessSummary.map((b) => `- ${b.name}: ${b.hasFCF ? `FCF dự báo ${b.fcfNext5Years?.map(fmtB).join(", ")}` : "Chưa có dữ liệu"}`).join("\n")}` : ""}

## Yêu cầu

Hãy trả về JSON với cấu trúc sau (KHÔNG thêm markdown code block, chỉ JSON thuần):
{
  "overview": "Tổng quan 2-3 câu về tình hình tài chính",
  "highlights": [
    { "type": "positive|warning|negative", "text": "Nhận xét ngắn gọn" }
  ],
  "suggestions": [
    { "area": "Tên lĩnh vực", "current": "Giá trị/thông số hiện tại", "suggested": "Đề xuất cụ thể", "reason": "Lý do ngắn gọn" }
  ],
  "risks": ["Rủi ro 1", "Rủi ro 2"]
}

Tối đa: 4 highlights, 3 suggestions, 2 risks. Tập trung vào điểm quan trọng nhất.`;

  // ── Call Claude ──────────────────────────────────────────────────────────────

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0]?.type === "text" ? message.content[0].text : "";

  // Parse JSON response
  let parsed: unknown = null;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // fall back to raw text
  }

  res.json({ analysis: parsed ?? { overview: rawText, highlights: [], suggestions: [], risks: [] } });
});

const YEARS_RANGE = Array.from({ length: 19 }, (_, i) => CURRENT_YEAR + i);

export default router;
