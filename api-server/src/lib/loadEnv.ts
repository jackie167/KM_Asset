import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveEnvCandidates(cwd: string, moduleDir: string) {
  return [...new Set([
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "../.env"),
    path.resolve(cwd, "../../.env"),
    path.resolve(moduleDir, "../../../.env"),
    path.resolve(moduleDir, "../../.env"),
  ])];
}

export function loadEnvFiles(
  envCandidates: string[],
  options: {
    existsSync?: (path: string) => boolean;
    loadEnvFile?: (path: string) => void;
  } = {}
) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const loadEnvFile = options.loadEnvFile ?? process.loadEnvFile.bind(process);
  const loadedFiles: string[] = [];

  for (const envPath of envCandidates) {
    if (existsSync(envPath)) {
      loadEnvFile(envPath);
      loadedFiles.push(envPath);
    }
  }

  return loadedFiles;
}

const envCandidates = resolveEnvCandidates(process.cwd(), __dirname);

loadEnvFiles(envCandidates);
