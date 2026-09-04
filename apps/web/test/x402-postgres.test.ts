import { describe, expect, it, beforeAll } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// Real-PostgreSQL tests for durable settlement. Gated: skipped unless
// TEST_PG_URL points at a disposable instance (never Devnet-adjacent data).
// Orchestrator flow: provision cluster → run migrate.mjs → TEST_PG_URL=...
// vitest run test/x402-postgres.test.ts → stop cluster, delete data dir.
// No facilitator/RPC/chain calls anywhere in this file.

const PG_URL = process.env.TEST_PG_URL ?? "";
const ENC_KEY = process.env.TEST_PG_ENC_KEY ?? "ab".repeat(32);
const runLive = PG_URL.length > 0;
const describeOrSkip = runLive ? describe : describe.skip;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATE = join(ROOT, "packages", "payments", "migrate.mjs");
const MIGRATIONS = join(ROOT, "packages", "payments", "migrations");
const WORKER = join(ROOT, "apps", "web", "test", "pg-settle-worker.mjs");

function runMigrate(): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("node", [MIGRATE, MIGRATIONS], {
      env: { ...process.env, DATABASE_URL: PG_URL },
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, output: `${stdout}\n${stderr}` });
    });
  });
}

// pg resolves from the workspace package that depends on it (apps/web must
// not depend on pg directly). Structural typing only — no pg type import, so
// this file typechecks without the dependency. No Devnet calls here.
type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};
const requireFromPayments = createRequire(join(ROOT, "packages", "payments", "src", "x402-settlement-store.ts"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = requireFromPayments("pg") as { Pool: new (opts: Record<string, unknown>) => PgPool };

async function pgQuery(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
  try {
    const result = await pool.query(text, params);
    return { rows: result.rows };
  } finally {
    await pool.end();
  }
}

function spawnWorker(args: string[]): { proc: ChildProcess; firstLine: Promise<string>; done: Promise<number> } {
  const proc = spawn(process.execPath, [WORKER, ...args], {
    env: { ...process.env, TEST_PG_URL: PG_URL, TEST_PG_ENC_KEY: ENC_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let resolveFirst!: (line: string) => void;
  let rejectFirst!: (err: Error) => void;
  const firstLine = new Promise<string>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  let settled = false;
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const nl = buffer.indexOf("\n");
    if (nl >= 0 && !settled) {
      settled = true;
      resolveFirst(buffer.slice(0, nl));
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<number>((resolve) => {
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        rejectFirst(new Error(`worker exited code=${code} before first output. stderr: ${stderr.slice(0, 2000)}`));
      }
      resolve(code ?? 1);
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        rejectFirst(err);
      }
    });
  });
  return { proc, firstLine, done };
}

describeOrSkip("postgres migrations (disposable instance)", () => {
  beforeAll(async () => {
    const result = await runMigrate();
    if (result.code !== 0) console.error("MIGRATE_FAILED_OUTPUT:", result.output);
    expect(result.code).toBe(0);
  }, 60_000);

  it("forward migration creates tables, enum, and uniqueness indexes", async () => {
    const tables = await pgQuery(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('x402_settlement_attempts','x402_reconciliation_history','schema_migrations')",
    );
    expect(tables.rows.map((r) => r.tablename).sort()).toEqual([
      "schema_migrations",
      "x402_reconciliation_history",
      "x402_settlement_attempts",
    ]);
    const indexes = await pgQuery(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'x402_settlement_attempts'",
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain("ux_active_order_intent");
    expect(names).toContain("ux_pid_active");
    const columns = await pgQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'x402_settlement_attempts'",
    );
    const cols = columns.rows.map((r) => r.column_name);
    for (const required of ["operation_id", "auth_revision", "blockhash", "lease_owner", "fence_token", "released_to_approval"]) {
      expect(cols).toContain(required);
    }
  });

  it("migration rerun is idempotent", async () => {
    const result = await runMigrate();
    expect(result.code).toBe(0);
    expect(result.output).toContain("already applied");
  });

  it("rollback drops settlement tables, forward restores them", async () => {
    const down = await readFile(join(MIGRATIONS, "001_x402_settlement.down.sql"), "utf8");
    const pool: PgPool = new pg.Pool({ connectionString: PG_URL, max: 1 });
    try {
      // Strip full-line comments first so statement splitting never drops DDL.
      const statements = down
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(statements.length).toBeGreaterThan(0);
      for (const stmt of statements) {
        await pool.query(stmt);
      }
      const gone = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'x402_%'",
      );
      expect(gone.rows).toHaveLength(0);
      // A down procedure must also clear the tracker, or forward will skip.
      await pool.query("DELETE FROM schema_migrations WHERE filename = '001_x402_settlement.sql'");
    } finally {
      await pool.end();
    }
    const forward = await runMigrate();
    expect(forward.code).toBe(0);
    const back = await pgQuery("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'x402_settlement_attempts'");
    expect(back.rows).toHaveLength(1);
  }, 60_000);
});

describeOrSkip("postgres encryption-key failures", () => {
  it("rejects missing, short, and non-hex keys at boot validation", async () => {
    const { parseEncryptionKey } = await import("@agentready/payments/x402-settlement-store");
    for (const bad of [undefined, "", "short", "zz".repeat(32), "ab".repeat(31)]) {
      expect(() => parseEncryptionKey(bad)).toThrow("X402_STORE_ENC_KEY");
    }
    expect(parseEncryptionKey("ab".repeat(32))).toHaveLength(32);
  });

  it("wrong-key and tampered-ciphertext decryption fails closed", async () => {
    const mod = await import("@agentready/payments/x402-settlement-store");
    const pool: PgPool = new pg.Pool({ connectionString: PG_URL, max: 1 });
    try {
      const storeA = new mod.PostgresSettlementStore(
        mod.pgTransactable(pool as never),
        mod.parseEncryptionKey("ab".repeat(32)),
      );
      const storeB = new mod.PostgresSettlementStore(
        mod.pgTransactable(pool as never),
        mod.parseEncryptionKey("cd".repeat(32)),
      );
      const sealed = storeA.encryptSignedPayload('{"secret":"payload"}');
      expect(() => storeB.decryptSignedPayload(sealed)).toThrow();
      const tampered = sealed.slice(0, -4) + "AAAA";
      expect(() => storeA.decryptSignedPayload(tampered)).toThrow();
      expect(storeA.decryptSignedPayload(sealed)).toBe('{"secret":"payload"}');
    } finally {
      await pool.end();
    }
  });
});

describeOrSkip("multiprocess settlement (two processes, one database)", () => {
  const orderId = `ord_mp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const digest = "d".repeat(64);
  const pid = `pay_mp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  function claimArgs(owner: string, extra: string[] = []): string[] {
    return [
      "--op", "resolve-claim",
      "--order", orderId, "--intent", "1", "--digest", digest,
      "--pid", pid, "--owner", owner, "--ttl", "60000", ...extra,
    ];
  }

  it("two processes racing one claim produce exactly one winner", async () => {
    const a = spawnWorker(claimArgs("worker-A"));
    const b = spawnWorker(claimArgs("worker-B"));
    const [lineA, lineB] = await Promise.all([a.firstLine, b.firstLine]);
    const [codeA, codeB] = await Promise.all([a.done, b.done]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const ra = JSON.parse(lineA) as { kind: string; fence?: string };
    const rb = JSON.parse(lineB) as { kind: string; fence?: string };
    const kinds = [ra.kind, rb.kind].sort();
    // One winner (or joiner on an already-settling row); never two winners.
    const winners = [ra, rb].filter((r) => r.kind === "won");
    expect(winners).toHaveLength(1);
    expect(kinds).toContain("won");
    // Loser either lost the race or joined; it never settled anything.
    expect(["lost-race", "joined"]).toContain(kinds[0]);
  }, 30_000);

  it("SIGKILLed lease holder is fenced out; sweeper with fresh fence takes over", async () => {
    const crashOrder = `ord_crash_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const crashPid = `pay_crash_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const victim = spawnWorker([
      "--op", "resolve-claim",
      "--order", crashOrder, "--intent", "1", "--digest", digest,
      "--pid", crashPid, "--owner", "worker-victim", "--ttl", "700", "--hang-ms", "30000",
    ]);
    const wonLine = await victim.firstLine;
    const won = JSON.parse(wonLine) as { kind: string; fence?: string; operationId?: string };
    expect(won.kind).toBe("won");
    victim.proc.kill("SIGKILL");
    await victim.done;
    // Lease (700ms) must lapse before the sweeper can claim.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sweeper = spawnWorker([
      "--op", "reconcile", "--owner", "sweeper-1", "--ttl", "60000",
    ]);
    const sweepLine = await sweeper.firstLine;
    const sweepCode = await sweeper.done;
    expect(sweepCode).toBe(0);
    const swept = JSON.parse(sweepLine) as { claimed: Array<{ operationId: string; fence: string }> };
    const mine = swept.claimed.find((c) => c.operationId === won.operationId);
    expect(mine).toBeDefined();
    expect(mine!.fence).not.toBe(won.fence);
  }, 30_000);
});

describeOrSkip("rbac: app role technically cannot release (trigger-enforced)", () => {
  async function withRole<T>(role: string, fn: (query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<T>): Promise<T> {
    const { createRequire } = await import("node:module");
    const require = createRequire(join(ROOT, "packages", "payments", "src", "x402-settlement-store.ts"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pgMod = require("pg") as { Pool: new (opts: Record<string, unknown>) => {
      connect: () => Promise<{ query: (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: () => void }>;
      end: () => Promise<void>;
    } };
    const pool = new pgMod.Pool({ connectionString: PG_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      return await fn((text, params) => client.query(text, params));
    } finally {
      try { await client.query("RESET ROLE"); } catch { /* best effort */ }
      client.release();
      await pool.end();
    }
  }

  async function seedManualRow(suffix: string): Promise<string> {
    const operationId = `op_rbac_${suffix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await pgQuery(
      `INSERT INTO x402_settlement_attempts
         (operation_id, logical_order_id, intent_version, request_digest, resource, auth_revision, caller_payment_id, status)
       VALUES ($1, $2, 1, $3, '/api/resources/premium-fit-score', 'sauth_test', $4, 'manual')`,
      [operationId, `ord_rbac_${suffix}`, "d".repeat(64), `pay_rbac_${suffix}`],
    );
    return operationId;
  }

  it("x402_app is rejected from released with 42501", async () => {
    const operationId = await seedManualRow("app");
    await expect(
      withRole("x402_app", (query) =>
        query(`UPDATE x402_settlement_attempts SET status = 'released', updated_at = now() WHERE operation_id = $1`, [operationId])),
    ).rejects.toThrow(/x402_operator|42501/);
    const check = await pgQuery("SELECT status FROM x402_settlement_attempts WHERE operation_id = $1", [operationId]);
    expect(check.rows[0]?.status).toBe("manual");
  });

  it("x402_app retains legitimate non-release writes (trigger is narrow)", async () => {
    const operationId = await seedManualRow("narrow");
    await withRole("x402_app", async (query) => {
      await query(`UPDATE x402_settlement_attempts SET status = 'awaiting_evidence', tx_hash = 'tx_test' WHERE operation_id = $1`, [operationId]);
    });
    const check = await pgQuery("SELECT status, tx_hash FROM x402_settlement_attempts WHERE operation_id = $1", [operationId]);
    expect(check.rows[0]?.status).toBe("awaiting_evidence");
  });

  it("x402_operator can write released", async () => {    const operationId = await seedManualRow("op");
    await withRole("x402_operator", async (query) => {
      await query(
        `UPDATE x402_settlement_attempts SET status = 'released', released_to_approval = 'appr_test', released_by = 'op_test', updated_at = now() WHERE operation_id = $1`,
        [operationId],
      );
    });
    const check = await pgQuery("SELECT status FROM x402_settlement_attempts WHERE operation_id = $1", [operationId]);
    expect(check.rows[0]?.status).toBe("released");
  });

  it("direct INSERT in released state is forbidden for every role", async () => {
    const operationId = `op_rbac_insert_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await expect(
      pgQuery(
        `INSERT INTO x402_settlement_attempts
           (operation_id, logical_order_id, intent_version, request_digest, resource, auth_revision, status)
         VALUES ($1, 'ord_rbac_insert', 1, $2, '/api/resources/premium-fit-score', 'sauth_x', 'released')`,
        [operationId, "e".repeat(64)],
      ),
    ).rejects.toThrow(/released.*forbidden|42501/);
    const check = await pgQuery("SELECT operation_id FROM x402_settlement_attempts WHERE operation_id = $1", [operationId]);
    expect(check.rows).toHaveLength(0);
  });
});
