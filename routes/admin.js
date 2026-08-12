const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin, hashPassword } = require("../lib/auth");
const { runPipeline, isRunning, runState, buildQueries, ensureLead } = require("../services/pipeline");

const router = express.Router();

// Everyone signed in can see the team roster (needed for the assignee dropdown).
router.get("/users", requireAuth, async (req, res, next) => {
  try {
    const usersRes = await db.query(
      "SELECT id, username, display_name, role, active, created_at FROM users ORDER BY display_name"
    );
    res.json({ users: usersRes.rows });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);

// --- companies ---------------------------------------------------------------

router.get("/companies", async (req, res, next) => {
  try {
    const companiesRes = await db.query(
      `SELECT c.*, l.id AS lead_id,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id) AS signal_count
         FROM companies c LEFT JOIN leads l ON l.company_id = c.id
        ORDER BY LOWER(c.name)`
    );
    res.json({
      companies: companiesRes.rows.map((c) => ({ ...c, keywords: parseKeywords(c.keywords) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/companies", async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ error: "Give the company a name." });

    const keywords = normaliseKeywords(req.body.keywords, name);

    try {
      const insertRes = await db.query(
        "INSERT INTO companies (name, keywords, active) VALUES ($1, $2, true) RETURNING id",
        [name, JSON.stringify(keywords)]
      );
      const companyId = insertRes.rows[0].id;
      await ensureLead(companyId);
      res.json({ id: companyId });
    } catch (err) {
      if (String(err.message).includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: `${name} is already on the watchlist.` });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/companies/:id", async (req, res, next) => {
  try {
    const companyRes = await db.query("SELECT * FROM companies WHERE id = $1", [req.params.id]);
    const company = companyRes.rows[0];
    if (!company) return res.status(404).json({ error: "That company is no longer on the list." });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : company.name;
    const keywords =
      req.body.keywords !== undefined
        ? JSON.stringify(normaliseKeywords(req.body.keywords, name))
        : typeof company.keywords === "string"
        ? company.keywords
        : JSON.stringify(company.keywords);
    const active = req.body.active !== undefined ? Boolean(req.body.active) : Boolean(company.active);

    await db.query("UPDATE companies SET name = $1, keywords = $2, active = $3 WHERE id = $4", [
      name,
      keywords,
      active,
      company.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/companies/:id", async (req, res, next) => {
  try {
    await db.query("DELETE FROM companies WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- sources -----------------------------------------------------------------

router.get("/sites", async (req, res, next) => {
  try {
    const sitesRes = await db.query("SELECT * FROM sites ORDER BY LOWER(name)");
    res.json({ sites: sitesRes.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/sites", async (req, res, next) => {
  try {
    const domain = String((req.body && req.body.domain) || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
    const name = String((req.body && req.body.name) || "").trim() || domain.split(".")[0];

    if (!domain) return res.status(400).json({ error: "Enter a domain, like livemint.com." });

    try {
      const insertRes = await db.query("INSERT INTO sites (name, domain, active) VALUES ($1, $2, true) RETURNING id", [
        name,
        domain,
      ]);
      res.json({ id: insertRes.rows[0].id });
    } catch (err) {
      if (String(err.message).includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: `${domain} is already being watched.` });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/sites/:id", async (req, res, next) => {
  try {
    const siteRes = await db.query("SELECT * FROM sites WHERE id = $1", [req.params.id]);
    const site = siteRes.rows[0];
    if (!site) return res.status(404).json({ error: "That source is no longer on the list." });
    const active = req.body.active !== undefined ? Boolean(req.body.active) : Boolean(site.active);
    await db.query("UPDATE sites SET active = $1 WHERE id = $2", [active, site.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/sites/:id", async (req, res, next) => {
  try {
    await db.query("DELETE FROM sites WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- topic keywords ----------------------------------------------------------

router.get("/topics", async (req, res, next) => {
  try {
    const topicsRes = await db.query("SELECT * FROM topics ORDER BY keyword");
    res.json({ topics: topicsRes.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/topics/toggle-all", async (req, res, next) => {
  try {
    const active = req.body && req.body.active !== undefined ? Boolean(req.body.active) : false;
    await db.query("UPDATE topics SET active = $1", [active]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch("/topics/:id", async (req, res, next) => {
  try {
    const active = req.body && req.body.active !== undefined ? Boolean(req.body.active) : false;
    await db.query("UPDATE topics SET active = $1 WHERE id = $2", [
      active,
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- team --------------------------------------------------------------------

router.post("/users", async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || "").trim().toLowerCase();
    const displayName = String((req.body && req.body.display_name) || "").trim() || username;
    const password = String((req.body && req.body.password) || "");
    const role = req.body && req.body.role === "admin" ? "admin" : "member";

    if (!username) return res.status(400).json({ error: "Enter a username." });
    if (password.length < 6)
      return res.status(400).json({ error: "Passwords need at least 6 characters." });

    try {
      await db.query(
        "INSERT INTO users (username, display_name, password_hash, role, active) VALUES ($1, $2, $3, $4, true)",
        [username, displayName, hashPassword(password), role]
      );
      res.json({ ok: true });
    } catch (err) {
      if (String(err.message).includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: `${username} is already taken.` });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id", async (req, res, next) => {
  try {
    const userRes = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "That teammate no longer exists." });

    if (Number(req.params.id) === req.user.id && req.body.active === false) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }

    const fields = [];
    const args = [];
    if (req.body.display_name !== undefined) {
      args.push(String(req.body.display_name).trim());
      fields.push(`display_name = $${args.length}`);
    }
    if (req.body.role !== undefined) {
      args.push(req.body.role === "admin" ? "admin" : "member");
      fields.push(`role = $${args.length}`);
    }
    if (req.body.active !== undefined) {
      args.push(Boolean(req.body.active));
      fields.push(`active = $${args.length}`);
    }
    if (req.body.password) {
      if (String(req.body.password).length < 6)
        return res.status(400).json({ error: "Passwords need at least 6 characters." });
      args.push(hashPassword(String(req.body.password)));
      fields.push(`password_hash = $${args.length}`);
    }
    if (!fields.length) return res.json({ ok: true });

    args.push(user.id);
    await db.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${args.length}`, args);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- runs --------------------------------------------------------------------

router.get("/runs", async (req, res, next) => {
  try {
    const [runsRes, queries] = await Promise.all([
      db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 25"),
      buildQueries(),
    ]);

    res.json({
      runs: runsRes.rows,
      running: isRunning(),
      current: runState(),
      queryCount: queries.length,
      hasNewsKey: Boolean(process.env.NEWSAPI_AI_KEY),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/run", async (req, res) => {
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

// --- helpers -------------------------------------------------------------

function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
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
