const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];
const OPEN_STATUSES = ["working", "contacted", "replied", "qualified"];
const CONTACT_KINDS = ["email", "call", "linkedin", "meeting"];

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

/**
 * The one query that powers Today's Leads, All Leads and My Outreach.
 * Everything is a WHERE clause on the same shape, so the tabs stay consistent.
 */
async function queryLeads(params, user) {
  const where = [];
  const args = [];

  const addArg = (val) => {
    args.push(val);
    return `$${args.length}`;
  };

  // --- signal window ---------------------------------------------------------
  const tab = params.tab || "all";
  const freshness = FRESHNESS_INTERVALS[params.freshness];

  if (tab === "today") {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND s.created_at >= NOW() - INTERVAL '1 day')`
    );
  } else if (freshness) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= NOW() - INTERVAL '${freshness}')`
    );
  }

  if (tab === "mine") {
    where.push(`l.owner_id = ${addArg(user.id)}`);
  }

  // --- signal type -----------------------------------------------------------
  const types = list(params.types);
  if (types.length) {
    where.push(`EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id AND s.signal_type = ANY(${addArg(types)}))`);
  }

  // --- status ----------------------------------------------------------------
  const statuses = list(params.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) {
    where.push(`l.status = ANY(${addArg(statuses)})`);
  }

  // --- outreach hygiene ------------------------------------------------------
  for (const flag of list(params.hygiene)) {
    switch (flag) {
      case "stale30":
        where.push("(l.last_contacted_at IS NULL OR l.last_contacted_at < NOW() - INTERVAL '30 days')");
        break;
      case "unclaimed":
        where.push("l.owner_id IS NULL");
        break;
      case "mine":
        where.push(`l.owner_id = ${addArg(user.id)}`);
        break;
      case "followup":
        where.push("(l.next_followup_at IS NOT NULL AND l.next_followup_at::date <= CURRENT_DATE)");
        break;
      case "hascontact":
        where.push("(l.contact_email IS NOT NULL AND l.contact_email <> '')");
        break;
    }
  }

  // --- search ----------------------------------------------------------------
  if (params.q) {
    const qPattern = `%${String(params.q).toLowerCase()}%`;
    const p1 = addArg(qPattern);
    where.push(`(LOWER(c.name) LIKE ${p1} OR LOWER(COALESCE(l.contact_name, '')) LIKE ${p1})`);
  }

  const sortMap = {
    score: "l.score DESC, l.last_signal_at DESC NULLS LAST",
    recent: "l.last_signal_at DESC NULLS LAST, l.score DESC",
    company: "LOWER(c.name) ASC",
    followup: "l.next_followup_at ASC NULLS LAST",
  };
  const orderBy = sortMap[params.sort] || sortMap.score;

  const sql = `
    SELECT l.id, l.status, l.owner_id, l.contact_name, l.contact_role,
           l.contact_email, l.contact_phone, l.last_contacted_at,
           l.next_followup_at, l.last_signal_at, l.score,
           c.name AS company, c.id AS company_id,
           u.display_name AS owner_name,
           (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id)::int AS signal_count,
           (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id
              AND s.created_at >= NOW() - INTERVAL '1 day')::int AS new_count,
           (SELECT COUNT(*) FROM activity a WHERE a.lead_id = l.id)::int AS activity_count
      FROM leads l
      JOIN companies c ON c.id = l.company_id
      LEFT JOIN users u ON u.id = l.owner_id
     ${where.length ? "WHERE " + where.join("\n       AND ") : ""}
     ORDER BY ${orderBy}
     LIMIT 300`;

  const leadsRes = await db.query(sql, args);
  const leads = leadsRes.rows;

  if (leads.length === 0) return [];

  // Efficient batch retrieval of top 3 signals per lead using PostgreSQL window function
  const leadIds = leads.map((l) => l.id);
  const signalsRes = await db.query(
    `WITH ranked_signals AS (
       SELECT id, lead_id, title, url, site, published, created_at, signal_type, score,
              summary, why_it_matters,
              ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY score DESC, COALESCE(published, created_at) DESC) as rn
         FROM signals
        WHERE lead_id = ANY($1::int[])
     )
     SELECT id, lead_id, title, url, site, published, created_at, signal_type, score, summary, why_it_matters
       FROM ranked_signals
      WHERE rn <= 3`,
    [leadIds]
  );

  const signalsByLead = {};
  for (const s of signalsRes.rows) {
    if (!signalsByLead[s.lead_id]) signalsByLead[s.lead_id] = [];
    signalsByLead[s.lead_id].push(s);
  }

  for (const lead of leads) {
    lead.signals = signalsByLead[lead.id] || [];
  }

  return leads;
}

router.get("/", async (req, res, next) => {
  try {
    const leads = await queryLeads(req.query, req.user);
    res.json({ leads });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const leadRes = await db.query(
      `SELECT l.*, c.name AS company, c.keywords, u.display_name AS owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.id = $1`,
      [req.params.id]
    );

    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const signalsRes = await db.query(
      `SELECT id, title, url, author, site, section_title, published, created_at,
              signal_type, score, summary, why_it_matters, enriched
         FROM signals WHERE lead_id = $1
        ORDER BY COALESCE(published, created_at) DESC`,
      [lead.id]
    );
    lead.signals = signalsRes.rows;

    const activityRes = await db.query(
      `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
         FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
      [lead.id]
    );
    lead.activity = activityRes.rows;

    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const leadRes = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const fields = {};
    const b = req.body || {};

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status))
        return res.status(400).json({ error: `Unknown status "${b.status}".` });
      fields.status = b.status;
    }
    if (b.owner_id !== undefined) fields.owner_id = b.owner_id === null ? null : Number(b.owner_id);
    for (const key of ["contact_name", "contact_role", "contact_email", "contact_phone"]) {
      if (b[key] !== undefined) fields[key] = b[key] ? String(b[key]).trim() : null;
    }
    if (b.next_followup_at !== undefined)
      fields.next_followup_at = b.next_followup_at || null;

    if (Object.keys(fields).length === 0) return res.json({ lead });

    const fieldKeys = Object.keys(fields);
    const setClauses = fieldKeys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    const values = fieldKeys.map((k) => fields[k]);
    values.push(lead.id);

    await db.query(
      `UPDATE leads SET ${setClauses}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );

    // Log the moves worth remembering.
    if (fields.status && fields.status !== lead.status) {
      await logActivity(lead.id, req.user.id, "status", `Moved from ${lead.status} to ${fields.status}`);
    }
    if (fields.owner_id !== undefined && fields.owner_id !== lead.owner_id) {
      let whoName = null;
      if (fields.owner_id) {
        const whoRes = await db.query("SELECT display_name FROM users WHERE id = $1", [fields.owner_id]);
        whoName = whoRes.rows[0]?.display_name;
      }
      await logActivity(lead.id, req.user.id, "claim", whoName ? `Assigned to ${whoName}` : "Released back to the pool");
    }

    const updatedRes = await db.query("SELECT * FROM leads WHERE id = $1", [lead.id]);
    res.json({ lead: updatedRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/claim", async (req, res, next) => {
  try {
    const leadRes = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const release = Boolean(req.body && req.body.release);
    const ownerId = release ? null : req.user.id;
    const newStatus = release ? lead.status : (lead.status === "new" ? "working" : lead.status);

    await db.query(
      `UPDATE leads SET owner_id = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [ownerId, newStatus, lead.id]
    );

    await logActivity(lead.id, req.user.id, "claim", release ? "Released back to the pool" : "Claimed this lead");
    const updatedRes = await db.query("SELECT * FROM leads WHERE id = $1", [lead.id]);
    res.json({ lead: updatedRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/activity", async (req, res, next) => {
  try {
    const leadRes = await db.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const kind = String((req.body && req.body.kind) || "note");
    const body = String((req.body && req.body.body) || "").trim();
    if (!body) return res.status(400).json({ error: "Write something before logging it." });

    await logActivity(lead.id, req.user.id, kind, body);

    // Logging a real touch updates the outreach clock and nudges the status forward.
    if (CONTACT_KINDS.includes(kind)) {
      await db.query(
        `UPDATE leads
            SET last_contacted_at = NOW(),
                status = CASE WHEN status IN ('new','working') THEN 'contacted' ELSE status END,
                owner_id = COALESCE(owner_id, $1),
                updated_at = NOW()
          WHERE id = $2`,
        [req.user.id, lead.id]
      );
    }

    if (req.body && req.body.next_followup_at !== undefined) {
      await db.query("UPDATE leads SET next_followup_at = $1 WHERE id = $2", [
        req.body.next_followup_at || null,
        lead.id,
      ]);
    }

    const updatedLeadRes = await db.query("SELECT * FROM leads WHERE id = $1", [lead.id]);
    const activityRes = await db.query(
      `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
         FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
      [lead.id]
    );

    res.json({
      lead: updatedLeadRes.rows[0],
      activity: activityRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

async function logActivity(leadId, userId, kind, body) {
  await db.query(
    "INSERT INTO activity (lead_id, user_id, kind, body) VALUES ($1, $2, $3, $4)",
    [leadId, userId, kind, body]
  );
}

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
