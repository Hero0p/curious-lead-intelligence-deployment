require("dotenv").config();

const express = require("express");
const path = require("path");

const db = require("./db");
const { attachUser, purgeExpiredSessions } = require("./lib/auth");
const scheduler = require("./services/scheduler");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "1mb" }));
app.use(attachUser);

// Minimal cookie setter so we don't need cookie-parser.
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
    if (opts.httpOnly !== false) parts.push("HttpOnly");
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    parts.push(`SameSite=${opts.sameSite || "Lax"}`);
    if (opts.secure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
    return res;
  };
  res.clearCookie = (name) => {
    res.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return res;
  };
  next();
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/stats", require("./routes/stats"));
app.use("/api/leads", require("./routes/leads"));
app.use("/api/signals", require("./routes/signals"));
app.use("/api/admin", require("./routes/admin"));

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Unknown endpoint." });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server]", err);
  res.status(500).json({ error: "Something broke on our side. Check the server log." });
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600e3).unref();

const userCount = db.prepare("SELECT COUNT(*) n FROM users").get().n;

app.listen(PORT, () => {
  console.log(`\n  Curious Media - Lead Intelligence`);
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  Database:  ${db.DB_PATH}`);
  if (userCount === 0) {
    console.log(`\n  No accounts yet. Stop the server and run:  npm run setup\n`);
  } else {
    console.log("");
  }
  scheduler.start();
});
