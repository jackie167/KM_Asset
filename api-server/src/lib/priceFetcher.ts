import * as cheerio from "cheerio";
import { db, pricesTable, holdingsTable, snapshotsTable, snapshotTypeValuesTable, priceHistoryTable } from "../../../lib/db/src/index.ts";
import { buildPriceHistoryRow, getUtcDayRange } from "./priceHistory.js";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { createPriceScheduler } from "./priceScheduler.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface PriceData {
  type: string;
  symbol: string;
  price: number;
  change: number | null;
  changePercent: number | null;
}

function normalizeHoldingType(type: string): string {
  return type.trim().toLowerCase();
}

const COINGECKO_ID_MAP: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  USDT: "tether",
  USDC: "usd-coin",
  ADA: "cardano",
  AVAX: "avalanche-2",
  DOGE: "dogecoin",
  TRX: "tron",
  SHIB: "shiba-inu",
  DOT: "polkadot",
  MATIC: "matic-network",
  LTC: "litecoin",
  ATOM: "cosmos",
  LINK: "chainlink",
  UNI: "uniswap",
  BCH: "bitcoin-cash",
  FIL: "filecoin",
  NEAR: "near",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  SUI: "sui",
  INJ: "injective-protocol",
  PEPE: "pepe",
  TON: "the-open-network",
  MNT: "mantle",
  SEI: "sei-network",
  BONK: "bonk",
  WIF: "dogwifcoin",
  JUP: "jupiter",
  RENDER: "render-token",
  WLD: "worldcoin-wld",
  HBAR: "hedera-hashgraph",
  VET: "vechain",
  ICP: "internet-computer",
  GRT: "the-graph",
  AAVE: "aave",
  PAXG: "pax-gold",
};

async function fetchCryptoPricesCoinGecko(symbols: string[]): Promise<PriceData[]> {
  const upper = symbols.map((s) => s.toUpperCase()).filter((s) => COINGECKO_ID_MAP[s]);
  if (upper.length === 0) return [];

  const idList = upper.map((s) => COINGECKO_ID_MAP[s]).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idList}&vs_currencies=vnd&include_24hr_change=true`;

  console.log(`[PriceFetcher] Fetching crypto prices from CoinGecko: ${upper.join(", ")}`);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[PriceFetcher] CoinGecko HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const json = await res.json() as Record<string, { vnd?: number; vnd_24h_change?: number }>;
    const results: PriceData[] = [];

    for (const sym of upper) {
      const id = COINGECKO_ID_MAP[sym];
      const data = json[id];
      if (!data?.vnd) {
        console.warn(`[PriceFetcher] CoinGecko: no VND price for ${sym} (id: ${id})`);
        continue;
      }
      console.log(`[PriceFetcher] ✅ ${sym}: ${data.vnd.toLocaleString()} VND/coin (${data.vnd_24h_change?.toFixed(2) ?? "n/a"}% 24h)`);
      results.push({
        type: "crypto",
        symbol: sym,
        price: data.vnd,
        change: null,
        changePercent: data.vnd_24h_change ?? null,
      });
    }

    return results;
  } catch (err: unknown) {
    console.error(`[PriceFetcher] CoinGecko error:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch a Vietnamese stock price using Yahoo Finance API (same backend as yfinance).
 * Vietnamese stocks use the ".VN" suffix (e.g. VNM.VN, HPG.VN).
 */
async function fetchStockPriceYahoo(symbol: string): Promise<PriceData | null> {
  const yahooSymbol = symbol.includes(".") ? symbol : `${symbol}.VN`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;

  console.log(`[PriceFetcher] Fetching stock ${yahooSymbol} from Yahoo Finance...`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[PriceFetcher] Yahoo Finance HTTP ${res.status} for ${yahooSymbol}: ${res.statusText}`);
      return null;
    }

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            currency?: string;
          };
        }>;
        error?: { code: string; description: string } | null;
      };
    };

    if (json.chart?.error) {
      console.error(`[PriceFetcher] Yahoo Finance API error for ${yahooSymbol}: ${json.chart.error.code} - ${json.chart.error.description}`);
      return null;
    }

    const meta = json.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) {
      console.error(`[PriceFetcher] No price data returned for ${yahooSymbol}. Response: ${JSON.stringify(json).slice(0, 300)}`);
      return null;
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose ?? null;
    const change = prevClose != null ? price - prevClose : null;
    const changePercent = prevClose != null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;

    const priceVND = price < 1000 ? price * 1000 : price;
    const changeVND = change != null ? (price < 1000 ? change * 1000 : change) : null;

    console.log(`[PriceFetcher] ✅ ${yahooSymbol}: ${priceVND.toLocaleString()} VND (${changePercent != null ? changePercent.toFixed(2) + "%" : "n/a"})`);

    return {
      type: "stock",
      symbol: symbol.toUpperCase(),
      price: priceVND,
      change: changeVND,
      changePercent,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === "TimeoutError" || err.message.includes("timeout")) {
        console.error(`[PriceFetcher] Timeout fetching ${yahooSymbol} from Yahoo Finance`);
      } else if (err.message.includes("fetch")) {
        console.error(`[PriceFetcher] Network error fetching ${yahooSymbol}: ${err.message}`);
      } else {
        console.error(`[PriceFetcher] Unexpected error for ${yahooSymbol}: ${err.message}`);
      }
    } else {
      console.error(`[PriceFetcher] Unknown error for ${yahooSymbol}:`, err);
    }
    return null;
  }
}

interface SJCApiResponse {
  success: boolean;
  latestDate?: string;
  data?: Array<{
    Id: number;
    TypeName: string;
    BranchName: string;
    Buy: string;
    BuyValue: number;
    Sell: string;
    SellValue: number;
  }>;
}

function normalizeSjcGoldPrice(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw >= 50_000_000 && raw <= 500_000_000) return raw;
  if (raw >= 50_000 && raw <= 500_000) return raw * 1_000;
  if (raw >= 50 && raw <= 500) return raw * 1_000_000;
  return null;
}

/**
 * Fetch gold price from SJC's official JSON API.
 * Primary: https://sjc.com.vn/GoldPrice/Services/PriceService.ashx
 * Fallback: HTML scraping of sjc.com.vn with cheerio (BeautifulSoup equivalent).
 */
async function fetchGoldPriceSJC(): Promise<PriceData[]> {
  const apiUrl = "https://sjc.com.vn/GoldPrice/Services/PriceService.ashx";
  console.log(`[PriceFetcher] Fetching gold price from SJC JSON API: ${apiUrl}`);

  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://sjc.com.vn/",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[PriceFetcher] SJC API HTTP ${res.status}: ${res.statusText} — falling back to HTML scraping`);
      return await fetchGoldPriceSJCHtmlFallback();
    }

    const json = await res.json() as SJCApiResponse;

    if (!json.success || !json.data || json.data.length === 0) {
      console.error(`[PriceFetcher] SJC API returned unexpected format: ${JSON.stringify(json).slice(0, 200)}`);
      return await fetchGoldPriceSJCHtmlFallback();
    }

    const luong1Entry = json.data.find((d) =>
      d.TypeName.toLowerCase().includes("1l") ||
      d.TypeName.toLowerCase().includes("1kg") ||
      d.TypeName.toLowerCase().includes("10l") ||
      (d.TypeName.toLowerCase().includes("sjc") && d.TypeName.toLowerCase().includes("lượng"))
    ) ?? json.data[0];

    const buyPrice = normalizeSjcGoldPrice(luong1Entry.BuyValue);
    if (!buyPrice || buyPrice <= 0) {
      console.error(`[PriceFetcher] SJC API: invalid BuyValue for ${luong1Entry.TypeName}: ${luong1Entry.BuyValue}`);
      return await fetchGoldPriceSJCHtmlFallback();
    }

    console.log(`[PriceFetcher] ✅ SJC Gold API (${json.latestDate}): ${luong1Entry.TypeName} Mua=${buyPrice.toLocaleString()} VND/lượng`);

    return [
      {
        type: "gold",
        symbol: "SJC_1L",
        price: buyPrice,
        change: null,
        changePercent: null,
      },
      {
        type: "gold",
        symbol: "SJC_1C",
        price: buyPrice / 10,
        change: null,
        changePercent: null,
      },
    ];
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === "TimeoutError" || err.message.includes("timeout")) {
        console.error(`[PriceFetcher] Timeout fetching gold price from SJC API`);
      } else if (err.message.includes("ENOTFOUND") || err.message.includes("ECONNREFUSED")) {
        console.error(`[PriceFetcher] Network/connection error for SJC API: ${err.message}`);
      } else {
        console.error(`[PriceFetcher] Error fetching SJC gold price: ${err.message}`);
      }
    } else {
      console.error(`[PriceFetcher] Unknown error fetching SJC gold price:`, err);
    }
    return await fetchGoldPriceSJCHtmlFallback();
  }
}

/**
 * Fallback: Scrape sjc.com.vn HTML using cheerio (Node.js equivalent of BeautifulSoup).
 * Uses User-Agent header to avoid being blocked.
 */
async function fetchGoldPriceSJCHtmlFallback(): Promise<PriceData[]> {
  console.log(`[PriceFetcher] Falling back to HTML scraping of https://sjc.com.vn/`);
  try {
    const res = await fetch("https://sjc.com.vn/", {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
        "Referer": "https://sjc.com.vn/",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[PriceFetcher] SJC HTML fallback HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    let buyPrice: number | null = null;

    $("table tr").each((_i, row) => {
      if (buyPrice) return false;
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const rowText = $(row).text().toLowerCase();
      if (
        rowText.includes("1l") ||
        rowText.includes("1 lượng") ||
        rowText.includes("10l") ||
        rowText.includes("1kg") ||
        (rowText.includes("sjc") && rowText.includes("miếng"))
      ) {
        const buyCell = $(cells[1]).text().replace(/[^0-9]/g, "");
        const num = parseInt(buyCell, 10);
        if (!isNaN(num)) {
          buyPrice = normalizeSjcGoldPrice(num);
        }
      }
    });

    if (buyPrice != null) {
      console.log(`[PriceFetcher] ✅ SJC Gold (HTML scrape): ${(buyPrice as number).toLocaleString()} VND/lượng`);
      return [
        { type: "gold", symbol: "SJC_1L", price: buyPrice as number, change: null, changePercent: null },
        { type: "gold", symbol: "SJC_1C", price: (buyPrice as number) / 10, change: null, changePercent: null },
      ];
    }

    console.error(`[PriceFetcher] HTML scrape: could not find gold price in ${html.length} bytes. Check SJC page structure.`);
    return [];
  } catch (err: unknown) {
    console.error(`[PriceFetcher] SJC HTML fallback error:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export async function fetchAndStorePrices(): Promise<{ updated: number; message: string }> {
  const holdings = await db.select().from(holdingsTable);
  if (!holdings.length) {
    console.log("[PriceFetcher] No holdings found, skipping price fetch.");
    return { updated: 0, message: "No holdings to update" };
  }

  const stockSymbols = [
    ...new Set(holdings.filter((h) => normalizeHoldingType(h.type) === "stock").map((h) => h.symbol.toUpperCase())),
  ];
  const goldSymbols = [
    ...new Set(holdings.filter((h) => normalizeHoldingType(h.type) === "gold").map((h) => h.symbol.toUpperCase())),
  ];
  const hasGold = goldSymbols.length > 0;

  // Detect crypto: non-stock/gold holdings whose symbol is in the CoinGecko map
  const cryptoSymbols = [
    ...new Set(
      holdings
        .filter((h) => {
          const normalizedType = normalizeHoldingType(h.type);
          return normalizedType !== "stock" && normalizedType !== "gold";
        })
        .map((h) => h.symbol.toUpperCase())
        .filter((s) => COINGECKO_ID_MAP[s])
    ),
  ];

  console.log(
    `[PriceFetcher] Starting fetch for ${stockSymbols.length} stock(s)` +
    `${hasGold ? " + gold(SJC benchmark)" : ""}` +
    `${cryptoSymbols.length ? ` + crypto (${cryptoSymbols.join(", ")})` : ""}`
  );

  const stockPromises = stockSymbols.map(fetchStockPriceYahoo);
  const [stockResults, sjcGoldResults, cryptoResults] = await Promise.all([
    Promise.all(stockPromises),
    hasGold ? fetchGoldPriceSJC() : Promise.resolve([] as PriceData[]),
    cryptoSymbols.length ? fetchCryptoPricesCoinGecko(cryptoSymbols) : Promise.resolve([] as PriceData[]),
  ]);

  const goldBenchmark = sjcGoldResults.find((price) => price.symbol.toUpperCase() === "SJC_1L") ?? sjcGoldResults[0] ?? null;
  const normalizedGoldResults =
    goldBenchmark != null
      ? goldSymbols.map((symbol) => ({
          ...goldBenchmark,
          symbol,
          type: "gold",
        }))
      : [];

  const prices: PriceData[] = [
    ...stockResults.filter((p): p is PriceData => p !== null),
    ...normalizedGoldResults,
    ...cryptoResults,
  ];

  if (!prices.length) {
    console.error("[PriceFetcher] No prices fetched successfully. Check logs above for details.");
    return { updated: 0, message: "Could not fetch prices — check server logs for details" };
  }

  const fetchedAt = new Date();
  for (const p of prices) {
    await db.insert(pricesTable).values({
      type: p.type,
      symbol: p.symbol,
      price: String(p.price),
      change: p.change != null ? String(p.change) : null,
      changePercent: p.changePercent != null ? String(p.changePercent) : null,
      fetchedAt,
    });
  }

  const holdingBySymbol = new Map(holdings.map((holding) => [holding.symbol.toUpperCase(), holding]));
  const { start: historyDayStart, end: historyDayEnd } = getUtcDayRange(fetchedAt);
  for (const price of prices) {
    const holding = holdingBySymbol.get(price.symbol.toUpperCase());
    const quantity = holding ? parseFloat(String(holding.quantity)) : null;
    const historyRow = buildPriceHistoryRow({
        assetCode: price.symbol,
        assetType: price.type,
        priceOrValue: price.price,
        quantity,
        source: "online_api",
        note: "daily online price",
        priceAt: fetchedAt,
    });
    const [existing] = await db
      .select({ id: priceHistoryTable.id })
      .from(priceHistoryTable)
      .where(
        and(
          eq(priceHistoryTable.assetCode, price.symbol.toUpperCase()),
          eq(priceHistoryTable.source, "online_api"),
          gte(priceHistoryTable.priceAt, historyDayStart),
          lt(priceHistoryTable.priceAt, historyDayEnd),
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(priceHistoryTable)
        .set(historyRow)
        .where(eq(priceHistoryTable.id, existing.id));
    } else {
      await db.insert(priceHistoryTable).values(historyRow);
    }
  }

  await savePortfolioSnapshot(holdings, prices);

  console.log(`[PriceFetcher] Done. Updated ${prices.length} price(s).`);
  return { updated: prices.length, message: `Updated ${prices.length} price(s)` };
}

async function savePortfolioSnapshot(
  holdings: typeof holdingsTable.$inferSelect[],
  prices: PriceData[]
): Promise<void> {
  const priceMap = new Map<string, number>();
  for (const p of prices) {
    priceMap.set(p.symbol.toUpperCase(), p.price);
  }
  const latestStoredPrices = await getLatestPrices();
  for (const p of latestStoredPrices) {
    const symbol = p.symbol.toUpperCase();
    if (!priceMap.has(symbol)) {
      priceMap.set(symbol, parseFloat(String(p.price)));
    }
  }

  let stockValue = 0;
  let goldValue = 0;
  let otherValue = 0;
  const typeTotals = new Map<string, number>();

  for (const h of holdings) {
    const qty = parseFloat(String(h.quantity));
    const sym = h.symbol.toUpperCase();
    const price = priceMap.get(sym) ?? (h.manualPrice != null ? parseFloat(String(h.manualPrice)) : null);
    if (price == null) continue;
    const val = qty * price;
    const normalizedType = normalizeHoldingType(h.type);
    typeTotals.set(normalizedType, (typeTotals.get(normalizedType) ?? 0) + val);
    if (normalizedType === "stock") stockValue += val;
    else if (normalizedType === "gold") goldValue += val;
    else otherValue += val;
  }

  const totalValue = stockValue + goldValue + otherValue;
  if (totalValue > 0) {
    await db.transaction(async (tx) => {
      const [snapshot] = await tx
        .insert(snapshotsTable)
        .values({
          totalValue: String(totalValue),
          stockValue: String(stockValue),
          goldValue: String(goldValue),
          snapshotAt: new Date(),
        })
        .returning({ id: snapshotsTable.id });

      if (snapshot && typeTotals.size > 0) {
        await tx.insert(snapshotTypeValuesTable).values(
          Array.from(typeTotals.entries()).map(([type, value]) => ({
            snapshotId: snapshot.id,
            type,
            value: String(value),
          })),
        );
      }
    });
    console.log(`[PriceFetcher] Snapshot saved: total=${totalValue.toLocaleString()} VND`);
  }
}

export async function getLatestPrices(): Promise<typeof pricesTable.$inferSelect[]> {
  const rows = await db
    .select()
    .from(pricesTable)
    .orderBy(desc(pricesTable.fetchedAt));

  const seen = new Set<string>();
  const result: typeof pricesTable.$inferSelect[] = [];
  for (const row of rows) {
    if (!seen.has(row.symbol)) {
      seen.add(row.symbol);
      result.push(row);
    }
  }
  return result;
}

export const PRICE_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
let priceScheduler: ReturnType<typeof createPriceScheduler> | null = null;

type SchedulerDeps = {
  runFetch?: typeof fetchAndStorePrices;
  now?: () => number;
  log?: Pick<Console, "log" | "error">;
};

export function startPriceScheduler(deps: SchedulerDeps = {}): void {
  if (priceScheduler) return;

  const runFetch = deps.runFetch ?? fetchAndStorePrices;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  priceScheduler = createPriceScheduler({
    intervalMs: PRICE_SCHEDULER_INTERVAL_MS,
    now,
    log,
    startMessage: "[PriceFetcher] Starting price scheduler (every 60 minutes)",
    runTask: async () => {
      const result = await runFetch();
      log.log("[PriceFetcher] Scheduled fetch result:", result.message);
    },
  });
  priceScheduler.start();
}

export function stopPriceScheduler(): void {
  if (priceScheduler) {
    priceScheduler.stop();
    priceScheduler = null;
  }
}
