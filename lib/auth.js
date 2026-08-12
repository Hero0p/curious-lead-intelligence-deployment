const crypto = require("crypto");
const db = require("../db");

const SESSION_DAYS = 14;

// --- passwords ---------------------------------------------------------------
// scrypt ships with Node, so there is no native module to compile.

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, expected] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const actual = crypto.scryptSync(plain, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// --- sessions ----------------------------------------------------------------

async function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    id,
    userId,
    expires,
  ]);
  return { id, expires };
}

async function destroySession(id) {
  if (!id) return;
  await db.query("DELETE FROM sessions WHERE id = $1", [id]);
}

async function userForSession(id) {
  if (!id) return null;
  const res = await db.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [id]
  );

  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.active) {
    await destroySession(id);
    return null;
  }
  return { id: row.id, username: row.username, name: row.display_name, role: row.role };
}

async function purgeExpiredSessions() {
  try {
    await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
  } catch (err) {
    // Ignore error if DB not ready yet
  }
}

// --- express middleware ------------------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function attachUser(req, res, next) {
  try {
    req.sessionId = readCookie(req, "sid");
    req.user = await userForSession(req.sessionId);
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "This section is admin-only." });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForSession,
  purgeExpiredSessions,
  attachUser,
  requireAuth,
  requireAdmin,
  SESSION_DAYS,
};
