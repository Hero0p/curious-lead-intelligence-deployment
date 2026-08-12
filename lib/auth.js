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

function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    id,
    userId,
    expires
  );
  return { id, expires };
}

function destroySession(id) {
  if (!id) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

function userForSession(id) {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.active, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(id);

  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.active) {
    destroySession(id);
    return null;
  }
  return { id: row.id, username: row.username, name: row.display_name, role: row.role };
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
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

function attachUser(req, res, next) {
  req.sessionId = readCookie(req, "sid");
  req.user = userForSession(req.sessionId);
  next();
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
