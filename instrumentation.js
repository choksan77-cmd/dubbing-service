// Next.js calls register() once when the server process starts (both dev
// and prod) — used here to kick off the 24h job-retention sweep without
// needing a separate cron/worker process.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCleanupScheduler } = await import("./lib/cleanup");
    startCleanupScheduler();
  }
}
