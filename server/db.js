import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    })
  : null;

export async function ensureSchema() {
  if (!pool) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

export function requireDatabase(_request, response, next) {
  if (!pool) {
    response.status(503).json({
      error: "DATABASE_URL is not configured. Copy .env.example to .env and set a PostgreSQL connection string.",
    });
    return;
  }
  next();
}
