// Thin execution wrapper around src/operator.ts (pure logic, unit-tested).
// Connects with deployment IAM / operator DB credentials from the environment.
// Requires: DATABASE_URL, X402_STORE_ENC_KEY. Never run against production
// without an approved change record. No settlement is submitted by any path here.
import pg from "pg";
import { parseReleaseArgs, resolveReleaseBlockhash, OPERATOR_USAGE } from "./src/operator.ts";
import { PostgresSettlementStore, pgTransactable, parseEncryptionKey } from "./src/x402-settlement-store.ts";

// Minimal inline isBlockhashValid read. Mirrors checkBlockhashExpired() in
// src/x402.ts, which cannot be imported here: that module uses TypeScript
// parameter properties that plain-node type stripping rejects, and this CLI
// must stay runnable without a build step. Any logic change there must be
// mirrored here (covered by the stub-matrix unit tests on the canonical copy).
async function fetchBlockhashValidity(rpcUrl, blockhash, timeoutMs = 15000) {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "isBlockhashValid", params: [blockhash, { commitment: "finalized" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { expired: false, slot: null };
    const data = await response.json();
    const value = data?.result?.value;
    const slot = data?.result?.context?.slot;
    if (typeof value !== "boolean") return { expired: false, slot: null };
    return { expired: value === false, slot: typeof slot === "number" ? slot : null };
  } catch {
    return { expired: false, slot: null };
  }
}

const getFlag = (argv, flag) => {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
};

const [, , command, ...rest] = process.argv;
const wantsHelp = [command, ...rest].includes("--help") || [command, ...rest].includes("-h");
if (command !== "release" || wantsHelp) {
  console.log(OPERATOR_USAGE);
  process.exit(wantsHelp || command === "release" ? 0 : 1);
}

const parsed = parseReleaseArgs(rest);
if (!parsed.ok) {
  console.error(`error: ${parsed.error}\n\n${OPERATOR_USAGE}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("error: DATABASE_URL is required (operator credentials via deployment IAM).");
  process.exit(1);
}
const rpcUrl = getFlag(rest, "--rpc-url") || process.env.X402_SOLANA_RPC_URL;
if (!rpcUrl) {
  console.error("error: --rpc-url or X402_SOLANA_RPC_URL is required for the canonical validity check.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 15000,
  // Strict TLS always (Supabase CA via NODE_EXTRA_CA_CERTS); never plaintext.
  ssl: { rejectUnauthorized: true },
});
try {
  const store = new PostgresSettlementStore(
    pgTransactable(pool),
    parseEncryptionKey(process.env.X402_STORE_ENC_KEY),
  );
  const row = await store.getByOperationId(parsed.args.operationId);
  if (!row) {
    console.error("error: unknown operation");
    process.exit(1);
  }
  const resolved = resolveReleaseBlockhash(row.blockhash, parsed.args.blockhash);
  if (!resolved.ok) {
    console.error(`error: ${resolved.error}`);
    process.exit(1);
  }
  const verdict = await fetchBlockhashValidity(rpcUrl, resolved.blockhash);
  if (!verdict.expired) {
    console.error(`error: blockhash still valid or unverifiable (slot=${verdict.slot}); release refused.`);
    process.exit(1);
  }
  if (verdict.slot === null) {
    console.error("error: validity check returned no chain slot; release refused.");
    process.exit(1);
  }
  const result = await store.releaseAttempt(parsed.args.operationId, {
    operatorId: parsed.args.operatorId,
    newApprovalEventId: parsed.args.newApprovalEventId,
    note: parsed.args.note,
    blockhash: resolved.blockhash,
    blockhashValid: false,
    checkedSlot: verdict.slot,
    transferVerification: parsed.args.transferVerification,
  });
  if (!result.ok) {
    console.error(`release rejected: ${(result.reasons ?? []).join("; ")}`);
    process.exit(1);
  }
  console.log(`released ${result.row.operationId} -> ${result.row.releasedToApproval} by ${result.row.releasedBy}`);
} finally {
  await pool.end();
}
