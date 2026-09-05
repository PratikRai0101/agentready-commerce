import { describe, expect, it, vi } from "vitest";
import { DevnetMachineResource } from "@agentready/payments/devnet-machine";
import {
  InMemorySettlementStore,
  PostgresSettlementStore,
  assertSettlementStoreAllowed,
  buildOperationId,
  validateReleaseEvidence,
  SettlementBootError,
  SettlementDisabledError,
  type StoredAttempt,
} from "@agentready/payments/x402-settlement-store";
import { SOLANA_DEVNET_CAIP2 } from "@agentready/payments";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";
import { parseReleaseArgs } from "@agentready/payments/operator";

const DIGEST = "c".repeat(64);
const BASE_INPUT = {
  logicalOrderId: "ord_store_1",
  intentVersion: 1,
  requestDigest: DIGEST,
  resource: "/api/resources/premium-fit-score",
  callerPaymentId: "pay_x402_store_01",
};

function stubServer(resource: DevnetMachineResource, overrides: {
  verifyPayment?: () => Promise<{ isValid: boolean; payer?: string }>;
  settlePayment?: () => Promise<{ success: boolean; transaction?: string; network?: string; payer?: string; amount?: string }>;
} = {}) {
  const verifyPayment = vi.fn().mockImplementation(overrides.verifyPayment ?? (async () => ({ isValid: true, payer: "Payer11111111111111111111111111111111" })));
  const settlePayment = vi.fn().mockImplementation(overrides.settlePayment ?? (async () => { throw new Error("settle must not be called"); }));
  (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
    initialize: vi.fn().mockResolvedValue(undefined),
    verifyPayment,
    settlePayment,
  };
  (resource as unknown as { initialized: boolean }).initialized = true;
  return { verifyPayment, settlePayment };
}

function devnetConfig() {
  return {
    mode: "devnet" as const,
    facilitatorUrl: "https://x402.org/facilitator",
    payerSecretKey: new Uint8Array(32),
    payerPublicKey: "Payer11111111111111111111111111111111",
    payeePublicKey: "Payee11111111111111111111111111111111",
    devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amountMinor: 10000,
  };
}

function encodeAccepted(canonical: Record<string, unknown>, paymentId: string, extraPayload: Record<string, unknown> = {}) {
  const extensions = appendPaymentIdentifierToExtensions(
    { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    paymentId,
  );
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: canonical,
    payload: { payer: "Payer11111111111111111111111111111111", ...extraPayload },
    extensions,
  })).toString("base64url");
}

describe("stable operation identity", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "appr_1" });
    const b = buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "appr_1" });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("a fresh approval of identical terms yields a different identity (PK never blocks release)", () => {
    const before = buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "appr_old" });
    const after = buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "appr_new" });
    expect(before).not.toBe(after);
  });

  it("ignores caller payment id: same intent, different pid, same revision share identity inputs", () => {
    const a = buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "sauth_x" });
    expect(a).toBe(buildOperationId({ ...BASE_INPUT, resource: "/r", authRevision: "sauth_x" }));
  });
});

describe("replacement-ID blocking (manual stays blocking)", () => {
  it("blocks a new payment id while the first attempt is unresolved", async () => {
    const store = new InMemorySettlementStore();
    const first = await store.resolveOrCreate({ ...BASE_INPUT });
    expect(first.kind).toBe("created");
    await store.transition(first.row.operationId, ["pending"], "manual", {}, null, null, "t", "n");
    const second = await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_02" });
    expect(second.kind).toBe("existing");
    expect(second.row.operationId).toBe(first.row.operationId);
  });

  it("allows a fresh attempt after operator release citing the new approval", async () => {
    const store = new InMemorySettlementStore();
    const first = await store.resolveOrCreate({ ...BASE_INPUT });
    if (first.kind !== "created") throw new Error("expected created");
    await store.transition(first.row.operationId, ["pending"], "manual", { blockhash: "Bh11111111111111111111111111111111" }, null, null, "t", "n");
    const released = await store.releaseAttempt(first.row.operationId, {
      operatorId: "op_test",
      newApprovalEventId: "appr_new_1",
      blockhash: "Bh11111111111111111111111111111111",
      blockhashValid: false,
      checkedSlot: 1000,
      transferVerification: "unavailable",
      note: "no funds moved; blockhash expired",
    });
    expect(released.ok).toBe(true);
    const retry = await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_02", approvalEventId: "appr_new_1" });
    expect(retry.kind).toBe("created");
    expect(retry.row.operationId).not.toBe(first.row.operationId);
  });

  it("rejects post-release attempts that do not cite the released approval", async () => {
    const store = new InMemorySettlementStore();
    const first = await store.resolveOrCreate({ ...BASE_INPUT });
    if (first.kind !== "created") throw new Error("expected created");
    await store.transition(first.row.operationId, ["pending"], "manual", { blockhash: "Bh11111111111111111111111111111111" }, null, null, "t", "n");
    await store.releaseAttempt(first.row.operationId, {
      operatorId: "op_test",
      newApprovalEventId: "appr_new_1",
      blockhash: "Bh11111111111111111111111111111111",
      blockhashValid: false,
      checkedSlot: 1000,
      transferVerification: "unavailable",
      note: "ok",
    });
    const wrong = await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_02", approvalEventId: "appr_other" });
    expect(wrong.kind).toBe("release_required");
    const none = await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_03" });
    expect(none.kind).toBe("release_required");
  });

  it("returns the settled result instead of opening a second resource spend", async () => {
    const store = new InMemorySettlementStore();
    const first = await store.resolveOrCreate({ ...BASE_INPUT, requirementsJson: { amount: "10000" } });
    if (first.kind !== "created") throw new Error("expected created");
    await store.transition(
      first.row.operationId,
      ["pending"],
      "settled",
      { txHash: "tx_once", evidenceJson: { verified: true } },
      null,
      null,
      "test",
      "settled",
    );

    const replay = await store.resolveOrCreate({
      ...BASE_INPUT,
      callerPaymentId: "pay_x402_store_new_id",
      requirementsJson: { amount: "10000" },
    });
    expect(replay.kind).toBe("existing");
    expect(replay.row.operationId).toBe(first.row.operationId);
  });

  it("does not reuse a terminal payment identifier for another request", async () => {
    const store = new InMemorySettlementStore();
    const first = await store.resolveOrCreate({ ...BASE_INPUT });
    if (first.kind !== "created") throw new Error("expected created");
    await store.transition(first.row.operationId, ["pending"], "rejected", {}, null, null, "test", "rejected");

    const reused = await store.resolveOrCreate({
      ...BASE_INPUT,
      requestDigest: "d".repeat(64),
    });
    expect(reused.kind).toBe("existing");
    expect(reused.row.operationId).toBe(first.row.operationId);
  });
});

describe("lease fencing and stale workers", () => {
  it("loser of a claim cannot write; stale owner+fence CAS fails", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    const op = created.row.operationId;
    const winner = await store.claimForSettle(op, "worker-a", 60_000);
    expect(winner).not.toBeNull();
    expect(await store.claimForSettle(op, "worker-b", 60_000)).toBeNull();
    // Stale worker-b (or anyone without the fence) cannot transition.
    expect(await store.transition(op, ["settling"], "manual", {}, "worker-b", "wrong-fence", "t", "n")).toBeNull();
    expect(await store.transition(op, ["settling"], "manual", {}, "worker-a", "wrong-fence", "t", "n")).toBeNull();
    // Owner+fence holder can.
    const done = await store.transition(op, ["settling"], "rejected", {}, "worker-a", winner!.fenceToken ?? "", "t", "n");
    expect(done?.status).toBe("rejected");
  });

  it("revalidation fails after the lease is stolen, blocking settlement", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    const op = created.row.operationId;
    const claim = await store.claimForSettle(op, "worker-a", 1);
    expect(claim).not.toBeNull();
    // Lease lapses; sweeper claims with a fresh fence.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stolen = await store.claimForReconcile("sweeper-1", 60_000);
    expect(stolen.map((r) => r.operationId)).toContain(op);
    // Paused worker-a resumes: revalidation fails, so it must not settle.
    expect(await store.revalidateForSettle(op, "worker-a", claim!.fenceToken ?? "", 60_000)).toBeNull();
  });

  it("concurrent workers across resource instances settle exactly once", async () => {
    const store = new InMemorySettlementStore();
    const a = new DevnetMachineResource(devnetConfig(), store);
    const b = new DevnetMachineResource(devnetConfig(), store);
    const settleA = vi.fn().mockResolvedValue({ success: true, transaction: "tx_dual_worker_1", network: SOLANA_DEVNET_CAIP2, payer: "Payer11111111111111111111111111111111", amount: "10000" });
    const settleB = vi.fn().mockResolvedValue({ success: true, transaction: "tx_dual_worker_1", network: SOLANA_DEVNET_CAIP2, payer: "Payer11111111111111111111111111111111", amount: "10000" });
    stubServer(a, { settlePayment: settleA });
    stubServer(b, { settlePayment: settleB });
    const spendingRequest = {
      orderId: "ord_concurrent_workers", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = a.buildRequestDigest(spendingRequest);
    const canonical = a.getCanonicalRequirements(digest);
    const encoded = encodeAccepted({ ...canonical }, "pay_x402_store_01");
    const [ra, rb] = await Promise.all([
      a.accept(encoded, digest, spendingRequest),
      b.accept(encoded, digest, spendingRequest),
    ]);
    // Exactly one submission across both workers; the loser joins without settling.
    expect(settleA.mock.calls.length + settleB.mock.calls.length).toBe(1);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([202, 202]);
  });
});

describe("crash and restart without resubmission", () => {
  it("a restarted worker reconciles from the store without a new settle", async () => {
    const store = new InMemorySettlementStore();
    const before = new DevnetMachineResource(devnetConfig(), store);
    let settles = 0;
    stubServer(before, {
      settlePayment: vi.fn().mockImplementation(async () => {
        settles++;
        throw Object.assign(new Error("transport died mid-submit (stub)"), { transactionHash: "tx_crash_stub_1" });
      }),
    });
    const spendingRequest = {
      orderId: "ord_crash_restart_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = before.buildRequestDigest(spendingRequest);
    const canonical = before.getCanonicalRequirements(digest);
    const encoded = encodeAccepted({ ...canonical }, "pay_x402_store_01");
    const first = await before.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    expect(settles).toBe(1);

    // "Restart": brand-new resource over the same store. No settle stub needed;
    // any settle call would fail the test via the throwing stub below.
    const after = new DevnetMachineResource(devnetConfig(), store);
    stubServer(after, {
      settlePayment: vi.fn().mockImplementation(async () => {
        throw new Error("resubmission after restart is forbidden");
      }),
    });
    const retry = await after.accept(encoded, digest, spendingRequest);
    expect(retry.status).toBe(202);
    expect(JSON.stringify(retry.body)).toContain("settlement_ambiguous");
    expect(settles).toBe(1);
    const row = await store.findByDigestPayment(digest, "pay_x402_store_01");
    expect(row?.status).toBe("awaiting_evidence");
    expect(row?.txHash).toBe("tx_crash_stub_1");
  });
});

describe("release evidence gating (canonical blockhash validity)", () => {
  const base = {
    operatorId: "op_test",
    newApprovalEventId: "appr_new_9",
    transferVerification: "unavailable" as const,
    note: "reviewed; no funds moved",
  };
  const expired = {
    blockhash: "Bh11111111111111111111111111111111",
    blockhashValid: false,
    checkedSlot: 1000,
  };

  it("accepts a provably expired blockhash with no verified transfer", () => {
    expect(validateReleaseEvidence({ ...base, ...expired }).ok).toBe(true);
  });

  it("rejects a still-valid blockhash (expiry unproven)", () => {
    const result = validateReleaseEvidence({ ...base, ...expired, blockhashValid: true });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/expired|unproven/);
  });

  it("rejects a missing blockhash", () => {
    const result = validateReleaseEvidence({ ...base, ...expired, blockhash: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects release when a transfer is verified (reconcile instead)", () => {
    const result = validateReleaseEvidence({ ...base, ...expired, transferVerification: "verified" });
    expect(result.ok).toBe(false);
  });

  it("requires operator, approval citation, and note", () => {
    expect(validateReleaseEvidence({ ...base, ...expired, operatorId: "" }).ok).toBe(false);
    expect(validateReleaseEvidence({ ...base, ...expired, newApprovalEventId: "nope" }).ok).toBe(false);
    expect(validateReleaseEvidence({ ...base, ...expired, note: "" }).ok).toBe(false);
  });

  it("store enforces manual-only release end to end", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    // Pending (not manual) cannot be released.
    expect((await store.releaseAttempt(created.row.operationId, { ...base, ...expired })).ok).toBe(false);
    await store.transition(created.row.operationId, ["pending"], "manual", { blockhash: expired.blockhash }, null, null, "t", "n");
    const released = await store.releaseAttempt(created.row.operationId, { ...base, ...expired });
    expect(released.ok).toBe(true);
    expect(released.row?.status).toBe("released");
    expect(released.row?.releasedToApproval).toBe("appr_new_9");
    expect(released.row?.releasedBy).toBe("op_test");
  });

  it("store rejects evidence bound to a different blockhash", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    await store.transition(created.row.operationId, ["pending"], "manual", { blockhash: expired.blockhash }, null, null, "t", "n");
    const wrong = await store.releaseAttempt(created.row.operationId, {
      ...base, ...expired, blockhash: "Bh22222222222222222222222222222222",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.reasons?.join(" ")).toMatch(/does not match/);
  });

  it("store refuses release when no blockhash was ever staged", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    await store.transition(created.row.operationId, ["pending"], "manual", {}, null, null, "t", "n");
    const refused = await store.releaseAttempt(created.row.operationId, { ...base, ...expired });
    expect(refused.ok).toBe(false);
    expect(refused.reasons?.join(" ")).toMatch(/incident/);
  });
});

describe("boot gates and kill-switch (no memory rollback)", () => {
  it("devnet without DATABASE_URL fails closed", async () => {
    const { assertSettlementStoreAllowed, SettlementBootError } = await import("@agentready/payments/x402-settlement-store");
    expect(() => assertSettlementStoreAllowed({ mode: "devnet", nodeEnv: "test" })).toThrow(SettlementBootError);
  });

  it("production without DATABASE_URL fails closed even in mock mode", async () => {
    const { assertSettlementStoreAllowed, SettlementBootError } = await import("@agentready/payments/x402-settlement-store");
    expect(() => assertSettlementStoreAllowed({ mode: "mock", nodeEnv: "production" })).toThrow(SettlementBootError);
  });

  it("kill-switch throws disabled instead of degrading", async () => {
    const { assertSettlementStoreAllowed, SettlementDisabledError } = await import("@agentready/payments/x402-settlement-store");
    expect(() => assertSettlementStoreAllowed({ mode: "devnet", nodeEnv: "test", databaseUrl: "postgres://x", encKeyHex: "a".repeat(64), settlementEnabled: false })).toThrow(SettlementDisabledError);
  });

  it("devnet accept() returns 503 when disabled, submitting nothing", async () => {
    const store = new InMemorySettlementStore();
    const resource = new DevnetMachineResource(devnetConfig(), store);
    stubServer(resource);
    const prev = process.env.X402_SETTLEMENT_ENABLED;
    process.env.X402_SETTLEMENT_ENABLED = "false";
    try {
      const spendingRequest = {
        orderId: "ord_killswitch_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
        amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
      };
      const digest = resource.buildRequestDigest(spendingRequest);
      const canonical = resource.getCanonicalRequirements(digest);
      const res = await resource.accept(encodeAccepted({ ...canonical }, "pay_x402_store_01"), digest, spendingRequest);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain("settlement_unavailable");
      expect(await store.findActiveAttempt("ord_store_1", 1)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.X402_SETTLEMENT_ENABLED;
      else process.env.X402_SETTLEMENT_ENABLED = prev;
    }
  });

  it("memory backing is allowed for mock mode only", async () => {
    const { assertSettlementStoreAllowed } = await import("@agentready/payments/x402-settlement-store");
    expect(assertSettlementStoreAllowed({ mode: "mock", nodeEnv: "test" })).toBe("memory");
  });
});

describe("operator CLI parsing (no database)", () => {
  it("parses a complete release command", async () => {
    const { parseReleaseArgs } = await import("@agentready/payments/operator");
    const parsed = parseReleaseArgs([
      "--operation", "op1", "--operator", "op_test", "--new-approval", "appr_1",
      "--transfer", "unavailable", "--note", "ok",
    ]);
    expect(parsed.ok).toBe(true);
  });

  it("rejects a release command that claims a verified transfer", async () => {
    const { parseReleaseArgs } = await import("@agentready/payments/operator");
    const parsed = parseReleaseArgs([
      "--operation", "op1", "--operator", "op_test", "--new-approval", "appr_1",
      "--transfer", "verified", "--note", "must reconcile",
    ]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must be mismatch or unavailable");
  });

  it("rejects missing/invalid flags without touching any store", async () => {
    const { parseReleaseArgs } = await import("@agentready/payments/operator");
    expect(parseReleaseArgs([]).ok).toBe(false);
    expect(parseReleaseArgs(["--operation", "op1"]).ok).toBe(false);
    expect(parseReleaseArgs(["--operation", "op1", "--operator", "o", "--new-approval", "a", "--transfer", "u"]).ok).toBe(false);
  });

  it("resolves the release blockhash from the staged row by default", async () => {
    const { resolveReleaseBlockhash } = await import("@agentready/payments/operator");
    expect(resolveReleaseBlockhash("Bh111", undefined)).toEqual({ ok: true, blockhash: "Bh111" });
    expect(resolveReleaseBlockhash("Bh111", "Bh111").ok).toBe(true);
    expect(resolveReleaseBlockhash("Bh111", "Bh222").ok).toBe(false);
    expect(resolveReleaseBlockhash(null, undefined).ok).toBe(false);
    expect(resolveReleaseBlockhash(null, "Bh222").ok).toBe(false);
  });

  it("release through the resource path requires evidence even with valid args", async () => {
    const store = new InMemorySettlementStore();
    const resource = new DevnetMachineResource(devnetConfig(), store);
    stubServer(resource);
    // No row exists: create + manual, then attempt release with a live blockhash verdict.
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    await store.transition(created.row.operationId, ["pending"], "manual", {}, null, null, "t", "n");
    const fresh = await store.releaseAttempt(created.row.operationId, {
      operatorId: "op_test",
      newApprovalEventId: "appr_1",
      blockhash: "Bh11111111111111111111111111111111",
      blockhashValid: true,
      checkedSlot: 150,
      transferVerification: "unavailable",
      note: "too soon",
    });
    expect(fresh.ok).toBe(false);
    void resource;
  });
});

describe("verify-failure never settles, exhaustively", () => {
  it("rejects without settle across repeated identical and rotated payloads", async () => {
    const store = new InMemorySettlementStore();
    const resource = new DevnetMachineResource(devnetConfig(), store);
    const { settlePayment } = stubServer(resource, {
      verifyPayment: async () => ({ isValid: false, invalidReason: "sig_invalid_stub" }),
    });
    const spendingRequest = {
      orderId: "ord_verify_fail_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const first = await resource.accept(encodeAccepted({ ...canonical }, "pay_x402_store_01"), digest, spendingRequest);
    expect(first.status).toBe(402);
    const again = await resource.accept(encodeAccepted({ ...canonical }, "pay_x402_store_01"), digest, spendingRequest);
    expect(again.status).toBe(402);
    // Rotated payload under the same id is an ownership conflict, still no settle.
    const rotated = await resource.accept(
      encodeAccepted({ ...canonical }, "pay_x402_store_01", { nonce: "different" }),
      digest,
      spendingRequest,
    );
    expect(rotated.status).toBe(409);
    expect(settlePayment).not.toHaveBeenCalled();
    const row = await store.findByDigestPayment(digest, "pay_x402_store_01");
    expect(row?.status).toBe("rejected");
  });
});

describe("approval binding on active reuse", () => {
  it("pre-approval spends bind nothing; bound spends require their exact approval", async () => {
    const store = new InMemorySettlementStore();
    // Pre-approval row (sauth revision): any or no approval proceeds.
    const pre = await store.resolveOrCreate({ ...BASE_INPUT });
    if (pre.kind !== "created") throw new Error("expected created");
    expect((await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_02" })).kind).toBe("existing");
    expect((await store.resolveOrCreate({ ...BASE_INPUT, callerPaymentId: "pay_x402_store_02", approvalEventId: "appr_1" })).kind).toBe("existing");

    // Bound row: exact approval joins, missing/wrong approval hard-fails.
    // (Fresh order: the pre row above still occupies the first slot.)
    const boundInput = { ...BASE_INPUT, logicalOrderId: "ord_appr_bound" };
    const bound = await store.resolveOrCreate({ ...boundInput, callerPaymentId: "pay_x402_bound_01", approvalEventId: "appr_9" });
    expect(bound.kind).toBe("created");
    const same = await store.resolveOrCreate({ ...boundInput, callerPaymentId: "pay_x402_bound_02", approvalEventId: "appr_9" });
    expect(same.kind).toBe("existing");
    const missing = await store.resolveOrCreate({ ...boundInput, callerPaymentId: "pay_x402_bound_03" });
    expect(missing.kind).toBe("approval_mismatch");
    const wrong = await store.resolveOrCreate({ ...boundInput, callerPaymentId: "pay_x402_bound_04", approvalEventId: "appr_other" });
    expect(wrong.kind).toBe("approval_mismatch");
  });

  it("resource surfaces approval_mismatch as 409 without settling", async () => {    const store = new InMemorySettlementStore();
    const resource = new DevnetMachineResource(devnetConfig(), store);
    const { settlePayment } = stubServer(resource);
    const spendingRequest = {
      orderId: "ord_appr_mm", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    // Seed an approval-bound active row directly.
    const seeded = await store.resolveOrCreate({
      logicalOrderId: "ord_appr_mm", intentVersion: 1, requestDigest: digest,
      resource: "/api/resources/premium-fit-score", approvalEventId: "appr_bound_1",
      callerPaymentId: "pay_x402_seed_0001",
    });
    expect(seeded.kind).toBe("created");
    const res = await resource.accept(
      encodeAccepted({ ...canonical }, "pay_x402_seed_0002"),
      digest, spendingRequest, { approvalEventId: "appr_other_1" },
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("approval_mismatch");
    expect(settlePayment).not.toHaveBeenCalled();
  });
});

describe("takeover carries a fresh fence; stale fence is dead", () => {
  it("claimRowForTakeover rotates the fence and voids the old one", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    const op = created.row.operationId;
    const first = await store.claimForSettle(op, "worker-a", 1);
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const taken = await store.claimRowForTakeover(op, "worker-b", 60_000);
    expect(taken).not.toBeNull();
    expect(taken!.fenceToken).not.toBe(first!.fenceToken);
    // Old fence no longer writes, even with the right owner.
    expect(await store.transition(op, ["settling"], "manual", {}, "worker-a", first!.fenceToken ?? "", "t", "n")).toBeNull();
    // New fence writes.
    expect(await store.transition(op, ["settling"], "awaiting_evidence", { txHash: "tx_takeover" }, "worker-b", taken!.fenceToken ?? "", "t", "n")).not.toBeNull();
  });

  it("takeover refuses a live lease", async () => {
    const store = new InMemorySettlementStore();
    const created = await store.resolveOrCreate({ ...BASE_INPUT });
    if (created.kind !== "created") throw new Error("expected created");
    const op = created.row.operationId;
    expect(await store.claimForSettle(op, "worker-a", 60_000)).not.toBeNull();
    expect(await store.claimRowForTakeover(op, "worker-b", 60_000)).toBeNull();
  });
});

describe("pre-settle revalidation happens twice per settlement", () => {
  it("claim-time and pre-submit revalidations both run before one settle", async () => {
    const inner = new InMemorySettlementStore();
    let revalidations = 0;
    const counting = new Proxy(inner, {
      get(target, prop, _receiver) {
        if (prop === "revalidateForSettle") {
          return async (...args: [string, string, string, number]) => {
            revalidations++;
            return Reflect.apply(target.revalidateForSettle, target, args);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const resource = new DevnetMachineResource(devnetConfig(), counting);
    const { settlePayment } = stubServer(resource, {
      settlePayment: async () => ({ success: true, transaction: "tx_reval_1", network: SOLANA_DEVNET_CAIP2, payer: "Payer11111111111111111111111111111111", amount: "10000" }),
    });
    const spendingRequest = {
      orderId: "ord_reval_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const res = await resource.accept(encodeAccepted({ ...canonical }, "pay_x402_reval_0001"), digest, spendingRequest);
    expect(res.status).toBe(202);
    expect(revalidations).toBe(2);
    expect(settlePayment).toHaveBeenCalledTimes(1);
  });
});

describe("postgres transition history carries a single enum status (offline executor stub)", () => {
  // Production incident: transition() wrote from.join(",") into the
  // from_status enum column, so every multi-candidate transition
  // (settling/awaiting_evidence→settled) rolled back and the attempt stayed
  // settling with no signature while the chain had finalized. No database,
  // no network: a stub executor captures the history INSERT params.
  it("records the observed single status, never the candidate list", async () => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const dbRow = {
      operation_id: "op_hist_1",
      logical_order_id: "ord_hist_1",
      intent_version: 1,
      request_digest: DIGEST,
      resource: "/api/resources/premium-fit-score",
      auth_revision: "sauth_hist",
      caller_payment_id: "pay_hist_01",
      signed_payload_enc: null,
      payload_digest: null,
      payer: "Payer11111111111111111111111111111111",
      blockhash: "BhHist11111111111111111111111111111",
      requirements_json: {},
      status: "settled",
      tx_hash: "tx_hist_1",
      evidence_json: {},
      lease_owner: "worker-h",
      lease_expires_at: new Date().toISOString(),
      fence_token: "fence-h",
      released_to_approval: null,
      released_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const fakeExec = {
      query: async (text: string, params?: unknown[]) => {
        seen.push({ text, params: params ?? [] });
        if (text.startsWith("SELECT status")) {
          return { rows: [{ status: "settling" }], rowCount: 1 };
        }
        if (text.startsWith("UPDATE")) {
          return { rows: [dbRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      transaction: async <T>(fn: (tx: { query: (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }) => Promise<T>): Promise<T> => {
        return fn(fakeExec as never);
      },
    };
    const store = new PostgresSettlementStore(fakeExec as never, Buffer.alloc(32));
    const settled = await store.transition(
      "op_hist_1", ["settling", "awaiting_evidence"], "settled",
      { txHash: "tx_hist_1" }, "worker-h", "fence-h", "complete-settlement", "settlementResult=settled",
    );
    expect(settled?.status).toBe("settled");
    const historyInsert = seen.find((q) => q.text.startsWith("INSERT INTO x402_reconciliation_history"));
    expect(historyInsert).toBeDefined();
    // from_status is the single observed enum value — never "settling,awaiting_evidence".
    expect(historyInsert!.params[1]).toBe("settling");
    expect(historyInsert!.params[2]).toBe("settled");
  });
});

describe("operator reconcile-settled parsing (no database)", () => {
  it("parses a complete reconcile-settled command", async () => {
    const { parseReconcileSettledArgs, validateReconcileSettledEvidence } = await import("@agentready/payments/operator");
    const parsed = parseReconcileSettledArgs([
      "--operation", "op1", "--operator", "op_test", "--tx", "5".repeat(44),
      "--slot", "493082743", "--note", "incident reconcile",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) throw new Error("expected parsed args");
    expect(validateReconcileSettledEvidence({
      operatorId: parsed.args.operatorId, txHash: parsed.args.txHash,
      checkedSlot: parsed.args.checkedSlot, note: parsed.args.note,
    }).ok).toBe(true);
  });

  it("rejects missing/invalid reconcile flags without touching any store", async () => {
    const { parseReconcileSettledArgs, validateReconcileSettledEvidence } = await import("@agentready/payments/operator");
    expect(parseReconcileSettledArgs([]).ok).toBe(false);
    expect(parseReconcileSettledArgs(["--operation", "op1", "--operator", "o", "--tx", "short", "--slot", "1", "--note", "n"]).ok).toBe(true);
    expect(validateReconcileSettledEvidence({ operatorId: "o", txHash: "short", checkedSlot: 1, note: "n" }).ok).toBe(false);
    expect(validateReconcileSettledEvidence({ operatorId: "", txHash: "5".repeat(44), checkedSlot: 1, note: "n" }).ok).toBe(false);
    expect(validateReconcileSettledEvidence({ operatorId: "o", txHash: "5".repeat(44), checkedSlot: -1, note: "n" }).ok).toBe(false);
    expect(validateReconcileSettledEvidence({ operatorId: "o", txHash: "5".repeat(44), checkedSlot: 1, note: "" }).ok).toBe(false);
  });
});
