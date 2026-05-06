import "./lib/loadEnv.js";
import { app } from './app.js';
import { ensureDatabaseSchema } from "./lib/ensureDatabaseSchema.js";

const rawPort = process.env["PORT"] || "4000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await ensureDatabaseSchema();

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
