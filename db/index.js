const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "leads.db");

const db = new Database(DB_PATH);

// Apply the schema. Every statement is IF NOT EXISTS, so this is safe to run
// on every boot and doubles as the migration step for a fresh machine.
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

module.exports = db;
module.exports.DB_PATH = DB_PATH;
