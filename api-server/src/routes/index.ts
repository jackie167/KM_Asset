import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import holdingsRouter from "./holdings.js";
import pricesRouter from "./prices.js";
import snapshotsRouter from "./snapshots.js";
import importRouter from "./import.js";
import excelRouter from "./excel.js";
import transactionsRouter from "./transactions.js";
import expensesRouter from "./expenses.js";
import wealthRouter from "./wealth.js";
import forecastRouter from "./forecast.js";
import settingsRouter from "./settings.js";
import baseAssetsRouter from "./baseAssets.js";
import incomeExpenseRouter from "./incomeExpense.js";
import expenseForecastRouter from "./expenseForecast.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(importRouter);
router.use(excelRouter);
router.use(holdingsRouter);
router.use(transactionsRouter);
router.use(expensesRouter);
router.use(wealthRouter);
router.use(forecastRouter);
router.use(settingsRouter);
router.use(baseAssetsRouter);
router.use(incomeExpenseRouter);
router.use(expenseForecastRouter);
router.use(pricesRouter);
router.use(snapshotsRouter);

export default router;
