require("dotenv").config();

const readline = require("readline");
const db = require("./index");
const { hashPassword } = require("../lib/auth");
const { ensureLead } = require("../services/pipeline");

// Carried over from the original config/ folder so nothing is lost in the move.
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

// Off by default - turning these on narrows results to business events only.
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
  console.log("\nCurious Media - Lead Intelligence setup\n");

  // --- watchlist -------------------------------------------------------------
  const insertSite = db.prepare("INSERT OR IGNORE INTO sites (name, domain) VALUES (?, ?)");
  const insertCompany = db.prepare("INSERT OR IGNORE INTO companies (name, keywords) VALUES (?, ?)");
  const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (keyword, active) VALUES (?, 0)");

  db.transaction(() => {
    for (const s of SITES) insertSite.run(s.name, s.domain);
    for (const c of COMPANIES) insertCompany.run(c.name, JSON.stringify(c.keywords));
    for (const t of TOPICS) insertTopic.run(t);
  })();

  for (const c of db.prepare("SELECT id FROM companies").all()) ensureLead(c.id);

  console.log(
    `Watchlist ready: ${db.prepare("SELECT COUNT(*) n FROM companies").get().n} companies, ` +
      `${db.prepare("SELECT COUNT(*) n FROM sites").get().n} sources, ` +
      `${db.prepare("SELECT COUNT(*) n FROM topics").get().n} topic keywords (off by default).`
  );

  // --- admin account ---------------------------------------------------------
  const adminCount = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  if (adminCount > 0) {
    console.log(`\n${adminCount} admin account(s) already exist. Nothing else to do.`);
    console.log("Start the app with:  npm start\n");
    process.exit(0);
  }

  const envUser = (process.env.ADMIN_USERNAME || "").trim();
  const envPass = (process.env.ADMIN_PASSWORD || "").trim();
  const envName = (process.env.ADMIN_DISPLAY_NAME || "").trim() || envUser;

  if (envUser && envPass.length >= 6) {
    db.prepare(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')"
    ).run(envUser.toLowerCase(), envName, hashPassword(envPass));
    console.log(`\nAdmin "${envUser}" created from environment variables.`);
    console.log("Start the app with:  npm start\n");
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

  db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')"
  ).run(username.toLowerCase(), displayName, hashPassword(password));

  console.log(`\nAdmin "${username}" created.`);
  console.log("Start the app with:  npm start");
  console.log("Then open the app URL and add the rest of your team from the Admin tab.\n");
  process.exit(0);
})();
