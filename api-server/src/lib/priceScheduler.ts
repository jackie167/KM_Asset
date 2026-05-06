export type PriceSchedulerDeps = {
  intervalMs: number;
  runTask: () => Promise<void>;
  now?: () => number;
  log?: Pick<Console, "log" | "error">;
  startMessage?: string;
};

export function createPriceScheduler({
  intervalMs,
  runTask,
  now = Date.now,
  log = console,
  startMessage = `[PriceFetcher] Starting price scheduler (every ${Math.round(intervalMs / 60000)} minutes)`,
}: PriceSchedulerDeps) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  const runScheduledTask = () => {
    if (!active) return;
    log.log("[PriceFetcher] Running scheduled price fetch...");
    runTask()
      .catch((error) => log.error("[PriceFetcher] Scheduled fetch failed:", error))
      .finally(() => {
        if (!active) return;
        const nextRun = new Date(now() + intervalMs);
        log.log(`[PriceFetcher] Next scheduled fetch at ${nextRun.toISOString()}`);
        timeout = setTimeout(() => {
          timeout = null;
          runScheduledTask();
        }, intervalMs);
      });
  };

  return {
    start() {
      if (active) return;
      active = true;
      log.log(startMessage);
      runScheduledTask();
    },
    stop() {
      active = false;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
  };
}
