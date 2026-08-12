const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { isRunning, runState } = require("../services/pipeline");
const { SCHEDULE, TIMEZONE } = require("../services/scheduler");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const [
      newIn24hRes,
      activePipelineRes,
      followupsDueRes,
      touchedThisWeekRes,
      lastRunRes,
      totalLeadsRes,
      totalSignalsRes,
      totalCompaniesRes,
      totalSitesRes,
      mineLeadsRes,
    ] = await Promise.all([
      db.query(
        "SELECT COUNT(DISTINCT lead_id)::int AS n FROM signals WHERE created_at >= NOW() - INTERVAL '1 day'"
      ),
      db.query(
        "SELECT COUNT(*)::int AS n FROM leads WHERE status IN ('working','contacted','replied','qualified')"
      ),
      db.query(
        "SELECT COUNT(*)::int AS n FROM leads WHERE next_followup_at IS NOT NULL AND next_followup_at::date <= CURRENT_DATE"
      ),
      db.query(
        "SELECT COUNT(DISTINCT lead_id)::int AS n FROM activity WHERE created_at >= NOW() - INTERVAL '7 days'"
      ),
      db.query("SELECT * FROM runs WHERE status != 'running' ORDER BY id DESC LIMIT 1"),
      db.query("SELECT COUNT(*)::int AS n FROM leads"),
      db.query("SELECT COUNT(*)::int AS n FROM signals"),
      db.query("SELECT COUNT(*)::int AS n FROM companies WHERE active = true"),
      db.query("SELECT COUNT(*)::int AS n FROM sites WHERE active = true"),
      db.query("SELECT COUNT(*)::int AS n FROM leads WHERE owner_id = $1", [req.user.id]),
    ]);

    res.json({
      stats: {
        newIn24h: newIn24hRes.rows[0]?.n || 0,
        activePipeline: activePipelineRes.rows[0]?.n || 0,
        followupsDue: followupsDueRes.rows[0]?.n || 0,
        touchedThisWeek: touchedThisWeekRes.rows[0]?.n || 0,
      },
      totals: {
        leads: totalLeadsRes.rows[0]?.n || 0,
        signals: totalSignalsRes.rows[0]?.n || 0,
        companies: totalCompaniesRes.rows[0]?.n || 0,
        sites: totalSitesRes.rows[0]?.n || 0,
        mine: mineLeadsRes.rows[0]?.n || 0,
      },
      run: { running: isRunning(), current: runState(), last: lastRunRes.rows[0] || null },
      schedule: { cron: SCHEDULE, timezone: TIMEZONE },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
