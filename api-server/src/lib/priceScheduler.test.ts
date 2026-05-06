import { afterEach, describe, expect, it, vi } from "vitest";
import { createPriceScheduler } from "./priceScheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPriceScheduler", () => {
  it("runs immediately and then schedules the next run after the configured interval", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const runTask = vi.fn().mockResolvedValue(undefined);
    const log = { log: vi.fn(), error: vi.fn() };
    const scheduler = createPriceScheduler({
      intervalMs: 60 * 60 * 1000,
      runTask,
      now: () => Date.now(),
      log,
      startMessage: "[PriceFetcher] Starting price scheduler (every 60 minutes)",
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(runTask).toHaveBeenCalledTimes(2);
    expect(log.log).toHaveBeenCalledWith("[PriceFetcher] Starting price scheduler (every 60 minutes)");
    expect(log.log).toHaveBeenCalledWith("[PriceFetcher] Running scheduled price fetch...");
    expect(log.log).toHaveBeenCalledWith(
      `[PriceFetcher] Next scheduled fetch at ${new Date(now + 60 * 60 * 1000).toISOString()}`
    );
  });

  it("does not start again while an existing schedule is active", () => {
    vi.useFakeTimers();

    const runTask = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPriceScheduler({
      intervalMs: 60 * 60 * 1000,
      runTask,
    });

    scheduler.start();
    scheduler.start();

    expect(runTask).toHaveBeenCalledTimes(1);
  });
});
