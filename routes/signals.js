const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const FRESHNESS_INTERVALS = {
  "24h": "1 day",
  "48h": "2 days",
  "7d": "7 days",
  "30d": "30 days",
};

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

router.get("/", async (req, res, next) => {
  try {
    const where = [];
    const args = [];

    const addArg = (val) => {
      args.push(val);
      return `$${args.length}`;
    };

    const freshness = FRESHNESS_INTERVALS[req.query.freshness];
    if (freshness) {
      where.push(`COALESCE(s.published, s.created_at) >= NOW() - INTERVAL '${freshness}'`);
    }

    const types = list(req.query.types);
    if (types.length) {
      where.push(`s.signal_type = ANY(${addArg(types)})`);
    }

    if (req.query.q) {
      const qPattern = `%${String(req.query.q).toLowerCase()}%`;
      const p1 = addArg(qPattern);
      where.push(`(LOWER(s.company) LIKE ${p1} OR LOWER(COALESCE(s.title, '')) LIKE ${p1})`);
    }

    if (req.query.company) {
      where.push(`s.company = ${addArg(req.query.company)}`);
    }

    const sql = `
      SELECT s.id, s.lead_id, s.company, s.title, s.url, s.author, s.site,
             s.published, s.created_at, s.signal_type, s.score, s.summary,
             s.why_it_matters, s.enriched
        FROM signals s
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY COALESCE(s.published, s.created_at) DESC
       LIMIT 400`;

    const signalsRes = await db.query(sql, args);
    res.json({ signals: signalsRes.rows });
  } catch (err) {
    next(err);
  }
});

router.get("/breakdown", async (req, res, next) => {
  try {
    const [byTypeRes, bySiteRes, byCompanyRes] = await Promise.all([
      db.query(
        `SELECT signal_type, COUNT(*)::int AS n FROM signals
          WHERE COALESCE(published, created_at) >= NOW() - INTERVAL '30 days'
          GROUP BY signal_type ORDER BY n DESC`
      ),
      db.query(
        `SELECT site, COUNT(*)::int AS n FROM signals
          WHERE COALESCE(published, created_at) >= NOW() - INTERVAL '30 days'
          GROUP BY site ORDER BY n DESC LIMIT 12`
      ),
      db.query(
        `SELECT company, COUNT(*)::int AS n, MAX(score) AS top_score FROM signals
          WHERE COALESCE(published, created_at) >= NOW() - INTERVAL '30 days'
          GROUP BY company ORDER BY n DESC`
      ),
    ]);

    res.json({
      byType: byTypeRes.rows,
      bySite: bySiteRes.rows,
      byCompany: byCompanyRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
