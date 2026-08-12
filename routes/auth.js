const express = require("express");
const db = require("../db");
const { verifyPassword, createSession, destroySession, SESSION_DAYS } = require("../lib/auth");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Enter a username and password." });
    }

    const userRes = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = userRes.rows[0];

    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "That username and password don't match." });
    }

    const session = await createSession(user.id);
    res.cookie("sid", session.id, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION_DAYS * 864e5,
      secure: process.env.SECURE_COOKIES === "true",
    });

    res.json({
      user: { id: user.id, username: user.username, name: user.display_name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await destroySession(req.sessionId);
    res.clearCookie("sid");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not signed in." });
  res.json({ user: req.user });
});

module.exports = router;
