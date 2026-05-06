import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles, resolveEnvCandidates } from "./loadEnv.js";

const ENV_KEYS = ["DATABASE_URL", "PORT"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("resolveEnvCandidates", () => {
  it("includes cwd-first candidates before module-relative fallbacks", () => {
    const cwd = "/repo/api-server";
    const moduleDir = "/repo/api-server/src/lib";
    expect(resolveEnvCandidates(cwd, moduleDir)).toEqual([
      "/repo/api-server/.env",
      "/repo/.env",
      "/.env",
    ]);
  });
});

describe("loadEnvFiles", () => {
  it("loads only env files that exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-tracker-env-"));
    const rootEnv = path.join(tempDir, ".env");
    fs.writeFileSync(rootEnv, "DATABASE_URL=postgres://root\nPORT=4010\n", "utf8");

    const loaded = loadEnvFiles([
      rootEnv,
      path.join(tempDir, "missing.env"),
    ]);

    expect(loaded).toEqual([rootEnv]);
    expect(process.env.DATABASE_URL).toBe("postgres://root");
    expect(process.env.PORT).toBe("4010");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
