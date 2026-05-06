import { afterEach, describe, expect, it, vi } from "vitest";

const schedulerState = {
  start: vi.fn(),
  stop: vi.fn(),
};

const createPriceSchedulerMock = vi.fn(() => schedulerState);

vi.mock("./priceScheduler.js", () => ({
  createPriceScheduler: createPriceSchedulerMock,
}));

afterEach(() => {
  delete process.env.DATABASE_URL;
  createPriceSchedulerMock.mockClear();
  schedulerState.start.mockClear();
  schedulerState.stop.mockClear();
  vi.resetModules();
});

describe("priceFetcher scheduler wrapper", () => {
  it("creates and starts the scheduler only once", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const { startPriceScheduler, stopPriceScheduler } = await import("./priceFetcher.js");
    const runFetch = vi.fn().mockResolvedValue({ updated: 1, message: "ok" });
    const log = { log: vi.fn(), error: vi.fn() };

    startPriceScheduler({ runFetch, log });
    startPriceScheduler({ runFetch, log });

    expect(createPriceSchedulerMock).toHaveBeenCalledTimes(1);
    expect(schedulerState.start).toHaveBeenCalledTimes(1);
    stopPriceScheduler();
  });

  it("stops and clears the scheduler instance", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const { startPriceScheduler, stopPriceScheduler } = await import("./priceFetcher.js");
    startPriceScheduler({
      runFetch: vi.fn().mockResolvedValue({ updated: 1, message: "ok" }),
      log: { log: vi.fn(), error: vi.fn() },
    });

    stopPriceScheduler();

    expect(schedulerState.stop).toHaveBeenCalledTimes(1);

    startPriceScheduler({
      runFetch: vi.fn().mockResolvedValue({ updated: 1, message: "ok" }),
      log: { log: vi.fn(), error: vi.fn() },
    });

    expect(createPriceSchedulerMock).toHaveBeenCalledTimes(2);
  });
});
