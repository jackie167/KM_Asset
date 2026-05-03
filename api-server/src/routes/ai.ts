import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { asc } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  baseAssetsTable,
  expenseForecastTable,
  incomeExpenseTable,
} from "../../../lib/db/src/index.ts";

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

router.post("/ai/analyze", async (_req, res): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY chưa được cấu hình." });
    return;
  }

  // ── Thu thập dữ liệu (chỉ từ Expense Forecast + Base Assets + Lịch sử) ──────

  const [expForecasts, baseAssets, incomeExp, allSettings] = await Promise.all([
    db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year)),
    db.select().from(baseAssetsTable),
    db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year)),
    db.select().from(appSettingsTable),
  ]);

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

  // ── Expense Forecast — nguồn duy nhất cho thu/chi/đầu tư ─────────────────────

  const fcRows = expForecasts.slice(0, 10); // tối đa 10 năm tới

  const fcTable = fcRows.map((r) => {
    const income      = num(r.income) + num(r.otherIncome);
    const investRatio = num(r.investmentRatio);
    const invest      = income * (investRatio / 100);
    const needTotal   = num(r.needLiving) + num(r.needTuition) + num(r.needAllowance) + num(r.needMaintenance);
    const want        = num(r.wantBudget);
    const balance     = income - invest - needTotal - want;
    const aN          = r.actualNeed != null ? num(r.actualNeed) : null;
    const aW          = r.actualWant != null ? num(r.actualWant) : null;

    const actualStr = (aN != null || aW != null)
      ? ` | thực tế: need ${aN != null ? fmtB(aN) : "—"}, want ${aW != null ? fmtB(aW) : "—"}`
      : "";

    return `${r.year}: thu ${fmtB(income)}, đầu tư ${investRatio.toFixed(0)}% (${fmtB(invest)}), need ${fmtB(needTotal)}, want ${fmtB(want)}, số dư ${fmtB(balance)}${actualStr}`;
  }).join("\n");

  // Năm hiện tại
  const curRow      = expForecasts.find((r) => r.year === CURRENT_YEAR);
  const curIncome   = num(curRow?.income) + num(curRow?.otherIncome);
  const curInvest   = curIncome * (num(curRow?.investmentRatio) / 100);
  const curNeed     = num(curRow?.needLiving) + num(curRow?.needTuition) + num(curRow?.needAllowance) + num(curRow?.needMaintenance);
  const curWant     = num(curRow?.wantBudget);

  // ── Lịch sử thu chi thực tế ───────────────────────────────────────────────────

  const history = incomeExp.slice(-4).map((r) =>
    `${r.year}: thu ${fmtB(num(r.income))}, chi ${fmtB(num(r.expense))}, tiết kiệm ${(num(r.savingsRate) * 100).toFixed(0)}%`
  ).join("\n");

  // ── FIRE ──────────────────────────────────────────────────────────────────────

  const fireTarget  = num(settings["fire_target"]) || 0;
  const fireMonthly = num(settings["fire_monthly_expense"]) || 0;
  const fireMode    = settings["fire_asset_mode"] || "investment";

  // ── Prompt ────────────────────────────────────────────────────────────────────

  const prompt = `Bạn là chuyên gia tài chính cá nhân. Phân tích tài chính và trả về TIẾNG VIỆT.

## Tài sản (đầu năm ${CURRENT_YEAR})
Tổng: ${fmtB(totalAssets)}
Phân loại: ${assetBreakdown}

## Kế hoạch thu/chi/đầu tư (từ bảng Expense Forecast)
${fcTable}

## Năm ${CURRENT_YEAR} — tổng hợp
Thu nhập: ${fmtB(curIncome)} | Đầu tư: ${fmtB(curInvest)} | Need: ${fmtB(curNeed)} | Want: ${fmtB(curWant)}

## Lịch sử thực tế
${history || "(chưa có dữ liệu)"}

## Mục tiêu FIRE
Mục tiêu: ${fireTarget > 0 ? fmtB(fireTarget) : "Chưa đặt"}
Chi tiêu/tháng sau FIRE: ${fireMonthly > 0 ? fmtB(fireMonthly) : "Chưa đặt"}
Chế độ: ${fireMode === "investment" ? "Tài sản đầu tư" : "Tổng tài sản ròng"}

## Yêu cầu
Trả về JSON THUẦN (không markdown code block):
{"overview":"2-3 câu tổng quan","highlights":[{"type":"positive|warning|negative","text":"ngắn gọn"}],"suggestions":[{"area":"lĩnh vực","current":"giá trị hiện tại","suggested":"đề xuất cụ thể","reason":"lý do"}],"risks":["rủi ro"]}

Giới hạn: 4 highlights, 3 suggestions, 2 risks. Ngắn gọn, số liệu cụ thể.`;

  // ── Gọi Claude ────────────────────────────────────────────────────────────────

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    try {
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch { /* trả raw */ }
  }

  res.json({
    analysis: parsed ?? { overview: rawText, highlights: [], suggestions: [], risks: [] },
  });
});

export default router;
