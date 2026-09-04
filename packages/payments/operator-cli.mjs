// Thin execution wrapper around src/operator.ts (pure logic, unit-tested).
// Connects with deployment IAM / operator DB credentials from the environment.
// Requires: DATABASE_URL, X402_STORE_ENC_KEY. Never run against production
// without an approved change record. No settlement is submitted by any path here:
// - release: manual→released transition only.
// - reconcile-settled: persists an already-finalized signature (read-only RPC
//   inspection) with a settling/awaiting_evidence→settled transition only.
import pg from "pg";
import { parseReleaseArgs, parseReconcileSettledArgs, persistReconciledSettlement, resolveReleaseBlockhash, validateReconcileSettledEvidence, OPERATOR_USAGE } from "./src/operator.ts";
import { PostgresSettlementStore, pgTransactable, parseEncryptionKey } from "./src/x402-settlement-store.ts";
import { extractTransactionSignature } from "./src/x402.ts";

// Canonical devnet constants (mirrors packages/payments/src/x402-config.ts and
// src/devnet-machine.ts, which cannot be imported here: that module graph uses
// TypeScript parameter properties that plain-node type stripping rejects, and
// this CLI must stay runnable without a build step).
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1sT3L4f5Y7W8X9Y",
]);

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

// Read-only finalized transaction inspection. Never submits, signs, or pays.
async function fetchFinalizedTransaction(rpcUrl, signature, timeoutMs = 30000) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error("RPC rejected the transaction inspection request");
  return data?.result ?? null;
}

const str = (v) => (typeof v === "string" && v.length > 0 ? v : undefined);

function inspectFinalizedForReconcile(tx, expected) {
  if (!tx || typeof tx !== "object") return { ok: false, reason: "transaction not queryable (not finalized yet or unknown signature)" };
  const slot = tx.slot;
  if (typeof slot !== "number") return { ok: false, reason: "transaction has no slot" };
  const meta = tx.meta;
  const message = tx.transaction?.message;
  if (!meta || !message) return { ok: false, reason: "transaction missing meta/message" };
  if (!Object.prototype.hasOwnProperty.call(meta, "err") || meta.err !== null) {
    return { ok: false, reason: "transaction did not complete successfully (meta.err was not null)" };
  }
  const topInstructions = Array.isArray(message.instructions) ? message.instructions : [];
  const innerGroups = Array.isArray(meta.innerInstructions) ? meta.innerInstructions : [];
  const innerInstructions = innerGroups.flatMap((g) => (Array.isArray(g?.instructions) ? g.instructions : []));
  const all = [...topInstructions, ...innerInstructions];
  const memoOk = all.some((ix) => ix?.program === "spl-memo" && ix?.programId === MEMO_PROGRAM_ID && ix?.parsed === expected.memo);
  if (!memoOk) return { ok: false, reason: "exact request-bound memo not found in transaction" };
  const accountKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map((k) => (typeof k === "string" ? k : str(k?.pubkey) ?? ""))
    : [];
  const postBalances = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  const preBalances = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const candidates = [];
  for (const ix of all) {
    const programId = str(ix?.programId);
    const program = str(ix?.program);
    if ((programId && !TOKEN_PROGRAM_IDS.has(programId)) || (!programId && program !== "spl-token")) continue;
    const parsed = ix?.parsed;
    const info = parsed?.info;
    const type = str(parsed?.type);
    if (!info || (type !== "transfer" && type !== "transferChecked")) continue;
    const tokenAmount = info.tokenAmount;
    const destination = str(info.destination);
    const source = str(info.source);
    if (!destination) continue;
    const destIdx = accountKeys.indexOf(destination);
    const srcIdx = accountKeys.indexOf(source ?? "");
    const destBal = postBalances.find((b) => b?.accountIndex === destIdx);
    const srcBal = preBalances.find((b) => b?.accountIndex === srcIdx);
    const mint = str(info.mint) ?? str(destBal?.mint);
    const amount = str(tokenAmount?.amount) ?? str(info.amount);
    const payer = str(info.authority) ?? str(info.owner) ?? str(srcBal?.owner);
    if (!mint || !amount || !payer) continue;
    const recipient = str(destBal?.owner) ?? (destIdx >= 0 ? accountKeys[destIdx] : undefined) ?? destination;
    candidates.push({ mint, amount, recipient, payer });
  }
  const matches = candidates.filter((t) =>
    t.mint === expected.asset && t.amount === expected.amount &&
    t.recipient === expected.payee && t.payer === expected.payer,
  );
  if (candidates.length !== 1 || matches.length !== 1) {
    return { ok: false, reason: "transaction does not contain exactly one expected token transfer (mint, amount, recipient and payer must match)" };
  }
  const feePayer = accountKeys.length > 0 && accountKeys[0] ? accountKeys[0] : "unknown";
  return { ok: true, slot, feePayer, transfer: matches[0] };
}

const getFlag = (argv, flag) => {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
};

const [, , command, ...rest] = process.argv;
const wantsHelp = [command, ...rest].includes("--help") || [command, ...rest].includes("-h");
if ((command !== "release" && command !== "reconcile-settled") || wantsHelp) {
  console.log(OPERATOR_USAGE);
  process.exit(wantsHelp ? 0 : 1);
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

  if (command === "reconcile-settled") {
    const parsed = parseReconcileSettledArgs(rest);
    if (!parsed.ok) {
      console.error(`error: ${parsed.error}\n\n${OPERATOR_USAGE}`);
      process.exit(1);
    }
    const gate = validateReconcileSettledEvidence({
      operatorId: parsed.args.operatorId,
      txHash: parsed.args.txHash,
      checkedSlot: parsed.args.checkedSlot,
      note: parsed.args.note,
    });
    if (!gate.ok) {
      console.error(`reconcile rejected: ${gate.reasons.join("; ")}`);
      process.exit(1);
    }
    const row = await store.getByOperationId(parsed.args.operationId);
    if (!row) {
      console.error("error: unknown operation");
      process.exit(1);
    }
    if (row.status === "settled") {
      if (row.txHash !== parsed.args.txHash) {
        console.error("error: attempt is already settled with a different transaction signature; refusing to rewrite");
        process.exit(1);
      }
      console.log(`already-settled ${row.operationId} tx=${row.txHash} (no write, no resubmission)`);
      process.exit(0);
    }
    if (row.status !== "settling" && row.status !== "awaiting_evidence") {
      console.error(`error: reconcile requires status settling/awaiting_evidence (current: ${row.status}); terminal rows are never rewritten`);
      process.exit(1);
    }
    if (row.txHash && row.txHash !== parsed.args.txHash) {
      console.error("error: a different transaction signature is already bound to this attempt; refusing to overwrite");
      process.exit(1);
    }
    if (!row.payer) {
      console.error("error: attempt has no verified payer; cannot match the on-chain transfer");
      process.exit(1);
    }
    const asset = getFlag(rest, "--asset") || USDC_DEVNET_MINT;
    const amount = getFlag(rest, "--amount") || "10000";
    const payee = getFlag(rest, "--payee") || "";
    if (!payee) {
      console.error("error: --payee <expected-recipient-pubkey> is required");
      process.exit(1);
    }
    const facilitatorUrl = getFlag(rest, "--facilitator-url") || DEFAULT_FACILITATOR_URL;
    // Read-only inspection: getTransaction only. No settle, no submit, no sign.
    let tx = null;
    try {
      tx = await fetchFinalizedTransaction(rpcUrl, parsed.args.txHash);
    } catch {
      tx = null;
    }
    const verdict = inspectFinalizedForReconcile(tx, {
      memo: `agentcart:v1:${row.requestDigest}`,
      asset,
      amount,
      payee,
      payer: row.payer,
    });
    if (!verdict.ok) {
      console.error(`error: on-chain validation failed: ${verdict.reason}`);
      process.exit(1);
    }
    if (verdict.slot !== parsed.args.checkedSlot) {
      console.error(`error: cited --slot ${parsed.args.checkedSlot} does not match chain slot ${verdict.slot}; re-inspect and cite the observed slot`);
      process.exit(1);
    }
    const feePayer = getFlag(rest, "--fee-payer") || verdict.feePayer;
    const evidence = {
      paymentIdentifier: row.callerPaymentId ?? "",
      network: SOLANA_DEVNET_CAIP2,
      asset,
      amount,
      payer: row.payer,
      payee,
      feePayer,
      transactionHash: parsed.args.txHash,
      facilitatorUrl,
      verificationResult: "verified",
      settlementResult: "reconciled",
      requestDigest: row.requestDigest,
      checkedSlot: verdict.slot,
      timestamp: new Date().toISOString(),
      explorerUrl: `https://explorer.solana.com/tx/${parsed.args.txHash}?cluster=devnet`,
      memoVerification: "verified",
      transferVerification: "verified",
      transfer: verdict.transfer,
    };
    const persisted = await persistReconciledSettlement(store, {
      operationId: row.operationId,
      operatorId: parsed.args.operatorId,
      txHash: parsed.args.txHash,
      checkedSlot: verdict.slot,
      note: parsed.args.note,
      evidenceJson: evidence,
    });
    if (!persisted.ok) {
      console.error(`error: ${persisted.reasons.join("; ")}; no write performed`);
      process.exit(1);
    }
    if (persisted.alreadySettled) {
      console.log(`already-settled ${persisted.row.operationId} tx=${persisted.row.txHash} (no resubmission)`);
      process.exit(0);
    }
    console.log(`reconciled ${persisted.row.operationId} -> settled tx=${persisted.row.txHash} slot=${verdict.slot}`);
    process.exit(0);
  }

  const parsed = parseReleaseArgs(rest);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}\n\n${OPERATOR_USAGE}`);
    process.exit(1);
  }
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

  // Blockhash expiry alone does not prove that the signed transaction never
  // landed. Derive the signature from the stored wire payload and refuse the
  // release if finalized RPC can see any transaction for it. A missing or
  // unreadable payload is also a refusal, never an invitation to retry.
  if (row.txHash) {
    console.error("error: attempt already has a transaction signature; reconcile it instead of releasing");
    process.exit(1);
  }
  let signedTransactionSignature;
  try {
    const storedPayload = row.signedPayloadEnc ? store.decryptSignedPayload(row.signedPayloadEnc) : "";
    signedTransactionSignature = extractTransactionSignature(storedPayload);
  } catch {
    signedTransactionSignature = null;
  }
  if (!signedTransactionSignature) {
    console.error("error: stored signed transaction signature is unavailable; release refused");
    process.exit(1);
  }
  let existingTransaction;
  try {
    existingTransaction = await fetchFinalizedTransaction(rpcUrl, signedTransactionSignature);
  } catch {
    console.error("error: finalized transaction inspection failed; release refused");
    process.exit(1);
  }
  if (existingTransaction !== null) {
    console.error("error: signed transaction is present on-chain; reconcile or manually resolve it, release refused");
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
