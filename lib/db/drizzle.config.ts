import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../.env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL. Set it in the repo root .env or lib/db/.env.");
}

export default defineConfig({
  schema: "./src/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
