import { Router, type IRouter } from "express";
import { db, snapshotsTable, snapshotTypeValuesTable } from "../../../lib/db/src/index.ts";
import { desc, gte, inArray } from "drizzle-orm";
import { ListSnapshotsResponse } from "../../../lib/api-zod/src/index.ts";

const router: IRouter = Router();

type SnapshotRange = "1m" | "3m" | "6m" | "1y";

function resolveSnapshotRange(value: unknown): SnapshotRange {
  return value === "3m" || value === "6m" || value === "1y" ? value : "1m";
}

function getSnapshotRangeStart(range: SnapshotRange, now = new Date()) {
  const start = new Date(now);
  if (range === "1y") {
    start.setFullYear(start.getFullYear() - 1);
    return start;
  }

  const months = range === "6m" ? 6 : range === "3m" ? 3 : 1;
  start.setMonth(start.getMonth() - months);
  return start;
}

function collapseSnapshotsByDay<T extends { snapshotAt: Date }>(snapshots: T[]) {
  const byDay = new Map<string, T>();
  for (const snapshot of snapshots) {
    const dayKey = snapshot.snapshotAt.toISOString().slice(0, 10);
    const existing = byDay.get(dayKey);
    if (!existing || snapshot.snapshotAt > existing.snapshotAt) {
      byDay.set(dayKey, snapshot);
    }
  }
  return Array.from(byDay.values()).sort((a, b) => b.snapshotAt.getTime() - a.snapshotAt.getTime());
}

router.get("/snapshots", async (req, res): Promise<void> => {
  const range = resolveSnapshotRange(req.query["range"]);
  const rangeStart = getSnapshotRangeStart(range);

  const snapshots = await db
    .select()
    .from(snapshotsTable)
    .where(gte(snapshotsTable.snapshotAt, rangeStart))
    .orderBy(desc(snapshotsTable.snapshotAt))
    .limit(10000);

  const dailySnapshots = collapseSnapshotsByDay(snapshots);
  const snapshotIds = dailySnapshots.map((snapshot) => snapshot.id);
  const typeValues =
    snapshotIds.length > 0
      ? await db
          .select()
          .from(snapshotTypeValuesTable)
          .where(inArray(snapshotTypeValuesTable.snapshotId, snapshotIds))
      : [];

  const typeValuesBySnapshot = new Map<number, Record<string, number>>();
  for (const item of typeValues) {
    const existing = typeValuesBySnapshot.get(item.snapshotId) ?? {};
    existing[item.type] = parseFloat(String(item.value));
    typeValuesBySnapshot.set(item.snapshotId, existing);
  }

  res.json(
    ListSnapshotsResponse.parse(
      dailySnapshots.map((s) => ({
        ...s,
        totalValue: parseFloat(String(s.totalValue)),
        stockValue: parseFloat(String(s.stockValue)),
        goldValue: parseFloat(String(s.goldValue)),
        typeValues: typeValuesBySnapshot.get(s.id) ?? {},
      }))
    )
  );
});

export default router;
