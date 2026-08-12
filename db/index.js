const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const connectionString =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL;

const poolConfig = {
  connectionString,
};

if (connectionString && !connectionString.includes("localhost")) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client", err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, "utf8");
    await pool.query(sql);
  }
}

module.exports = {
  pool,
  query,
  initSchema,
};
