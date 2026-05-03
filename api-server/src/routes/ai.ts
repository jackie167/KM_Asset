import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  baseAssetsTable,
  expenseForecastTable,
  holdingsTable,
  incomeExpenseTable,
  wealthSnapshotsTable,
  wealthSnapshotItemsTable,
  incomeSourcesTable,
  incomeProjectCalcTable,
  incomeForecastTable,
  priceHistoryTable,
} from "../../../lib/db/src/index.ts";

const router: IRouter = Router();

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_START = 2026;
const YEAR_END   = 2044;
const YEARS = Array.from({ length: YEAR_END - YEAR_START + 1 }, (_, i) => YEAR_START + i);

function num(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type CalcType = "direct" | "per_ha";

function computeFCF(inp: Record<string, number>, calcType: CalcType = "direct"): number {
  const g = (id: string) => inp[id] ?? 0;
  const revenue = calcType === "per_ha"
    ? g("area") * g("yield_per_ha") * g("price")
    : g("revenue_direct");
  const cogs = calcType === "per_ha"
    ? g("area") * (g("cogs_material") + g("cogs_labor") + g("cogs_overhead"))
    : g("cogs_direct");
  const depreciation = g("depreciation");
  const ebit         = (revenue - cogs) - depreciation - g("interest") - g("sga");
  const net_profit   = ebit - Math.max(0, ebit) * (g("tax_rate") / 100);
  return net_profit + depreciation - g("capex") - g("delta_wc");
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
      const projected = YEARS.slice(0, 5).map((y) => `${y}: ${fmtB(base * Math.pow(1 + rate / 100, y - YEAR_START))}`).join(", ");
      return `- ${src.name} (${src.type}, tăng trưởng ${rate}%/năm): ${projected}…`;
    }
    const stored = fcBySource[src.id] ?? {};
    const byYear = YEARS.filter((y) => stored[y]).map((y) => `${y}: ${fmtB(stored[y]!)}`).join(", ");
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
    const fcfYears = YEARS.map((year) => {
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

  const [expForecasts, baseAssets, incomeExp, allSettings, activeSources, calcEntries, forecastEntries] = await fetchAllData();

  const settings = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));
  const context = buildFinancialContext(expForecasts, baseAssets, incomeExp, allSettings, activeSources, calcEntries, forecastEntries);

  // Current year summary for the prompt
  const curRow    = expForecasts.find((r) => r.year === CURRENT_YEAR);
  const curIncome = num(curRow?.income) + num(curRow?.otherIncome);
  const curInvest = curIncome * (num(curRow?.investmentRatio) / 100);
  const curNeed   = num(curRow?.needLiving) + num(curRow?.needTuition) + num(curRow?.needAllowance) + num(curRow?.needMaintenance);
  const curWant   = num(curRow?.wantBudget);
  void settings;

  const prompt = `Bạn là chuyên gia tài chính cá nhân. Phân tích tài chính và trả về TIẾNG VIỆT.

${context}

## Năm ${CURRENT_YEAR} — tổng hợp
Thu nhập: ${fmtB(curIncome)} | Đầu tư: ${fmtB(curInvest)} | Need: ${fmtB(curNeed)} | Want: ${fmtB(curWant)}

## Yêu cầu
Trả về JSON THUẦN (không markdown code block):
{"overview":"2-3 câu tổng quan","highlights":[{"type":"positive|warning|negative","text":"ngắn gọn"}],"suggestions":[{"area":"lĩnh vực","current":"giá trị hiện tại","suggested":"đề xuất cụ thể","reason":"lý do"}],"risks":["rủi ro"]}

Giới hạn: 4 highlights, 3 suggestions, 2 risks. Ngắn gọn, số liệu cụ thể.`;

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown = null;
  try { parsed = JSON.parse(stripped); } catch {
    try { const m = stripped.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { /* raw */ }
  }

  res.json({ analysis: parsed ?? { overview: rawText, highlights: [], suggestions: [], risks: [] } });
});

// ─── Chat tools ───────────────────────────────────────────────────────────────

const CHAT_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "get_expense_forecast",
    description: "Kế hoạch thu nhập, chi tiêu, đầu tư từng năm (Expense Forecast). Dùng khi hỏi về thu nhập kế hoạch, tỷ lệ đầu tư, chi tiêu need/want, số dư theo năm.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_income_forecast",
    description: "Danh sách nguồn thu nhập và FCF từng năm (Income Forecast). Dùng khi hỏi về nguồn thu cụ thể, FCF dự án kinh doanh, dự báo thu nhập từng nguồn.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_assets",
    description: "Tổng tài sản và chi tiết từng tài sản cơ bản (bất động sản, tiền mặt, đất...). Dùng khi hỏi về giá trị tài sản, phân loại tài sản cơ bản.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_holdings_snapshot",
    description: "Danh mục đầu tư hiện tại (cổ phiếu, quỹ, crypto, vàng...) gồm giá trị thị trường, vốn, P/L. Dùng khi hỏi về danh mục đầu tư, lãi lỗ, tỷ trọng tài sản tài chính.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_fire_status",
    description: "Mục tiêu và thông số FIRE (tỷ lệ rút, lãi suất kỳ vọng, tuổi mục tiêu, chi tiêu sau FIRE). Dùng khi hỏi về FIRE, tự do tài chính, bao lâu đạt FIRE.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_history",
    description: "Lịch sử thu chi thực tế các năm trước. Dùng khi hỏi về lịch sử, xu hướng, so sánh kế hoạch với thực tế.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_wealth_snapshot",
    description: "Snapshot tài sản ròng mới nhất: tổng tài sản, nợ, tài sản ròng và phân bổ theo từng loại (bất động sản, cổ phiếu, tiền mặt, vàng...). Dùng khi hỏi về tài sản hiện tại, phân bổ tài sản, tài sản ròng.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────────

async function toolGetExpenseForecast(): Promise<string> {
  const rows = await db.select().from(expenseForecastTable).orderBy(asc(expenseForecastTable.year));
  if (rows.length === 0) return "Chưa có dữ liệu Expense Forecast.";
  const lines = rows.map((r) => {
    const income      = num(r.income) + num(r.otherIncome);
    const investRatio = num(r.investmentRatio);
    const invest      = income * (investRatio / 100);
    const needTotal   = num(r.needLiving) + num(r.needTuition) + num(r.needAllowance) + num(r.needMaintenance);
    const want        = num(r.wantBudget);
    const balance     = income - invest - needTotal - want;
    const aN = r.actualNeed != null ? num(r.actualNeed) : null;
    const aW = r.actualWant != null ? num(r.actualWant) : null;
    const actual = (aN != null || aW != null)
      ? ` | thực tế need=${aN != null ? fmtB(aN) : "—"} want=${aW != null ? fmtB(aW) : "—"}`
      : "";
    return `${r.year}: thu ${fmtB(income)}, đầu tư ${investRatio.toFixed(0)}%(${fmtB(invest)}), need ${fmtB(needTotal)}, want ${fmtB(want)}, số dư ${fmtB(balance)}${actual}`;
  });
  return `Expense Forecast (${rows.length} năm):\n${lines.join("\n")}`;
}

async function toolGetIncomeForecast(): Promise<string> {
  const [sources, forecastEntries, calcEntries] = await Promise.all([
    db.select().from(incomeSourcesTable).where(eq(incomeSourcesTable.active, true)),
    db.select().from(incomeForecastTable).orderBy(asc(incomeForecastTable.year)),
    db.select().from(incomeProjectCalcTable),
  ]);
  if (sources.length === 0) return "Chưa có nguồn thu nhập.";

  const fcBySource: Record<number, Record<number, number>> = {};
  for (const e of forecastEntries) {
    fcBySource[e.sourceId] ??= {};
    fcBySource[e.sourceId]![e.year] = num(e.amount);
  }

  const calcBySource: Record<number, typeof calcEntries> = {};
  for (const e of calcEntries) { calcBySource[e.sourceId] ??= []; calcBySource[e.sourceId]!.push(e); }

  const lines = sources.map((src) => {
    if (src.type === "business") {
      const rows = calcBySource[src.id] ?? [];
      let calcType: CalcType = "direct";
      const vals: Record<string, Record<number, number>> = {};
      for (const e of rows) {
        if (e.rowId === "_calc_type") { calcType = num(e.value) === 1 ? "per_ha" : "direct"; continue; }
        vals[e.rowId] ??= {};
        vals[e.rowId]![e.year] = num(e.value);
      }
      const fcfYears = YEARS.map((year) => {
        const inp: Record<string, number> = {};
        for (const [rowId, ym] of Object.entries(vals)) inp[rowId] = ym[year] ?? 0;
        return { year, fcf: computeFCF(inp, calcType) };
      }).filter((x) => x.fcf !== 0).map((x) => `${x.year}:${fmtB(x.fcf)}`).join(", ");
      return `- ${src.name} [kinh doanh]: FCF ${fcfYears || "chưa nhập"}`;
    }
    if (src.forecastMode === "growth" && num(src.forecastBase) > 0) {
      const base = num(src.forecastBase);
      const rate = num(src.forecastRate);
      const sample = YEARS.slice(0, 5).map((y) => `${y}:${fmtB(base * Math.pow(1 + rate / 100, y - YEAR_START))}`).join(", ");
      return `- ${src.name} [${src.type}, tăng ${rate}%/năm]: ${sample}…`;
    }
    const stored = fcBySource[src.id] ?? {};
    const byYear = YEARS.filter((y) => stored[y]).map((y) => `${y}:${fmtB(stored[y]!)}`).join(", ");
    return `- ${src.name} [${src.type}]: ${byYear || "chưa nhập"}`;
  });
  return `Nguồn thu nhập (${sources.length} nguồn):\n${lines.join("\n")}`;
}

async function toolGetAssets(): Promise<string> {
  const rows = await db.select().from(baseAssetsTable);
  if (rows.length === 0) return "Chưa có dữ liệu tài sản cơ bản.";
  const total = rows.reduce((s, a) => s + num(a.baseValue), 0);
  const lines = rows.map((a) =>
    `- ${a.symbol} (${a.assetType}): ${fmtB(num(a.baseValue))} (${((num(a.baseValue) / total) * 100).toFixed(1)}%)`
  );
  return `Tài sản cơ bản — tổng ${fmtB(total)}:\n${lines.join("\n")}`;
}

async function toolGetHoldingsSnapshot(): Promise<string> {
  const [holdings, latestPriceRows] = await Promise.all([
    db.select().from(holdingsTable),
    db.selectDistinctOn([priceHistoryTable.assetCode], {
      assetCode: priceHistoryTable.assetCode,
      assetType: priceHistoryTable.assetType,
      priceOrValue: priceHistoryTable.priceOrValue,
      currentValue: priceHistoryTable.currentValue,
    })
      .from(priceHistoryTable)
      .orderBy(priceHistoryTable.assetCode, desc(priceHistoryTable.priceAt)),
  ]);

  if (holdings.length === 0) return "Chưa có dữ liệu danh mục đầu tư.";

  const priceMap = new Map<string, number>();
  for (const p of latestPriceRows) {
    const val = num(p.currentValue) || num(p.priceOrValue);
    if (val > 0) priceMap.set(p.assetCode.toUpperCase(), val);
  }

  const usesManual = (type: string) => {
    const t = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return t !== "stock" && t !== "gold" && t !== "crypto";
  };

  let totalValue = 0;
  let totalCost  = 0;
  const lines: string[] = [];

  for (const h of holdings) {
    const qty      = num(h.quantity);
    const manual   = num(h.manualPrice);
    const cost     = num(h.costOfCapital);
    const interest = num(h.interest);
    const latestPrice = priceMap.get(h.symbol.toUpperCase()) ?? manual;

    const currentValue = usesManual(h.type)
      ? (latestPrice || manual)
      : qty * (latestPrice || manual);

    const unrealized = cost > 0 && currentValue > 0 ? currentValue - cost : null;
    const totalPnL   = unrealized != null ? unrealized + interest : interest > 0 ? interest : null;

    totalValue += currentValue;
    totalCost  += cost;

    const pnlStr = totalPnL != null
      ? ` | P/L ${totalPnL >= 0 ? "+" : ""}${fmtB(totalPnL)}`
      : "";
    lines.push(`- ${h.symbol} (${h.type}): ${fmtB(currentValue)}, vốn ${fmtB(cost)}${pnlStr}`);
  }

  const totalPnL = totalValue - totalCost;
  return [
    `Danh mục đầu tư — ${holdings.length} tài sản`,
    `Tổng giá trị: ${fmtB(totalValue)} | Vốn: ${fmtB(totalCost)} | P/L: ${totalPnL >= 0 ? "+" : ""}${fmtB(totalPnL)}`,
    "",
    ...lines,
  ].join("\n");
}

async function toolGetFireStatus(): Promise<string> {
  const allSettings = await db.select().from(appSettingsTable);
  const s = Object.fromEntries(allSettings.map((r) => [r.key, r.value ?? ""]));
  const fireWR        = num(s["fire_wr"]) || 4;
  const fireRet       = num(s["fire_ret"]) || 8;
  const fireAge       = num(s["fire_age"]) || 0;
  const fireTargetAge = num(s["fire_target_age"]) || 0;
  const fireSpend     = num(s["fire_spend"]) || 0;
  const fireMode      = s["fire_asset_mode"] || "investment";
  const fireTarget    = fireWR > 0 ? (fireSpend * 12) / (fireWR / 100) : 0;
  const yearsToFire   = fireTargetAge > 0 && fireAge > 0 ? Math.max(0, fireTargetAge - fireAge) : 0;
  return [
    `FIRE Settings:`,
    `Mục tiêu tài sản: ${fireTarget > 0 ? fmtB(fireTarget) : "Chưa đặt"}`,
    `Chi tiêu/tháng sau FIRE: ${fireSpend > 0 ? fmtB(fireSpend) : "Chưa đặt"}`,
    `Tỷ lệ rút (WR): ${fireWR}% | Lãi suất kỳ vọng: ${fireRet}%`,
    `Tuổi hiện tại: ${fireAge || "Chưa đặt"} | Tuổi FIRE mục tiêu: ${fireTargetAge || "Chưa đặt"}`,
    yearsToFire > 0 ? `Còn ${yearsToFire} năm đến FIRE` : "",
    `Chế độ: ${fireMode === "investment" ? "Tài sản đầu tư" : "Tổng tài sản ròng"}`,
  ].filter(Boolean).join("\n");
}

async function toolGetWealthSnapshot(): Promise<string> {
  const snapshot = await db
    .select()
    .from(wealthSnapshotsTable)
    .orderBy(desc(wealthSnapshotsTable.snapshotAt))
    .limit(1);

  if (snapshot.length === 0) return "Chưa có dữ liệu wealth snapshot.";

  const snap = snapshot[0]!;
  const items = await db
    .select()
    .from(wealthSnapshotItemsTable)
    .where(eq(wealthSnapshotItemsTable.snapshotId, snap.id));

  const date = snap.snapshotAt.toLocaleDateString("vi-VN");
  const breakdown = items
    .sort((a, b) => num(b.value) - num(a.value))
    .map((item) => {
      const pct = num(snap.totalAsset) > 0
        ? ` (${((num(item.value) / num(snap.totalAsset)) * 100).toFixed(1)}%)`
        : "";
      return `- ${item.label ?? item.type}: ${fmtB(num(item.value))}${pct}`;
    })
    .join("\n");

  return [
    `Wealth Snapshot (${date}):`,
    `Tổng tài sản: ${fmtB(num(snap.totalAsset))}`,
    `Nợ: ${fmtB(num(snap.debt))}`,
    `Tài sản ròng: ${fmtB(num(snap.netAsset))}`,
    "",
    "Phân bổ theo loại:",
    breakdown || "(không có chi tiết)",
  ].join("\n");
}

async function toolGetHistory(): Promise<string> {
  const rows = await db.select().from(incomeExpenseTable).orderBy(asc(incomeExpenseTable.year));
  if (rows.length === 0) return "Chưa có dữ liệu lịch sử.";
  const lines = rows.map((r) => {
    const inc = num(r.income) + num(r.otherIncome);
    const exp = num(r.expense) + num(r.otherExpense);
    const savingsPct = inc > 0 ? (((inc - exp) / inc) * 100).toFixed(0) : "—";
    return `${r.year}: thu ${fmtB(inc)}, chi ${fmtB(exp)}, tiết kiệm ${savingsPct}%`;
  });
  return `Lịch sử thu chi thực tế:\n${lines.join("\n")}`;
}

async function executeTool(name: string): Promise<string> {
  switch (name) {
    case "get_expense_forecast":   return toolGetExpenseForecast();
    case "get_income_forecast":    return toolGetIncomeForecast();
    case "get_assets":             return toolGetAssets();
    case "get_holdings_snapshot":  return toolGetHoldingsSnapshot();
    case "get_fire_status":        return toolGetFireStatus();
    case "get_history":            return toolGetHistory();
    case "get_wealth_snapshot":    return toolGetWealthSnapshot();
    default: return `Tool "${name}" không tồn tại.`;
  }
}

// ─── POST /ai/chat ────────────────────────────────────────────────────────────

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

  const systemPrompt = `Bạn là trợ lý tài chính cá nhân. Sử dụng các tool để lấy đúng dữ liệu cần thiết trước khi trả lời — không đoán mò số liệu.
Nguyên tắc: chỉ đọc dữ liệu, KHÔNG đề xuất thao tác hệ thống. Trả lời bằng TIẾNG VIỆT, ngắn gọn, kèm số liệu cụ thể. Tính toán thì trình bày từng bước.`;

  // Agentic loop: Claude gọi tool → server thực thi → Claude nhận kết quả → lặp cho đến khi có câu trả lời
  const messages: Anthropic.Messages.MessageParam[] = [
    ...historyMsgs,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    tools: CHAT_TOOLS,
    messages,
  });

  let iterations = 0;
  while (response.stop_reason === "tool_use" && iterations < 5) {
    iterations++;
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    // Execute all requested tools in parallel
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result,
        };
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      tools: CHAT_TOOLS,
      messages,
    });
  }

  const text = response.content.find((b) => b.type === "text")
    ? (response.content.find((b) => b.type === "text") as Anthropic.Messages.TextBlock).text.trim()
    : "";

  res.json({ response: text });
});

export default router;
