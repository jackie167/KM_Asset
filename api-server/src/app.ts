import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes/index.js";
import { startPriceScheduler } from "./lib/priceFetcher.js";

const app: Express = express();

app.get("/ping-test", (_req, res) => {
  res.send("ping ok");
});


app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  const startedAt = Date.now();
  const { method, originalUrl } = req;
  const done = () => {
    const durationMs = Date.now() - startedAt;
    console.log(`${method} ${originalUrl} ${durationMs}ms`);
  };
  _res.on("finish", done);
  _res.on("close", done);
  next();
});

app.use("/api", router);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDistCandidates = [
  path.resolve(process.cwd(), "../finance-tracker/dist/public"),
  path.resolve(process.cwd(), "artifacts/finance-tracker/dist/public"),
  path.resolve(process.cwd(), "finance-tracker/dist/public"),
  path.resolve(process.cwd(), "..", "artifacts", "finance-tracker", "dist", "public"),
  path.resolve(__dirname, "..", "..", "finance-tracker", "dist", "public"),
  path.resolve(__dirname, "..", "..", "..", "finance-tracker", "dist", "public"),
  path.resolve(__dirname, "..", "..", "..", "artifacts", "finance-tracker", "dist", "public"),
];

console.log("cwd =", process.cwd());
console.log("__dirname =", __dirname);
console.log("clientDistCandidates =", clientDistCandidates);

const clientDist = clientDistCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "index.html")),
);

console.log("clientDist =", clientDist);

if (clientDist) {
  console.log("Serving frontend from:", clientDist);

  app.use(express.static(clientDist));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    console.log("SPA fallback for:", req.path);
    res.sendFile(path.join(clientDist, "index.html"));
  });
} else {
  console.log("No frontend build found");
}

app.get("/", (_req, res) => {
  if (clientDist) {
    return res.sendFile(path.join(clientDist, "index.html"));
  }
  return res.send("Server is running");
});

startPriceScheduler();

export { app };
