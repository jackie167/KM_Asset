import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles, resolveEnvCandidates } from "./loadEnv";

const ENV_KEYS = ["DATABASE_URL", "PORT"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("db resolveEnvCandidates", () => {
  it("includes cwd-first candidates before module-relative fallbacks", () => {
    const cwd = "/repo/lib/db";
    const moduleDir = "/repo/lib/db/src";
    expect(resolveEnvCandidates(cwd, moduleDir)).toEqual([
      "/repo/lib/db/.env",
      "/repo/lib/.env",
      "/repo/.env",
    ]);
  });
});

describe("db loadEnvFiles", () => {
  it("loads only env files that exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-tracker-db-env-"));
    const rootEnv = path.join(tempDir, ".env");
    fs.writeFileSync(rootEnv, "DATABASE_URL=postgres://db-root\nPORT=4020\n", "utf8");

    const loaded = loadEnvFiles([
      rootEnv,
      path.join(tempDir, "missing.env"),
    ]);

    expect(loaded).toEqual([rootEnv]);
    expect(process.env.DATABASE_URL).toBe("postgres://db-root");
    expect(process.env.PORT).toBe("4020");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
