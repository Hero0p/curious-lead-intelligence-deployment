const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];
const OPEN_STATUSES = ["working", "contacted", "replied", "qualified"];
const CONTACT_KINDS = ["email", "call", "linkedin", "meeting"];

const FRESHNESS = {
  "24h": "-1 day",
  "48h": "-2 days",
  "7d": "-7 days",
  "30d": "-30 days",
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
function queryLeads(params, user) {
  const where = [];
  const args = {};

  // --- signal window ---------------------------------------------------------
  const tab = params.tab || "all";
  const freshness = FRESHNESS[params.freshness];

  if (tab === "today") {
    // "New since the last cycle" - based on when we discovered it, not the
    // publish date, so a backdated article still shows up as new to the team.
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND s.created_at >= datetime('now', '-1 day'))`
    );
  } else if (freshness) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= datetime('now', '${freshness}'))`
    );
  }

  if (tab === "mine") {
    where.push("l.owner_id = @me");
    args.me = user.id;
  }

  // --- signal type -----------------------------------------------------------
  const types = list(params.types);
  if (types.length) {
    const ph = types.map((_, i) => `@t${i}`).join(",");
    types.forEach((t, i) => (args[`t${i}`] = t));
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id AND s.signal_type IN (${ph}))`
    );
  }

  // --- status ----------------------------------------------------------------
  const statuses = list(params.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) {
    const ph = statuses.map((_, i) => `@st${i}`).join(",");
    statuses.forEach((s, i) => (args[`st${i}`] = s));
    where.push(`l.status IN (${ph})`);
  }

  // --- outreach hygiene ------------------------------------------------------
  for (const flag of list(params.hygiene)) {
    switch (flag) {
      case "stale30":
        where.push("(l.last_contacted_at IS NULL OR l.last_contacted_at < datetime('now','-30 days'))");
        break;
      case "unclaimed":
        where.push("l.owner_id IS NULL");
        break;
      case "mine":
        where.push("l.owner_id = @me");
        args.me = user.id;
        break;
      case "followup":
        where.push("(l.next_followup_at IS NOT NULL AND date(l.next_followup_at) <= date('now'))");
        break;
      case "hascontact":
        where.push("(l.contact_email IS NOT NULL AND l.contact_email <> '')");
        break;
    }
  }

  // --- search ----------------------------------------------------------------
  if (params.q) {
    where.push("(LOWER(c.name) LIKE @q OR LOWER(COALESCE(l.contact_name,'')) LIKE @q)");
    args.q = `%${String(params.q).toLowerCase()}%`;
  }

  const sortMap = {
    score: "l.score DESC, l.last_signal_at DESC",
    recent: "l.last_signal_at IS NULL, l.last_signal_at DESC, l.score DESC",
    company: "c.name COLLATE NOCASE ASC",
    followup: "l.next_followup_at IS NULL, l.next_followup_at ASC",
  };
  const orderBy = sortMap[params.sort] || sortMap.score;

  const sql = `
    SELECT l.id, l.status, l.owner_id, l.contact_name, l.contact_role,
           l.contact_email, l.contact_phone, l.last_contacted_at,
           l.next_followup_at, l.last_signal_at, l.score,
           c.name AS company, c.id AS company_id,
           u.display_name AS owner_name,
           (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id) AS signal_count,
           (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id
              AND s.created_at >= datetime('now','-1 day')) AS new_count,
           (SELECT COUNT(*) FROM activity a WHERE a.lead_id = l.id) AS activity_count
      FROM leads l
      JOIN companies c ON c.id = l.company_id
      LEFT JOIN users u ON u.id = l.owner_id
     ${where.length ? "WHERE " + where.join("\n       AND ") : ""}
     ORDER BY ${orderBy}
     LIMIT 300`;

  const leads = db.prepare(sql).all(args);

  // Attach the three most useful signals per lead for the card preview.
  const topSignals = db.prepare(
    `SELECT id, title, url, site, published, created_at, signal_type, score,
            summary, why_it_matters
       FROM signals WHERE lead_id = ?
      ORDER BY score DESC, COALESCE(published, created_at) DESC LIMIT 3`
  );

  for (const lead of leads) lead.signals = topSignals.all(lead.id);
  return leads;
}

router.get("/", (req, res) => {
  res.json({ leads: queryLeads(req.query, req.user) });
});

router.get("/:id", (req, res) => {
  const lead = db
    .prepare(
      `SELECT l.*, c.name AS company, c.keywords, u.display_name AS owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.id = ?`
    )
    .get(req.params.id);

  if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

  lead.signals = db
    .prepare(
      `SELECT id, title, url, author, site, section_title, published, created_at,
              signal_type, score, summary, why_it_matters, enriched
         FROM signals WHERE lead_id = ?
        ORDER BY COALESCE(published, created_at) DESC`
    )
    .all(lead.id);

  lead.activity = db
    .prepare(
      `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
         FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.lead_id = ? ORDER BY a.created_at DESC`
    )
    .all(lead.id);

  res.json({ lead });
});

router.patch("/:id", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
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

  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({
    ...fields,
    id: lead.id,
  });

  // Log the moves worth remembering.
  if (fields.status && fields.status !== lead.status) {
    logActivity(lead.id, req.user.id, "status", `Moved from ${lead.status} to ${fields.status}`);
  }
  if (fields.owner_id !== undefined && fields.owner_id !== lead.owner_id) {
    const who = fields.owner_id
      ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(fields.owner_id)
      : null;
    logActivity(lead.id, req.user.id, "claim", who ? `Assigned to ${who.display_name}` : "Released back to the pool");
  }

  res.json({ lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id) });
});

router.post("/:id/claim", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

  const release = req.body && req.body.release;
  const ownerId = release ? null : req.user.id;

  db.prepare(
    `UPDATE leads SET owner_id = ?, status = CASE WHEN ? IS NULL THEN status
                                                  WHEN status = 'new' THEN 'working'
                                                  ELSE status END,
                      updated_at = datetime('now')
      WHERE id = ?`
  ).run(ownerId, ownerId, lead.id);

  logActivity(lead.id, req.user.id, "claim", release ? "Released back to the pool" : "Claimed this lead");
  res.json({ lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id) });
});

router.post("/:id/activity", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

  const kind = String((req.body && req.body.kind) || "note");
  const body = String((req.body && req.body.body) || "").trim();
  if (!body) return res.status(400).json({ error: "Write something before logging it." });

  logActivity(lead.id, req.user.id, kind, body);

  // Logging a real touch updates the outreach clock and nudges the status forward.
  if (CONTACT_KINDS.includes(kind)) {
    db.prepare(
      `UPDATE leads
          SET last_contacted_at = datetime('now'),
              status = CASE WHEN status IN ('new','working') THEN 'contacted' ELSE status END,
              owner_id = COALESCE(owner_id, ?),
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(req.user.id, lead.id);
  }

  if (req.body && req.body.next_followup_at !== undefined) {
    db.prepare("UPDATE leads SET next_followup_at = ? WHERE id = ?").run(
      req.body.next_followup_at || null,
      lead.id
    );
  }

  res.json({
    lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id),
    activity: db
      .prepare(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
           FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = ? ORDER BY a.created_at DESC`
      )
      .all(lead.id),
  });
});

function logActivity(leadId, userId, kind, body) {
  db.prepare("INSERT INTO activity (lead_id, user_id, kind, body) VALUES (?, ?, ?, ?)").run(
    leadId,
    userId,
    kind,
    body
  );
}

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
