require("dotenv").config();

const readline = require("readline");
const db = require("./index");
const { hashPassword } = require("../lib/auth");
const { ensureLead } = require("../services/pipeline");

const SITES = [
  { name: "ottplay", domain: "ottplay.com" },
  { name: "hindustan-times", domain: "hindustantimes.com" },
  { name: "livemint", domain: "livemint.com" },
  { name: "business-today", domain: "businesstoday.in" },
  { name: "business-standard", domain: "business-standard.com" },
  { name: "economic-times", domain: "economictimes.indiatimes.com" },
  { name: "entrackr", domain: "entrackr.com" },
  { name: "yourstory", domain: "yourstory.com" },
  { name: "india-today", domain: "indiatoday.in" },
  { name: "espn", domain: "espn.in" },
  { name: "inc42", domain: "inc42.com" },
  { name: "filmibeat", domain: "filmibeat.com" },
  { name: "bollywood-hungama", domain: "bollywoodhungama.com" },
];

const COMPANIES = [
  { name: "POPxo", keywords: ["POPxo"] },
  { name: "Meesho", keywords: ["Meesho"] },
  { name: "TATA.ev", keywords: ["TATA.ev", "Tata EV"] },
  { name: "Bluedart", keywords: ["Bluedart", "Blue Dart"] },
  { name: "ZEE Business", keywords: ["ZEE Business"] },
  { name: "META", keywords: ["Meta Platforms", "META CEO"] },
  { name: "Essar Group", keywords: ["Essar Group"] },
];

const TOPICS = [
  "funding", "raises", "IPO", "valuation", "investment", "series A", "series B",
  "appoints", "hires", "resigns", "steps down", "new CEO",
  "profit", "revenue", "earnings", "quarterly results",
  "launches", "unveils", "rolls out", "expands", "expansion",
  "acquires", "acquisition", "merger", "stake sale",
];

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      const onData = (char) => {
        if (["\n", "\r", "\u0004"].includes(char.toString())) process.stdin.pause();
        else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + "*".repeat(rl.line.length));
        }
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

(async () => {
  try {
    console.log("\nCurious Media - Lead Intelligence setup (Supabase / PostgreSQL)\n");

    // --- apply schema --------------------------------------------------------
    console.log("Checking database schema...");
    await db.initSchema();

    // --- watchlist -------------------------------------------------------------
    for (const s of SITES) {
      await db.query(
        "INSERT INTO sites (name, domain, active) VALUES ($1, $2, true) ON CONFLICT (domain) DO NOTHING",
        [s.name, s.domain]
      );
    }

    for (const c of COMPANIES) {
      await db.query(
        "INSERT INTO companies (name, keywords, active) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING",
        [c.name, JSON.stringify(c.keywords)]
      );
    }

    for (const t of TOPICS) {
      await db.query(
        "INSERT INTO topics (keyword, active) VALUES ($1, false) ON CONFLICT (keyword) DO NOTHING",
        [t]
      );
    }

    const companiesRes = await db.query("SELECT id FROM companies");
    for (const c of companiesRes.rows) {
      await ensureLead(c.id);
    }

    const [cCount, sCount, tCount] = await Promise.all([
      db.query("SELECT COUNT(*)::int n FROM companies"),
      db.query("SELECT COUNT(*)::int n FROM sites"),
      db.query("SELECT COUNT(*)::int n FROM topics"),
    ]);

    console.log(
      `Watchlist ready: ${cCount.rows[0].n} companies, ` +
        `${sCount.rows[0].n} sources, ` +
        `${tCount.rows[0].n} topic keywords (off by default).`
    );

    // --- admin account ---------------------------------------------------------
    const adminCountRes = await db.query("SELECT COUNT(*)::int n FROM users WHERE role = 'admin'");
    const adminCount = adminCountRes.rows[0]?.n || 0;
    if (adminCount > 0) {
      console.log(`\n${adminCount} admin account(s) already exist. Nothing else to do.`);
      console.log("Start the app with: npm start\n");
      process.exit(0);
    }

    const envUser = (process.env.ADMIN_USERNAME || "").trim();
    const envPass = (process.env.ADMIN_PASSWORD || "").trim();
    const envName = (process.env.ADMIN_DISPLAY_NAME || "").trim() || envUser;

    if (envUser && envPass.length >= 6) {
      await db.query(
        "INSERT INTO users (username, display_name, password_hash, role, active) VALUES ($1, $2, $3, 'admin', true)",
        [envUser.toLowerCase(), envName, hashPassword(envPass)]
      );
      console.log(`\nAdmin "${envUser}" created from environment variables.`);
      console.log("Start the app with: npm start\n");
      process.exit(0);
    }

    console.log("\nCreate the first admin account.\n");
    const username = (await ask("Username: ")) || "admin";
    const displayName = (await ask("Display name: ")) || username;
    let password = "";
    while (password.length < 6) {
      password = await ask("Password (min 6 chars): ", { silent: true });
      if (password.length < 6) console.log("Too short, try again.");
    }

    await db.query(
      "INSERT INTO users (username, display_name, password_hash, role, active) VALUES ($1, $2, $3, 'admin', true)",
      [username.toLowerCase(), displayName, hashPassword(password)]
    );

    console.log(`\nAdmin "${username}" created.`);
    console.log("Start the app with: npm start");
    console.log("Then open the app and add the rest of your team from the Admin tab.\n");
    process.exit(0);
  } catch (err) {
    console.error("\n[setup failed]:", err.message);
    process.exit(1);
  }
})();
