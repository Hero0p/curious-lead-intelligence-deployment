const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const FRESHNESS = { "24h": "-1 day", "48h": "-2 days", "7d": "-7 days", "30d": "-30 days" };

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

router.get("/", (req, res) => {
  const where = [];
  const args = {};

  const freshness = FRESHNESS[req.query.freshness];
  if (freshness) {
    where.push(`COALESCE(s.published, s.created_at) >= datetime('now', '${freshness}')`);
  }

  const types = list(req.query.types);
  if (types.length) {
    const ph = types.map((_, i) => `@t${i}`).join(",");
    types.forEach((t, i) => (args[`t${i}`] = t));
    where.push(`s.signal_type IN (${ph})`);
  }

  if (req.query.q) {
    where.push("(LOWER(s.company) LIKE @q OR LOWER(COALESCE(s.title,'')) LIKE @q)");
    args.q = `%${String(req.query.q).toLowerCase()}%`;
  }

  if (req.query.company) {
    where.push("s.company = @company");
    args.company = req.query.company;
  }

  const signals = db
    .prepare(
      `SELECT s.id, s.lead_id, s.company, s.title, s.url, s.author, s.site,
              s.published, s.created_at, s.signal_type, s.score, s.summary,
              s.why_it_matters, s.enriched
         FROM signals s
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY COALESCE(s.published, s.created_at) DESC
        LIMIT 400`
    )
    .all(args);

  res.json({ signals });
});

router.get("/breakdown", (req, res) => {
  const byType = db
    .prepare(
      `SELECT signal_type, COUNT(*) AS n FROM signals
        WHERE COALESCE(published, created_at) >= datetime('now','-30 days')
        GROUP BY signal_type ORDER BY n DESC`
    )
    .all();

  const bySite = db
    .prepare(
      `SELECT site, COUNT(*) AS n FROM signals
        WHERE COALESCE(published, created_at) >= datetime('now','-30 days')
        GROUP BY site ORDER BY n DESC LIMIT 12`
    )
    .all();

  const byCompany = db
    .prepare(
      `SELECT company, COUNT(*) AS n, MAX(score) AS top_score FROM signals
        WHERE COALESCE(published, created_at) >= datetime('now','-30 days')
        GROUP BY company ORDER BY n DESC`
    )
    .all();

  res.json({ byType, bySite, byCompany });
});

module.exports = router;
