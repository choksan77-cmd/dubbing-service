import fs from "fs";
import { prisma } from "./prisma";
import { jobDir } from "./pipeline";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Uploaded videos and dubbed output aren't kept beyond a day — this is a
// short-form testing tool, not video storage, and the files are large
// enough that keeping them indefinitely isn't worth it. Deletes both the
// on-disk job directory and the DB row for anything older than 24h,
// regardless of status (an old failed/stuck job is just as much dead
// weight as an old done one).
export async function cleanupOldJobs() {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const stale = await prisma.dubJob.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
  });

  for (const { id } of stale) {
    fs.rmSync(jobDir(id), { recursive: true, force: true });
  }

  if (stale.length > 0) {
    await prisma.dubJob.deleteMany({ where: { id: { in: stale.map((j) => j.id) } } });
    console.log(`[cleanup] removed ${stale.length} job(s) older than 24h`);
  }
}

// Guards against the sweep being scheduled more than once (Next.js can
// re-evaluate instrumentation in some dev-mode reload scenarios) — a
// process-global flag survives module re-evaluation within the same
// running server, unlike a plain module-scope variable.
export function startCleanupScheduler() {
  if (globalThis.__dubbingCleanupStarted) return;
  globalThis.__dubbingCleanupStarted = true;

  cleanupOldJobs().catch((err) => console.error("[cleanup] initial sweep failed:", err));
  setInterval(() => {
    cleanupOldJobs().catch((err) => console.error("[cleanup] sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}
