const cron = require("node-cron");
const { runPipeline, isRunning } = require("./pipeline");

// Two cycles a day by default: 2am (overnight news, ready for the morning
// stand-up) and 2pm (afternoon wire). Override with CRON_SCHEDULE.
const SCHEDULE = process.env.CRON_SCHEDULE || "0 2,14 * * *";
const TIMEZONE = process.env.TZ_NAME || "Asia/Kolkata";

function start() {
  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[scheduler] Disabled via DISABLE_SCHEDULER.");
    return;
  }

  if (!cron.validate(SCHEDULE)) {
    console.error(`[scheduler] "${SCHEDULE}" is not a valid cron expression. Scheduler off.`);
    return;
  }

  cron.schedule(
    SCHEDULE,
    async () => {
      if (isRunning()) {
        console.log("[scheduler] Previous run still going - skipping this cycle.");
        return;
      }
      try {
        await runPipeline("schedule");
      } catch (err) {
        console.error("[scheduler] Run failed:", err.message);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(`[scheduler] Cycles scheduled: "${SCHEDULE}" (${TIMEZONE})`);
}

module.exports = { start, SCHEDULE, TIMEZONE };
