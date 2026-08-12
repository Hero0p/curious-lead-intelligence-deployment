const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { isRunning, runState } = require("../services/pipeline");
const { SCHEDULE, TIMEZONE } = require("../services/scheduler");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;

  const newIn24h = one(
    `SELECT COUNT(DISTINCT lead_id) n FROM signals WHERE created_at >= datetime('now','-1 day')`
  );

  const activePipeline = one(
    `SELECT COUNT(*) n FROM leads WHERE status IN ('working','contacted','replied','qualified')`
  );

  const followupsDue = one(
    `SELECT COUNT(*) n FROM leads
      WHERE next_followup_at IS NOT NULL AND date(next_followup_at) <= date('now')`
  );

  const touchedThisWeek = one(
    `SELECT COUNT(DISTINCT lead_id) n FROM activity WHERE created_at >= datetime('now','-7 days')`
  );

  const lastRun = db
    .prepare("SELECT * FROM runs WHERE status != 'running' ORDER BY id DESC LIMIT 1")
    .get();

  res.json({
    stats: { newIn24h, activePipeline, followupsDue, touchedThisWeek },
    totals: {
      leads: one("SELECT COUNT(*) n FROM leads"),
      signals: one("SELECT COUNT(*) n FROM signals"),
      companies: one("SELECT COUNT(*) n FROM companies WHERE active = 1"),
      sites: one("SELECT COUNT(*) n FROM sites WHERE active = 1"),
      mine: db
        .prepare("SELECT COUNT(*) n FROM leads WHERE owner_id = ?")
        .get(req.user.id).n,
    },
    run: { running: isRunning(), current: runState(), last: lastRun || null },
    schedule: { cron: SCHEDULE, timezone: TIMEZONE },
  });
});

module.exports = router;
