const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin, hashPassword } = require("../lib/auth");
const { runPipeline, isRunning, runState, buildQueries, ensureLead } = require("../services/pipeline");

const router = express.Router();

// Everyone signed in can see the team roster (needed for the assignee dropdown).
router.get("/users", requireAuth, (req, res) => {
  res.json({
    users: db
      .prepare("SELECT id, username, display_name, role, active, created_at FROM users ORDER BY display_name")
      .all(),
  });
});

router.use(requireAdmin);

// --- companies ---------------------------------------------------------------

router.get("/companies", (req, res) => {
  const companies = db
    .prepare(
      `SELECT c.*, l.id AS lead_id,
              (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id) AS signal_count
         FROM companies c LEFT JOIN leads l ON l.company_id = c.id
        ORDER BY c.name COLLATE NOCASE`
    )
    .all();
  res.json({ companies: companies.map((c) => ({ ...c, keywords: parseKeywords(c.keywords) })) });
});

router.post("/companies", (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "Give the company a name." });

  const keywords = normaliseKeywords(req.body.keywords, name);

  try {
    const info = db
      .prepare("INSERT INTO companies (name, keywords) VALUES (?, ?)")
      .run(name, JSON.stringify(keywords));
    ensureLead(info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes("UNIQUE"))
      return res.status(409).json({ error: `${name} is already on the watchlist.` });
    throw err;
  }
});

router.patch("/companies/:id", (req, res) => {
  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!company) return res.status(404).json({ error: "That company is no longer on the list." });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : company.name;
  const keywords =
    req.body.keywords !== undefined
      ? JSON.stringify(normaliseKeywords(req.body.keywords, name))
      : company.keywords;
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : company.active;

  db.prepare("UPDATE companies SET name = ?, keywords = ?, active = ? WHERE id = ?").run(
    name,
    keywords,
    active,
    company.id
  );
  res.json({ ok: true });
});

router.delete("/companies/:id", (req, res) => {
  db.prepare("DELETE FROM companies WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- sources -----------------------------------------------------------------

router.get("/sites", (req, res) => {
  res.json({ sites: db.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all() });
});

router.post("/sites", (req, res) => {
  const domain = String((req.body && req.body.domain) || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const name = String((req.body && req.body.name) || "").trim() || domain.split(".")[0];

  if (!domain) return res.status(400).json({ error: "Enter a domain, like livemint.com." });

  try {
    const info = db.prepare("INSERT INTO sites (name, domain) VALUES (?, ?)").run(name, domain);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes("UNIQUE"))
      return res.status(409).json({ error: `${domain} is already being watched.` });
    throw err;
  }
});

router.patch("/sites/:id", (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "That source is no longer on the list." });
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : site.active;
  db.prepare("UPDATE sites SET active = ? WHERE id = ?").run(active, site.id);
  res.json({ ok: true });
});

router.delete("/sites/:id", (req, res) => {
  db.prepare("DELETE FROM sites WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- topic keywords ----------------------------------------------------------

router.get("/topics", (req, res) => {
  res.json({ topics: db.prepare("SELECT * FROM topics ORDER BY keyword").all() });
});

router.post("/topics/toggle-all", (req, res) => {
  const active = req.body && req.body.active ? 1 : 0;
  db.prepare("UPDATE topics SET active = ?").run(active);
  res.json({ ok: true });
});

router.patch("/topics/:id", (req, res) => {
  db.prepare("UPDATE topics SET active = ? WHERE id = ?").run(
    req.body && req.body.active ? 1 : 0,
    req.params.id
  );
  res.json({ ok: true });
});

// --- team --------------------------------------------------------------------

router.post("/users", (req, res) => {
  const username = String((req.body && req.body.username) || "").trim().toLowerCase();
  const displayName = String((req.body && req.body.display_name) || "").trim() || username;
  const password = String((req.body && req.body.password) || "");
  const role = req.body && req.body.role === "admin" ? "admin" : "member";

  if (!username) return res.status(400).json({ error: "Enter a username." });
  if (password.length < 6)
    return res.status(400).json({ error: "Passwords need at least 6 characters." });

  try {
    db.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)"
    ).run(username, displayName, hashPassword(password), role);
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes("UNIQUE"))
      return res.status(409).json({ error: `${username} is already taken.` });
    throw err;
  }
});

router.patch("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "That teammate no longer exists." });

  if (Number(req.params.id) === req.user.id && req.body.active === false) {
    return res.status(400).json({ error: "You can't deactivate your own account." });
  }

  const fields = [];
  const args = [];
  if (req.body.display_name !== undefined) {
    fields.push("display_name = ?");
    args.push(String(req.body.display_name).trim());
  }
  if (req.body.role !== undefined) {
    fields.push("role = ?");
    args.push(req.body.role === "admin" ? "admin" : "member");
  }
  if (req.body.active !== undefined) {
    fields.push("active = ?");
    args.push(req.body.active ? 1 : 0);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6)
      return res.status(400).json({ error: "Passwords need at least 6 characters." });
    fields.push("password_hash = ?");
    args.push(hashPassword(String(req.body.password)));
  }
  if (!fields.length) return res.json({ ok: true });

  args.push(user.id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

// --- runs --------------------------------------------------------------------

router.get("/runs", (req, res) => {
  res.json({
    runs: db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 25").all(),
    running: isRunning(),
    current: runState(),
    queryCount: buildQueries().length,
    hasNewsKey: Boolean(process.env.NEWSAPI_AI_KEY),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

router.post("/run", (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: "A cycle is already running." });
  }
  if (!process.env.NEWSAPI_AI_KEY) {
    return res.status(400).json({ error: "NEWSAPI_AI_KEY is missing from .env." });
  }

  // Kick it off and answer straight away - the UI polls for progress.
  runPipeline("manual").catch((err) => console.error("[run] failed:", err.message));
  res.json({ started: true });
});

// --- helpers -----------------------------------------------------------------

function parseKeywords(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normaliseKeywords(input, fallbackName) {
  let keywords = input;
  if (typeof keywords === "string") keywords = keywords.split(",");
  if (!Array.isArray(keywords)) keywords = [];
  keywords = keywords.map((k) => String(k).trim()).filter(Boolean);
  return keywords.length ? keywords : [fallbackName];
}

module.exports = router;
