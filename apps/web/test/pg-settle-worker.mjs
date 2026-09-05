// Disposable-Postgres worker for multiprocess settlement tests.
// One operation per invocation, JSON result on stdout. Exits nonzero on error.
// Imports TypeScript directly (Node type stripping); connects with operator-
// supplied DATABASE_URL only. Never settles, signs, or touches Devnet.
import {
  PostgresSettlementStore,
  createSettlementPool,
  pgTransactable,
  parseEncryptionKey,
} from "../../../packages/payments/src/x402-settlement-store.ts";

function arg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const out = (obj) => {
  console.log(JSON.stringify(obj));
};

async function main() {
  const op = arg("--op", "");
  const databaseUrl = process.env.TEST_PG_URL || "";
  const encKeyHex = process.env.TEST_PG_ENC_KEY || "";
  if (!databaseUrl) throw new Error("TEST_PG_URL is required");
  const pool = createSettlementPool(databaseUrl, { poolMax: 1 });
  try {
    const store = new PostgresSettlementStore(pgTransactable(pool), parseEncryptionKey(encKeyHex));
    if (op === "resolve-claim") {
      const input = {
        logicalOrderId: arg("--order", ""),
        intentVersion: Number(arg("--intent", "1")),
        requestDigest: arg("--digest", ""),
        resource: arg("--resource", "/api/resources/premium-fit-score"),
        approvalEventId: arg("--approval", undefined),
        callerPaymentId: arg("--pid", ""),
      };
      const resolution = await store.resolveOrCreate(input);
      if (resolution.kind !== "created" && resolution.kind !== "existing") {
        out({ kind: resolution.kind, detail: resolution.detail });
        return;
      }
      const row = resolution.row;
      if (row.status !== "pending") {
        out({ kind: "joined", status: row.status, operationId: row.operationId });
        return;
      }
      const owner = arg("--owner", `worker-${process.pid}`);
      const claimed = await store.claimForSettle(row.operationId, owner, Number(arg("--ttl", "60000")));
      if (!claimed) {
        out({ kind: "lost-race", operationId: row.operationId });
        return;
      }
      out({ kind: "won", operationId: row.operationId, fence: claimed.fenceToken, status: claimed.status });
      const hangMs = Number(arg("--hang-ms", "0"));
      if (hangMs > 0) await new Promise((resolve) => setTimeout(resolve, hangMs));
      return;
    }
    if (op === "reconcile") {
      const claimed = await store.claimForReconcile(arg("--owner", `sweeper-${process.pid}`), Number(arg("--ttl", "60000")), 10);
      out({ claimed: claimed.map((r) => ({ operationId: r.operationId, fence: r.fenceToken, status: r.status })) });
      return;
    }
    if (op === "read") {
      const row = await store.getByOperationId(arg("--operation-id", ""));
      out({ row });
      return;
    }
    throw new Error(`unknown --op ${op}`);
  } finally {
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`worker error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
