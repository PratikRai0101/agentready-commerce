// Applies packages/payments/migrations/*.sql in filename order using a single
// session under pg_advisory_xact_lock so concurrent deploys serialize.
// Requires DATABASE_URL. Destructive (*.down.sql) files are never applied.
// Usage: node migrate.mjs [migrations-dir]
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
  .sort();
if (files.length === 0) {
  console.log("No migrations to apply.");
  process.exit(0);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: { rejectUnauthorized: true },
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('x402_settlement_migrations'))");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename));
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip ${file} (already applied)`);
      continue;
    }
    await client.query(readFileSync(join(dir, file), "utf8"));
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    console.log(`applied ${file}`);
  }
  await client.query("COMMIT");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* already failed */ }
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
