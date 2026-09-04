import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { NextRequest } from "next/server";
import { POST as premiumFitScorePost } from "../app/api/resources/premium-fit-score/route";
import { getServices } from "../lib/services";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";
import {
  SOLANA_DEVNET_CAIP2,
  buildDevnetToolSpendRequest,
  buildPaymentRequired,
  encodeHeader,
  formatX402Amount,
  isMemoValid,
  memoForEnvelope,
  parsePaymentRequired,
  parsePaymentResponse,
  canonicalToolSpendRequestDigest,
  buildCanonicalRequirements,
  verifyCanonicalRequirements,
  adaptSettlement,
  memoVerificationLabel,
  type PaymentSignaturePayload,
  type SettlementResponse,
  type ToolSpendRequest,
  type CanonicalPaymentRequirements,
} from "@agentready/payments";
import { loadX402Config, type X402Config, type X402DevnetConfig, type X402MockConfig } from "@agentready/payments/x402-config";
import { DevnetMachineResource } from "@agentready/payments/devnet-machine";
import { InMemorySettlementStore } from "@agentready/payments/x402-settlement-store";
import { DEFAULT_MACHINE_SPEND, DemoMachineResource, runDevnetMachineSpend, runMachineSpend, signAsAgent } from "../lib/machine";

const HASH = "a".repeat(64);
const TEST_PAYMENT_ID = "pay_test_identifier_01";

function encodeDevnetPayment(
  accepted: unknown,
  paymentIdentifier = TEST_PAYMENT_ID,
  payer = "TestPayerPubKey1111111111111111111111111111",
): string {
  const extensions = appendPaymentIdentifierToExtensions(
    { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    paymentIdentifier,
  );
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted,
    payload: { payer },
    extensions,
  })).toString("base64url");
}

function signFor(payload: Partial<PaymentSignaturePayload> = {}): string {
  return signAsAgent({
    scheme: "exact",
    network: DEFAULT_MACHINE_SPEND.network,
    paymentIdentifier: "pid_test_1",
    paymentPayload: {
      transaction: "tx_signed_mock_pid_test_1",
      payer: DEFAULT_MACHINE_SPEND.agentWallet,
      amount: "0.010000",
      memo: memoForEnvelope(HASH),
    },
    ...payload,
  });
}

describe("x402 configuration", () => {
  it("loads mock config by default", () => {
    const config = loadX402Config({});
    expect(config.mode).toBe("mock");
    if (config.mode === "mock") {
      expect(config.payeeWallet).toBe("demo_payee_RunVista_mock");
      expect(config.agentWallet).toBe("demo_agent_wallet_mock");
      expect(config.amountMinor).toBe(10000);
    }
  });

  it("loads mock config when X402_MODE=mock", () => {
    const config = loadX402Config({ X402_MODE: "mock" });
    expect(config.mode).toBe("mock");
  });

  it("rejects invalid X402_MODE values", () => {
    expect(() => loadX402Config({ X402_MODE: "invalid" })).toThrow("X402_MODE must be one of");
    expect(() => loadX402Config({ X402_MODE: "LIVE" })).toThrow("X402_MODE must be one of");
    expect(() => loadX402Config({ X402_MODE: "production" })).toThrow("X402_MODE must be one of");
  });

  it("rejects devnet mode without payer keypair path", () => {
    expect(() => loadX402Config({
      X402_MODE: "devnet",
      X402_PAYEE_PUBLIC_KEY: "TestPayeePubKey1111111111111111111111111111",
    })).toThrow("X402_PAYER_KEYPAIR_PATH is required");
  });

  it("rejects devnet mode without payee public key", () => {
    expect(() => loadX402Config({
      X402_MODE: "devnet",
      X402_PAYER_KEYPAIR_PATH: "/nonexistent/path.json",
    })).toThrow("X402_PAYEE_PUBLIC_KEY is required");
  });

  it("rejects devnet mode with placeholder payee key", () => {
    expect(() => loadX402Config({
      X402_MODE: "devnet",
      X402_PAYER_KEYPAIR_PATH: "/nonexistent/path.json",
      X402_PAYEE_PUBLIC_KEY: "PLACEHOLDER_PAYEE_PUBLIC_KEY",
    })).toThrow("X402_PAYEE_PUBLIC_KEY is required");
  });

  it("rejects invalid X402_AMOUNT_MINOR", () => {
    expect(() => loadX402Config({
      X402_AMOUNT_MINOR: "not-a-number",
    })).toThrow("positive integer");
  });

  it("rejects negative X402_AMOUNT_MINOR", () => {
    expect(() => loadX402Config({
      X402_AMOUNT_MINOR: "-100",
    })).toThrow("positive integer");
  });

  it("does not expose keypair path in error messages", () => {
    try {
      loadX402Config({
        X402_MODE: "devnet",
        X402_PAYER_KEYPAIR_PATH: "/secret/path/keypair.json",
        X402_PAYEE_PUBLIC_KEY: "TestPayeePubKey1111111111111111111111111111",
      });
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).not.toContain("/secret/path/keypair.json");
    }
  });
});

describe("x402 protocol helpers", () => {
  it("memoForEnvelope produces correct format", () => {
    expect(memoForEnvelope(HASH)).toBe(`agentcart:v1:${HASH}`);
    expect(memoForEnvelope("abc123")).toBe("agentcart:v1:abc123");
  });

  it("isMemoValid checks exact match", () => {
    expect(isMemoValid("agentcart:v1:abc", "agentcart:v1:abc")).toBe(true);
    expect(isMemoValid("agentcart:v1:abc", "agentcart:v1:def")).toBe(false);
    expect(isMemoValid(undefined, "agentcart:v1:abc")).toBe(false);
    expect(isMemoValid("", "agentcart:v1:abc")).toBe(false);
  });

  it("formatX402Amount converts minor to decimal string", () => {
    expect(formatX402Amount(10000)).toBe("0.010000");
    expect(formatX402Amount(1)).toBe("0.000001");
    expect(formatX402Amount(1000000)).toBe("1.000000");
  });

  it("buildPaymentRequired and parsePaymentRequired round-trip", () => {
    const options = [{
      scheme: "exact" as const,
      network: SOLANA_DEVNET_CAIP2,
      asset: "USDC",
      amount: "0.010000",
      payee: "TestPayee",
      timeout: new Date().toISOString(),
    }];
    const header = buildPaymentRequired("test-resource", options);
    const parsed = parsePaymentRequired(header);
    expect(parsed.resource).toBe("test-resource");
    expect(parsed.options[0]!.network).toBe(SOLANA_DEVNET_CAIP2);
  });

  it("encodes and decodes header base64url correctly", () => {
    const data = { test: "value", nested: { key: 123 } };
    const encoded = encodeHeader(data);
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(decoded).toEqual(data);
  });
});

describe("canonical blockhash validity (offline)", () => {
  const BLOCKHASH = "11111111111111111111111111111111";

  async function signedEnvelopeWithTx(txBase64: string, paymentId = "pay_test_blockhash_01"): Promise<string> {
    return Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact" },
      payload: { transaction: txBase64, payer: "Payer11111111111111111111111111111111" },
      extensions: appendPaymentIdentifierToExtensions(
        { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
        paymentId,
      ),
    })).toString("base64url");
  }

  async function realLegacyTxBytes(): Promise<string> {
    const kit = await import("@solana/kit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let message: any = kit.createTransactionMessage({ version: "legacy" });
    message = kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(kit.address("11111111111111111111111111111111")), message);
    message = kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 1000n }, message);
    message = kit.appendTransactionMessageInstruction(
      { programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new Uint8Array([1, 2, 3]) },
      message,
    );
    const compiled = kit.compileTransactionMessage(message);
    const messageBytes = kit.getCompiledTransactionMessageEncoder().encode(compiled);
    const wire = new Uint8Array(1 + 64 + messageBytes.length);
    wire[0] = 1; // one (dummy) signature; structural decode only
    wire.set(messageBytes, 1 + 64);
    return Buffer.from(wire).toString("base64");
  }

  it("extracts the recent blockhash from a real compiled transaction", async () => {
    const { extractTransactionBlockhash } = await import("@agentready/payments");
    const encoded = await signedEnvelopeWithTx(await realLegacyTxBytes());
    expect(await extractTransactionBlockhash(encoded)).toBe(BLOCKHASH);
  });

  it("returns null for malformed envelopes instead of guessing", async () => {
    const { extractTransactionBlockhash } = await import("@agentready/payments");
    expect(await extractTransactionBlockhash("!!!not-base64url!!!")).toBeNull();
    expect(await extractTransactionBlockhash(Buffer.from(JSON.stringify({ nope: 1 })).toString("base64url"))).toBeNull();
    expect(await extractTransactionBlockhash(
      Buffer.from(JSON.stringify({ payload: { transaction: Buffer.from("junk").toString("base64") } })).toString("base64url"),
    )).toBeNull();
  });

  it("isBlockhashValid false means expired; anything else fails closed", async () => {
    const { checkBlockhashExpired } = await import("@agentready/payments");
    const stub = (body: unknown, status = 200) =>
      (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch;
    expect(await checkBlockhashExpired("http://rpc.test", BLOCKHASH, stub({ result: { value: false, context: { slot: 999 } } })))
      .toEqual({ expired: true, slot: 999, blockhash: BLOCKHASH });
    expect((await checkBlockhashExpired("http://rpc.test", BLOCKHASH, stub({ result: { value: true, context: { slot: 1 } } }))).expired).toBe(false);
    expect((await checkBlockhashExpired("http://rpc.test", BLOCKHASH, stub({ result: {} }))).expired).toBe(false);
    expect((await checkBlockhashExpired("http://rpc.test", BLOCKHASH, stub({}, 500))).expired).toBe(false);
    expect((await checkBlockhashExpired("http://rpc.test", BLOCKHASH, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).expired).toBe(false);
  });

  it("staged blockhash binds the release: full resource path", async () => {
    const { DevnetMachineResource: Res } = await import("@agentready/payments/devnet-machine");
    const { InMemorySettlementStore: MemStore } = await import("@agentready/payments/x402-settlement-store");
    const store = new MemStore();
    const resource = new Res({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "Payer11111111111111111111111111111111",
      payeePublicKey: "Payee11111111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    }, store);
    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      verifyPayment: vi.fn().mockResolvedValue({ isValid: true, payer: "Payer11111111111111111111111111111111" }),
      settlePayment: vi.fn().mockRejectedValue(Object.assign(new Error("down"), { transactionHash: "tx_bh_stub" })),
    };
    (resource as unknown as { initialized: boolean }).initialized = true;
    const spendingRequest = {
      orderId: "ord_blockhash_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "Payee11111111111111111111111111111111", purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const wireTx = await realLegacyTxBytes();
    const rebased = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: { ...canonical },
      payload: { transaction: wireTx, payer: "Payer11111111111111111111111111111111" },
      extensions: appendPaymentIdentifierToExtensions(
        { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
        "pay_test_blockhash_02",
      ),
    })).toString("base64url");
    const first = await resource.accept(rebased, digest, spendingRequest);
    expect(first.status).toBe(202);
    const row = await store.findByDigestPayment(digest, "pay_test_blockhash_02");
    expect(row?.blockhash).toBe(BLOCKHASH);
    // Release with a mismatched blockhash is refused even with a valid verdict shape.
    const wrong = await store.releaseAttempt(row!.operationId, {
      operatorId: "op", newApprovalEventId: "appr_1", note: "n",
      blockhash: "Bh00000000000000000000000000000000", blockhashValid: false, checkedSlot: 1,
      transferVerification: "unavailable",
    });
    expect(wrong.ok).toBe(false);
    // Release with the bound, expired blockhash succeeds.
    await store.transition(row!.operationId, ["awaiting_evidence"], "manual", {}, null, null, "t", "n");
    const released = await store.releaseAttempt(row!.operationId, {
      operatorId: "op", newApprovalEventId: "appr_1", note: "n",
      blockhash: BLOCKHASH, blockhashValid: false, checkedSlot: 1,
      transferVerification: "unavailable",
    });
    expect(released.ok).toBe(true);
  });
});

describe("request digest model (ToolSpendRequest)", () => {
  const spendingRequest: ToolSpendRequest = {
    orderId: "ord_123",
    intentVersion: 2,
    resource: "/api/resources/premium-fit-score",
    amountMinor: 10000,
    network: SOLANA_DEVNET_CAIP2,
    asset: "USDC",
    payee: "TestPayeePubKey1111111111111111111111111111",
    purpose: "fit_scoring",
  };

  it("produces a deterministic SHA-256 digest", () => {
    const digest1 = canonicalToolSpendRequestDigest(spendingRequest);
    const digest2 = canonicalToolSpendRequestDigest(spendingRequest);
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64);
  });

  it("different requests produce different digests", () => {
    const digest1 = canonicalToolSpendRequestDigest(spendingRequest);
    const digest2 = canonicalToolSpendRequestDigest({ ...spendingRequest, intentVersion: 3 });
    expect(digest1).not.toBe(digest2);
  });

  it("order matters in canonical JSON", () => {
    const digest1 = canonicalToolSpendRequestDigest(spendingRequest);
    const digest2 = canonicalToolSpendRequestDigest({ ...spendingRequest, purpose: "different" });
    expect(digest1).not.toBe(digest2);
  });
});

describe("canonical payment requirements", () => {
  const mockConfig: X402DevnetConfig = {
    mode: "devnet",
    facilitatorUrl: "https://x402.org/facilitator",
    payerSecretKey: new Uint8Array(32),
    payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
    payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
    devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amountMinor: 10000,
  };

  it("builds canonical requirements from config and digest", () => {
    const req = buildCanonicalRequirements(mockConfig, HASH);
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(req.asset).toBe(mockConfig.devnetUsdcMint);
    expect(req.amount).toBe("10000");
    expect(req.payTo).toBe(mockConfig.payeePublicKey);
    expect(req.extra.memo).toBe(memoForEnvelope(HASH));
  });

  it("uses the configured USDC mint as asset", () => {
    const req = buildCanonicalRequirements(mockConfig, HASH);
    expect(req.asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("uses atomic amount string not decimal", () => {
    const req = buildCanonicalRequirements(mockConfig, HASH);
    expect(req.amount).toBe("10000");
    expect(req.amount).not.toContain(".");
  });

  it("verifies correct requirements", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({
      scheme: canonical.scheme,
      network: canonical.network,
      asset: canonical.asset,
      amount: canonical.amount,
      payTo: canonical.payTo,
      memo: canonical.extra.memo,
    }, canonical);
    expect(errors).toHaveLength(0);
  });

  it("rejects wrong scheme", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, scheme: "wrong" as "exact" }, canonical);
    expect(errors.some((e) => e.includes("scheme"))).toBe(true);
  });

  it("rejects wrong network", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, network: "solana:mainnet" }, canonical);
    expect(errors.some((e) => e.includes("network"))).toBe(true);
  });

  it("rejects wrong asset", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, asset: "SOL" }, canonical);
    expect(errors.some((e) => e.includes("asset"))).toBe(true);
  });

  it("rejects wrong payee", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, payTo: "WrongPayee111111111111111111111111111" }, canonical);
    expect(errors.some((e) => e.includes("payee"))).toBe(true);
  });

  it("rejects wrong memo", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, memo: "agentcart:v1:wrong" }, canonical);
    expect(errors.some((e) => e.includes("memo"))).toBe(true);
  });

  it("rejects underpayment using BigInt comparison", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, amount: "1000" }, canonical);
    expect(errors.some((e) => e.includes("underpayment"))).toBe(true);
  });

  it("accepts exact amount", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, memo: canonical.extra.memo, amount: "10000" }, canonical);
    expect(errors).toHaveLength(0);
  });

  it("accepts overpayment", () => {
    const canonical = buildCanonicalRequirements(mockConfig, HASH);
    const errors = verifyCanonicalRequirements({ ...canonical, memo: canonical.extra.memo, amount: "20000" }, canonical);
    expect(errors).toHaveLength(0);
  });
});

describe("settlement adaptation", () => {
  it("adapts a successful settlement response", () => {
    const adapted = adaptSettlement(
      { success: true, transaction: "tx_sig_123", network: SOLANA_DEVNET_CAIP2, payer: "PayerKey123", amount: "0.010000" },
      { payee: "PayeeKey456", asset: "USDC", facilitatorUrl: "https://x402.org/facilitator", paymentIdentifier: "pid_1" },
    );
    expect(adapted.success).toBe(true);
    expect(adapted.transactionHash).toBe("tx_sig_123");
    expect(adapted.payer).toBe("PayerKey123");
    expect(adapted.payee).toBe("PayeeKey456");
    expect(adapted.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(adapted.asset).toBe("USDC");
  });

  it("adapts a failed settlement response", () => {
    const adapted = adaptSettlement(
      { success: false, transaction: "tx_pending_123", errorReason: "settlement_pending", payer: "PayerKey123", amount: "10000" },
      { payee: "PayeeKey456", asset: "USDC", facilitatorUrl: "https://x402.org/facilitator", paymentIdentifier: "pid_1" },
    );
    expect(adapted.success).toBe(false);
    expect(adapted.transactionHash).toBe("tx_pending_123");
    expect(adapted.payer).toBe("PayerKey123");
  });

  it("throws when success is true but no transaction signature", () => {
    expect(() => adaptSettlement(
      { success: true, payer: "PayerKey123" },
      { payee: "PayeeKey456", asset: "USDC", facilitatorUrl: "https://x402.org/facilitator", paymentIdentifier: "pid_1" },
    )).toThrow("no transaction signature");
  });

  it("throws when success is true but no payer", () => {
    expect(() => adaptSettlement(
      { success: true, transaction: "tx_sig_123" },
      { payee: "PayeeKey456", asset: "USDC", facilitatorUrl: "https://x402.org/facilitator", paymentIdentifier: "pid_1" },
    )).toThrow("no payer");
  });
});

describe("memo verification states", () => {
  it("verified label is correct", () => {
    expect(memoVerificationLabel("verified")).toBe("on-chain memo verified");
  });

  it("missing label is correct", () => {
    expect(memoVerificationLabel("missing")).toContain("memo instruction not found");
  });

  it("unavailable label is correct", () => {
    expect(memoVerificationLabel("unavailable")).toContain("unavailable");
  });
});

describe("DemoMachineResource 402 flow (preserved mock)", () => {
  it("advertises exact USDC devnet payment in PAYMENT-REQUIRED", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const header = resource.quote(HASH);
    const required = parsePaymentRequired(header);
    expect(required.resource).toBe("RunVista Premium Fit-Scoring API");
    const option = required.options[0]!;
    expect(option.scheme).toBe("exact");
    expect(option.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(option.asset).toBe("USDC");
    expect(option.amount).toBe("0.010000");
    expect(option.extra?.memo).toBe(`agentcart:v1:${HASH}`);
    expect(option.paymentIdentifier?.required).toBe(true);
  });

  it("rejects a request without payment and issues 402", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept("", HASH);
    expect(response.status).toBe(402);
    expect(response.headers["PAYMENT-REQUIRED"]).toBeDefined();
  });

  it("accepts a correctly signed payment and returns the resource", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor(), HASH);
    expect(response.status).toBe(200);
    const settlement = parsePaymentResponse(response.headers["PAYMENT-RESPONSE"]!);
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe(DEFAULT_MACHINE_SPEND.network);
    expect(settlement.paymentIdentifier).toBe("pid_test_1");
    expect(settlement.transactionHash).toContain("tx_mock_");
    const body = response.body as { scores: Array<{ productId: string; fitScore: number }> };
    expect(body.scores).toHaveLength(6);
    expect(body.scores.find((s) => s.productId === "p_vista_max")!.fitScore).toBe(95);
  });

  it("rejects underpayment", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.001000", memo: memoForEnvelope(HASH) } }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("underpayment");
  });

  it("rejects a memo that does not anchor the request digest", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.010000", memo: memoForEnvelope("b".repeat(64)) } }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("memo mismatch");
  });

  it("rejects the wrong network", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ network: "solana:mainnet-other" }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("wrong network");
  });

  it("rejects the wrong payee", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.010000", payee: "wrong_payee", memo: memoForEnvelope(HASH) } }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("wrong recipient");
  });

  it("replays the same payment identifier without a second charge", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const first = resource.accept(signFor(), HASH);
    expect(first.status).toBe(200);
    const second = resource.accept(signFor(), HASH);
    expect(second.status).toBe(200);
    const secondBody = second.body as { note: string };
    expect(secondBody.note).toContain("no second charge");
    expect(resource.hasProcessed("pid_test_1")).toBe(true);
  });

  it("rejects a malformed payment signature", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept("not-valid-base64url!!!", HASH);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("malformed_payment_signature");
  });
});

describe("runMachineSpend (mock)", () => {
  it("completes the full 402 handshake and returns settlement + resource", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const outcome = runMachineSpend(resource, HASH, "pid_flow_1");
    expect(outcome.ok).toBe(true);
    expect(outcome.settlement?.success).toBe(true);
    expect(outcome.settlement?.transactionHash).toBe("tx_mock_pid_flow_1");
    expect(outcome.resource?.scores[0]).toBeDefined();
    expect(outcome.mock).toBe(true);
  });

  it("uses the intent digest as the memo anchor", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const required = parsePaymentRequired(resource.quote(HASH));
    expect(required.options[0]!.extra?.memo).toBe(memoForEnvelope(HASH));
    expect(required.options[0]!.extra?.memo).toContain("agentcart:v1:");
  });

  it("builds a well-formed PAYMENT-REQUIRED from the protocol helper", () => {
    const header = buildPaymentRequired("res", [
      {
        scheme: "exact",
        network: DEFAULT_MACHINE_SPEND.network,
        asset: "USDC",
        amount: "0.010000",
        payee: DEFAULT_MACHINE_SPEND.payeeWallet,
        timeout: new Date().toISOString(),
      },
    ]);
    const parsed = parsePaymentRequired(header);
    expect(parsed.resource).toBe("res");
  });
});

describe("x402 mode labelling", () => {
  it("mock mode returns mock=true", () => {
    const config = loadX402Config({ X402_MODE: "mock" });
    expect(config.mode).toBe("mock");
    if (config.mode === "mock") {
      expect(config.payeeWallet).toBeDefined();
    }
  });

  it("SOLANA_DEVNET_CAIP2 matches official network identifier", () => {
    expect(SOLANA_DEVNET_CAIP2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
});

describe("x402 envelope/memo binding", () => {
  it("memo includes envelope hash prefix", () => {
    const envelopeHash = "deadbeef".repeat(8);
    const memo = memoForEnvelope(envelopeHash);
    expect(memo).toBe(`agentcart:v1:${envelopeHash}`);
    expect(memo.length).toBeLessThanOrEqual(256);
  });

  it("different envelope hashes produce different memos", () => {
    const memo1 = memoForEnvelope("a".repeat(64));
    const memo2 = memoForEnvelope("b".repeat(64));
    expect(memo1).not.toBe(memo2);
  });

  it("resource advertises memo in payment requirements extra field", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const header = resource.quote(HASH);
    const required = parsePaymentRequired(header);
    expect(required.options[0]!.extra?.memo).toBe(memoForEnvelope(HASH));
  });

  it("resource validates memo on acceptance", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const wrongMemoSign = signAsAgent({
      scheme: "exact",
      network: DEFAULT_MACHINE_SPEND.network,
      paymentIdentifier: "pid_wrong_memo",
      paymentPayload: {
        transaction: "tx",
        payer: DEFAULT_MACHINE_SPEND.agentWallet,
        amount: "0.010000",
        memo: memoForEnvelope("wrong_hash"),
      },
    });
    const response = resource.accept(wrongMemoSign, HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("memo mismatch");
  });
});

describe("x402 replay protection", () => {
  it("same paymentIdentifier returns cached result, no second charge", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const first = resource.accept(signFor(), HASH);
    expect(first.status).toBe(200);
    expect(resource.hasProcessed("pid_test_1")).toBe(true);

    const second = resource.accept(signFor(), HASH);
    expect(second.status).toBe(200);
    const body = second.body as { note: string };
    expect(body.note).toContain("no second charge");
  });

  it("different paymentIdentifiers are processed independently", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const first = resource.accept(signFor({ paymentIdentifier: "pid_a" } as Partial<PaymentSignaturePayload>), HASH);
    expect(first.status).toBe(200);

    const second = resource.accept(signFor({ paymentIdentifier: "pid_b" } as Partial<PaymentSignaturePayload>), HASH);
    expect(second.status).toBe(200);

    expect(resource.hasProcessed("pid_a")).toBe(true);
    expect(resource.hasProcessed("pid_b")).toBe(true);
  });
});

describe("x402 failure modes (mock)", () => {
  it("wrong scheme is rejected", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signAsAgent({
      scheme: "wrong" as "exact",
      network: DEFAULT_MACHINE_SPEND.network,
      paymentIdentifier: "pid_bad",
      paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.010000", memo: memoForEnvelope(HASH) },
    }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("scheme must be exact");
  });

  it("malformed base64url signature returns 400", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept("!!!invalid-base64!!!", HASH);
    expect(response.status).toBe(400);
  });

  it("empty payment signature triggers 402 with PAYMENT-REQUIRED", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept("", HASH);
    expect(response.status).toBe(402);
    expect(response.headers["PAYMENT-REQUIRED"]).toBeDefined();
  });
});

describe("DevnetMachineResource (mocked facilitator)", () => {
  const FACILITATOR_URL = "https://x402.org/facilitator";

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${FACILITATOR_URL}/supported`) {
        return new Response(JSON.stringify({
          kinds: [{
            x402Version: 2,
            scheme: "exact",
            network: SOLANA_DEVNET_CAIP2,
            extra: { feePayer: "TestFeePayer111111111111111111111111111111" },
          }],
          extensions: [],
          signers: { solana: ["TestFeePayer111111111111111111111111111111"] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Offline test attempted unexpected outbound request: ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createDevnetResource(): DevnetMachineResource {
    return new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: FACILITATOR_URL,
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
      payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    },
      new InMemorySettlementStore(),
    );
  }

  const spendingRequest: ToolSpendRequest = {
    orderId: "ord_devnet_1",
    intentVersion: 1,
    resource: "/api/resources/premium-fit-score",
    amountMinor: 10000,
    network: SOLANA_DEVNET_CAIP2,
    asset: "USDC",
    payee: "TestPayeePubKey1111111111111111111111111111",
    purpose: "fit_scoring",
  };

  it("is not mock", () => {
    const resource = createDevnetResource();
    expect(resource.mock).toBe(false);
  });

  it("initializes and handles repeated initialization safely", async () => {
    const resource = createDevnetResource();
    let initCount = 0;
    const mockInitialize = vi.fn().mockImplementation(async () => { initCount++; });
    (resource as unknown as { resourceServer: { initialize: () => Promise<void> } }).resourceServer = {
      initialize: mockInitialize,
      register: vi.fn().mockReturnThis(),
    } as never;
    await resource.ensureInitialized();
    await resource.ensureInitialized();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("builds request digest from ToolSpendRequest", () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    expect(digest).toHaveLength(64);
    expect(digest).toBe(canonicalToolSpendRequestDigest(spendingRequest));
  });

  it("returns 402 without payment signature", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const response = await resource.accept("", digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(response.headers["PAYMENT-REQUIRED"]).toBeDefined();
  });

  it("rejects malformed payment signature", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const response = await resource.accept("!!!bad!!!", digest, spendingRequest);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("malformed_payment_signature");
  });

  it("rejects payment without accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const encoded = Buffer.from(JSON.stringify({ payload: {} })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("missing_accepted_requirements");
  });

  it("rejects wrong network in accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = Buffer.from(JSON.stringify({
      accepted: { ...canonical, network: "solana:mainnet" },
      payload: { payer: "test" },
    })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("wrong network");
  });

  it("rejects wrong asset in accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = Buffer.from(JSON.stringify({
      accepted: { ...canonical, asset: "SOL" },
      payload: { payer: "test" },
    })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("wrong asset");
  });

  it("rejects wrong payee in accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = Buffer.from(JSON.stringify({
      accepted: { ...canonical, payTo: "WrongPayee111111111111111111111111111" },
      payload: { payer: "test" },
    })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("payee");
  });

  it("rejects underpayment in accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = Buffer.from(JSON.stringify({
      accepted: { ...canonical, amount: "1000" },
      payload: { payer: "test" },
    })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("underpayment");
  });

  it("rejects wrong memo in accepted requirements", async () => {
    const resource = createDevnetResource();
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = Buffer.from(JSON.stringify({
      accepted: { ...canonical, extra: { memo: "agentcart:v1:wrong" } },
      payload: { payer: "test" },
    })).toString("base64url");
    const response = await resource.accept(encoded, digest, spendingRequest);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("memo mismatch");
  });

  it("resets processed state", async () => {
    const resource = createDevnetResource();
    expect(await resource.hasProcessed("pid_test", "digest_test")).toBe(false);
    await resource.reset();
    expect(await resource.hasProcessed("pid_test", "digest_test")).toBe(false);
  });

  it("returns payer public key", () => {
    const resource = createDevnetResource();
    expect(resource.payerPublicKey()).toBe("TestPayerPubKey1111111111111111111111111111");
  });
});

describe("DevnetMachineResource concurrent duplicate protection", () => {
  it("two concurrent identical requests invoke settle once via pending map", async () => {
    const resource = new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
      payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    },
      new InMemorySettlementStore(),
    );

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_concurrent_1",
      intentVersion: 1,
      resource: "/api/resources/premium-fit-score",
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "TestPayeePubKey1111111111111111111111111111",
      purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);

    const canonical = resource.getCanonicalRequirements(digest);
    const acceptedForPayload = {
      scheme: canonical.scheme,
      network: canonical.network,
      asset: canonical.asset,
      amount: canonical.amount,
      payTo: canonical.payTo,
      maxTimeoutSeconds: canonical.maxTimeoutSeconds,
      extra: canonical.extra,
    };
    const encoded = encodeDevnetPayment(acceptedForPayload, "pay_test_concurrent_01");

    let settleCount = 0;
    let settleResolve!: (value: { success: boolean; transaction: string; network: string; payer: string; amount: string }) => void;
    const settleBlocker = new Promise<{ success: boolean; transaction: string; network: string; payer: string; amount: string }>((resolve) => { settleResolve = resolve; });

    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockReturnThis(),
      buildPaymentRequirements: vi.fn().mockResolvedValue({}),
      createPaymentRequiredResponse: vi.fn().mockResolvedValue({}),
      verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
      settlePayment: vi.fn().mockImplementation(async () => {
        settleCount++;
        return settleBlocker;
      }),
    };

    (resource as unknown as { initialized: boolean }).initialized = true;

    const p1 = resource.accept(encoded, digest, spendingRequest);
    const p2 = resource.accept(encoded, digest, spendingRequest);

    settleResolve({ success: true, transaction: "tx_concurrent_1", network: SOLANA_DEVNET_CAIP2, payer: "TestPayerPubKey1111111111111111111111111111", amount: "10000" });

    const [result1, result2] = await Promise.all([p1, p2]);

    expect(result1.status).toBe(202);
    expect(result2.status).toBe(202);
    expect(settleCount).toBe(1);
  });

  it("same paymentIdentifier with different digest returns 409 conflict", async () => {
    const resource = new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
      payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    },
      new InMemorySettlementStore(),
    );

    const spendingRequestA: ToolSpendRequest = {
      orderId: "ord_conflict_1",
      intentVersion: 1,
      resource: "/api/resources/premium-fit-score",
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: "TestPayeePubKey1111111111111111111111111111",
      purpose: "fit_scoring",
    };
    const spendingRequestB: ToolSpendRequest = {
      ...spendingRequestA,
      purpose: "different_purpose",
    };

    const digestA = resource.buildRequestDigest(spendingRequestA);
    const digestB = resource.buildRequestDigest(spendingRequestB);

    const canonical = resource.getCanonicalRequirements(digestA);
    const makeEncoded = (accepted: Record<string, unknown>) => encodeDevnetPayment(accepted, "pay_test_conflict_01");

    let settleResolve!: (value: { success: boolean; transaction: string; network: string; payer: string; amount: string }) => void;
    const settleBlocker = new Promise<{ success: boolean; transaction: string; network: string; payer: string; amount: string }>((resolve) => { settleResolve = resolve; });

    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockReturnThis(),
      buildPaymentRequirements: vi.fn().mockResolvedValue({}),
      createPaymentRequiredResponse: vi.fn().mockResolvedValue({}),
      verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
      settlePayment: vi.fn().mockImplementation(async () => settleBlocker),
    };
    (resource as unknown as { initialized: boolean }).initialized = true;

    const p1 = resource.accept(makeEncoded(canonical), digestA, spendingRequestA);

    settleResolve({ success: true, transaction: "tx_conflict_1", network: SOLANA_DEVNET_CAIP2, payer: "TestPayerPubKey1111111111111111111111111111", amount: "10000" });

    const result1 = await p1;
    expect(result1.status).toBe(202);

    const canonicalB = resource.getCanonicalRequirements(digestB);
    const result2 = await resource.accept(makeEncoded(canonicalB), digestB, spendingRequestB);
    expect(result2.status).toBe(409);
    expect(JSON.stringify(result2.body)).toContain("idempotency_conflict");
  });
});

describe("Solana parsed-memo fixtures", () => {
  const MOCK_RPC_URL = "http://localhost:9999/rpc";
  const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

  function makeDevnetResourceWithRpc(rpcUrl: string | undefined): DevnetMachineResource {
    return new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
      payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
      solanaRpcUrl: rpcUrl,
    },
      new InMemorySettlementStore(),
    );
  }

  it("returns 'verified' when memo is in top-level instructions with valid Memo program", async () => {
    const resource = makeDevnetResourceWithRpc(MOCK_RPC_URL);
    const expectedMemo = "agentcart:v1:abc123";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      json: async () => ({
        result: {
          transaction: {
            message: {
              instructions: [
                { parsed: expectedMemo, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                { parsed: { type: "transfer", info: {} }, program: "system", programId: "11111111111111111111111111111111" },
              ],
            },
          },
          meta: { innerInstructions: [] },
        },
      }),
    } as Response);

    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", expectedMemo);
    expect(result).toBe("verified");
    fetchSpy.mockRestore();
  });

  it("returns 'verified' when memo is in inner instructions with valid Memo program", async () => {
    const resource = makeDevnetResourceWithRpc(MOCK_RPC_URL);
    const expectedMemo = "agentcart:v1:def456";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      json: async () => ({
        result: {
          transaction: {
            message: {
              instructions: [
                { parsed: { type: "transfer", info: {} }, program: "system", programId: "11111111111111111111111111111111" },
              ],
            },
          },
          meta: {
            innerInstructions: [
              {
                instructions: [
                  { parsed: expectedMemo, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                ],
              },
            ],
          },
        },
      }),
    } as Response);

    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", expectedMemo);
    expect(result).toBe("verified");
    fetchSpy.mockRestore();
  });

  it("returns 'missing' when no memo instruction matches expected memo", async () => {
    const resource = makeDevnetResourceWithRpc(MOCK_RPC_URL);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      json: async () => ({
        result: {
          transaction: {
            message: {
              instructions: [
                { parsed: "agentcart:v1:other", program: "spl-memo", programId: MEMO_PROGRAM_ID },
              ],
            },
          },
          meta: { innerInstructions: [] },
        },
      }),
    } as Response);

    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", "agentcart:v1:expected");
    expect(result).toBe("missing");
    fetchSpy.mockRestore();
  });

  it("returns 'unavailable' when RPC URL is not configured", async () => {
    const resource = makeDevnetResourceWithRpc(undefined);
    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", "memo");
    expect(result).toBe("unavailable");
  });

  it("returns 'unavailable' when RPC call throws", async () => {
    const resource = makeDevnetResourceWithRpc(MOCK_RPC_URL);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", "memo");
    expect(result).toBe("unavailable");
    fetchSpy.mockRestore();
  });

  it("returns 'unavailable' when result is null", async () => {
    const resource = makeDevnetResourceWithRpc(MOCK_RPC_URL);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      json: async () => ({ result: null }),
    } as Response);

    const result = await (resource as unknown as { verifyMemo: (sig: string, memo: string) => Promise<string> }).verifyMemo("tx_sig", "memo");
    expect(result).toBe("unavailable");
    fetchSpy.mockRestore();
  });
});

describe("atomic amount formatting", () => {
  it("formatX402Amount produces decimal USDC from atomic units", () => {
    expect(formatX402Amount(10000)).toBe("0.010000");
    expect(formatX402Amount(1)).toBe("0.000001");
    expect(formatX402Amount(1000000)).toBe("1.000000");
    expect(formatX402Amount(1500000)).toBe("1.500000");
  });

  it("canonical requirements use atomic amount string", () => {
    const config: X402DevnetConfig = {
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: "TestPayerPubKey1111111111111111111111111111",
      payeePublicKey: "TestPayeePubKey1111111111111111111111111111",
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    };
    const req = buildCanonicalRequirements(config, HASH);
    expect(req.amount).toBe("10000");
    expect(req.amount).not.toContain(".");
    expect(req.asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("adapted settlement preserves atomic amount", () => {
    const adapted = adaptSettlement(
      { success: true, transaction: "tx_1", network: SOLANA_DEVNET_CAIP2, payer: "payer1", amount: "10000" },
      { payee: "payee1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", facilitatorUrl: "https://x402.org/facilitator", paymentIdentifier: "pid_1" },
    );
    expect(adapted.amount).toBe("10000");
    expect(adapted.asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });
});

describe("Devnet resource orchestration with mocked server adapters", () => {
  const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const PAYER_KEY = "IntegrationPayerKey111111111111111111111111";
  const PAYEE_KEY = "IntegrationPayeeKey111111111111111111111111";
  const FEE_PAYER_KEY = "IntegrationFeePayerKey111111111111111111111";

  function createIntegratedResource(): DevnetMachineResource {
    return new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: PAYER_KEY,
      payeePublicKey: PAYEE_KEY,
      devnetUsdcMint: USDC_MINT,
      amountMinor: 10000,
      solanaRpcUrl: "http://localhost:9999/rpc",
    },
      new InMemorySettlementStore(),
    );
  }

  function mockResourceServer(resource: DevnetMachineResource, overrides: {
    verifyPayment?: () => Promise<{ isValid: boolean; payer?: string }>;
    settlePayment?: () => Promise<{ success: boolean; transaction?: string; network?: string; payer?: string; amount?: string }>;
  } = {}) {
    const verifyFn = overrides.verifyPayment ?? vi.fn().mockResolvedValue({ isValid: true, payer: PAYER_KEY });
    const settleFn = overrides.settlePayment ?? vi.fn().mockResolvedValue({
      success: true, transaction: "tx_integration_1", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000",
    });
    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockReturnThis(),
      buildPaymentRequirements: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
        const price = params.price as { amount: string; asset: string };
        return [{
          scheme: "exact",
          payTo: PAYEE_KEY,
          amount: price.amount,
          asset: price.asset,
          network: SOLANA_DEVNET_CAIP2,
          maxTimeoutSeconds: 300,
          extra: { ...(params.extra as Record<string, unknown>), feePayer: FEE_PAYER_KEY },
        }];
      }),
      createPaymentRequiredResponse: vi.fn().mockImplementation(async (reqs: Array<Record<string, unknown>>, meta: unknown) => {
        const req = reqs[0]!;
        return {
          x402Version: 2,
          accepts: [{
            scheme: req.scheme,
            network: req.network,
            asset: req.asset,
            amount: req.amount,
            payTo: req.payTo,
            maxTimeoutSeconds: req.maxTimeoutSeconds,
            extra: req.extra,
          }],
          resource: meta,
        };
      }),
      verifyPayment: verifyFn,
      settlePayment: settleFn,
    };
    (resource as unknown as { initialized: boolean }).initialized = true;
    return { verifyFn, settleFn };
  }

  function mockRpcForMemo(expectedMemo: string, options: {
    transfer?: Partial<{ mint: string; amount: string; recipient: string; payer: string }> | null;
    metaErr?: unknown;
  } = {}) {
    const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    const transfer = options.transfer === null ? null : {
      mint: options.transfer?.mint ?? USDC_MINT,
      amount: options.transfer?.amount ?? "10000",
      recipient: options.transfer?.recipient ?? PAYEE_KEY,
      payer: options.transfer?.payer ?? PAYER_KEY,
    };
    const instructions: Array<Record<string, unknown>> = [
      { parsed: expectedMemo, program: "spl-memo", programId: MEMO_PROGRAM_ID },
    ];
    if (transfer) {
      instructions.push({
        parsed: {
          type: "transferChecked",
          info: {
            mint: transfer.mint,
            destination: transfer.recipient,
            authority: transfer.payer,
            tokenAmount: { amount: transfer.amount },
          },
        },
        program: "spl-token",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      });
    }
    return vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr === "http://localhost:9999/rpc") {
        return {
          json: async () => ({
            result: {
              transaction: {
                message: {
                  instructions,
                },
              },
              meta: { err: options.metaErr ?? null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
            },
          }),
        } as Response;
      }
      return { json: async () => ({}) } as Response;
    }) as typeof fetch);
  }

  it("same SDK-enriched requirements reach signing, verification, and settlement with feePayer", async () => {
    const resource = createIntegratedResource();
    const { verifyFn, settleFn } = mockResourceServer(resource);

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_integration_1",
      intentVersion: 1,
      resource: "/api/resources/premium-fit-score",
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_MINT,
      payee: PAYEE_KEY,
      purpose: "fit_scoring",
    };

    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);

    const quoteHeader = await resource.quote(digest);
    const quote = JSON.parse(Buffer.from(quoteHeader, "base64url").toString("utf8"));
    const officialAccept = quote.accepts[0];

    expect(officialAccept.asset).toBe(USDC_MINT);
    expect(officialAccept.amount).toBe("10000");
    expect(officialAccept.payTo).toBe(PAYEE_KEY);
    expect(officialAccept.extra.memo).toBe(`agentcart:v1:${digest}`);

    const rpcSpy = mockRpcForMemo(canonical.extra.memo);

    const encoded = encodeDevnetPayment(officialAccept, "pay_test_integration_01");

    const result = await resource.accept(encoded, digest, spendingRequest);
    expect(result.status).toBe(200);

    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(settleFn).toHaveBeenCalledTimes(1);

    const verifyArgs = (verifyFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const settleArgs = (settleFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(verifyArgs[1].asset).toBe(USDC_MINT);
    expect(verifyArgs[1].amount).toBe("10000");
    expect(verifyArgs[1].payTo).toBe(PAYEE_KEY);
    expect(verifyArgs[1].extra.memo).toContain("agentcart:v1:");
    expect(verifyArgs[1].extra.feePayer).toBe(FEE_PAYER_KEY);
    expect(settleArgs[1].asset).toBe(USDC_MINT);
    expect(settleArgs[1].amount).toBe("10000");
    expect(settleArgs[1].payTo).toBe(PAYEE_KEY);
    expect(settleArgs[1].extra.feePayer).toBe(FEE_PAYER_KEY);

    const body = result.body as Record<string, unknown>;
    expect(body.settlementEvidence).toBeDefined();
    const evidence = body.settlementEvidence as Record<string, unknown>;
    expect(evidence.transactionHash).toBe("tx_integration_1");
    expect(evidence.memoVerification).toBe("verified");
    expect(evidence.payer).toBe(PAYER_KEY);
    expect(evidence.payee).toBe(PAYEE_KEY);
    expect(evidence.feePayer).toBe(FEE_PAYER_KEY);
    expect(evidence.paymentIdentifier).toBe("pay_test_integration_01");
    expect(evidence.requestDigest).toBe(digest);
    expect(evidence.transferVerification).toBe("verified");
    expect(evidence.transfer).toEqual({
      mint: USDC_MINT,
      amount: "10000",
      recipient: PAYEE_KEY,
      payer: PAYER_KEY,
    });

    rpcSpy.mockRestore();
  });

  it("keeps the operation reserved until deferred evidence enrichment completes", async () => {
    const resource = createIntegratedResource();
    const { settleFn } = mockResourceServer(resource);
    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_deferred_evidence", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_deferred_evidence");

    let resolveRpc!: (response: Response) => void;
    const deferredRpc = new Promise<Response>((resolve) => { resolveRpc = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => deferredRpc);

    const firstPromise = resource.accept(encoded, digest, spendingRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(settleFn).toHaveBeenCalledTimes(1);

    const retryPromise = resource.accept(encoded, digest, spendingRequest);
    await Promise.resolve();
    expect(settleFn).toHaveBeenCalledTimes(1);

    resolveRpc(new Response(JSON.stringify({
      result: {
        transaction: {
          message: {
            instructions: [
              { parsed: canonical.extra.memo, program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" },
              {
                parsed: {
                  type: "transferChecked",
                  info: { mint: USDC_MINT, destination: PAYEE_KEY, authority: PAYER_KEY, tokenAmount: { amount: "10000" } },
                },
                program: "spl-token",
                programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              },
            ],
          },
        },
        meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const [first, retry] = await Promise.all([firstPromise, retryPromise]);
    expect(first.status).toBe(200);
    // A concurrent joiner must NOT piggyback the in-flight promise (that only
    // works single-process): it gets 202 and converges on retry. One settle.
    expect(retry.status).toBe(202);
    expect((retry.body as Record<string, unknown>).reconciliationState).toBe("pending");
    expect(settleFn).toHaveBeenCalledTimes(1);

    const converged = await resource.accept(encoded, digest, spendingRequest);
    expect(converged.status).toBe(200);
    expect(settleFn).toHaveBeenCalledTimes(1);
    expect((first.body as Record<string, unknown>).settlementEvidence).toEqual(
      (converged.body as Record<string, unknown>).settlementEvidence,
    );

    fetchSpy.mockRestore();
  });

  it("reconciles temporarily unavailable evidence without a second settlement", async () => {
    const resource = createIntegratedResource();
    const { settleFn } = mockResourceServer(resource);
    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_unavailable_evidence", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_unavailable_evidence");
    let rpcCalls = 0;
    const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      rpcCalls += 1;
      if (rpcCalls === 1) return { json: async () => ({ result: null }) } as Response;
      return {
        json: async () => ({
          result: {
            transaction: {
              message: {
                instructions: [
                  { parsed: canonical.extra.memo, program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" },
                  {
                    parsed: {
                      type: "transferChecked",
                      info: { mint: USDC_MINT, destination: PAYEE_KEY, authority: PAYER_KEY, tokenAmount: { amount: "10000" } },
                    },
                    program: "spl-token",
                    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                  },
                ],
              },
            },
            meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
          },
        }),
      } as Response;
    });

    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    expect((first.body as Record<string, unknown>).reconciliationState).toBe("pending");
    expect((first.body as Record<string, unknown>).retryable).toBe(true);
    expect((first.body as Record<string, unknown>).transactionHash).toBe("tx_integration_1");

    const retry = await resource.accept(encoded, digest, spendingRequest);
    expect(retry.status).toBe(200);
    expect((retry.body as Record<string, unknown>).settlementEvidence).toMatchObject({
      transactionHash: "tx_integration_1",
      settlementResult: "reconciled",
      memoVerification: "verified",
      transferVerification: "verified",
    });
    expect(rpcCalls).toBe(2);
    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it("server computes canonical digest and rejects caller-supplied mismatching digest", async () => {
    const resource = createIntegratedResource();
    mockResourceServer(resource);

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_digest_mismatch",
      intentVersion: 1,
      resource: "/api/resources/premium-fit-score",
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_MINT,
      payee: PAYEE_KEY,
      purpose: "fit_scoring",
    };

    const serverDigest = resource.buildRequestDigest(spendingRequest);
    const attackerDigest = "b".repeat(64);

    expect(serverDigest).not.toBe(attackerDigest);

    const canonical = resource.getCanonicalRequirements(serverDigest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_digest_01");

    const result = await resource.accept(encoded, attackerDigest, spendingRequest);
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("request_digest_mismatch");
  });

  it("success requires HTTP 200 and complete transaction evidence", async () => {
    const resource = createIntegratedResource();
    mockResourceServer(resource);
    const rpcSpy = mockRpcForMemo(`agentcart:v1:${resource.buildRequestDigest({
      orderId: "ord_evidence", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    })}`);

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_evidence", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);

    const encoded = encodeDevnetPayment(canonical, "pay_test_evidence_01");

    const result = await resource.accept(encoded, digest, spendingRequest);
    expect(result.status).toBe(200);

    const evidence = (result.body as Record<string, unknown>).settlementEvidence as Record<string, unknown>;
    expect(evidence.paymentIdentifier).toBeTruthy();
    expect(evidence.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(evidence.asset).toBe(USDC_MINT);
    expect(evidence.amount).toBe("10000");
    expect(evidence.payer).toBe(PAYER_KEY);
    expect(evidence.payee).toBe(PAYEE_KEY);
    expect(evidence.transactionHash).toBe("tx_integration_1");
    expect(evidence.requestDigest).toBe(digest);
    expect(evidence.verificationResult).toBe("verified");
    expect(evidence.settlementResult).toBe("settled");
    expect(evidence.memoVerification).toBe("verified");
    expect(evidence.transferVerification).toBe("verified");
    expect(evidence.transfer).toEqual({ mint: USDC_MINT, amount: "10000", recipient: PAYEE_KEY, payer: PAYER_KEY });
    expect(evidence.explorerUrl).toContain("https://explorer.solana.com/tx/tx_integration_1?cluster=devnet");
    expect(evidence.timestamp).toBeTruthy();

    rpcSpy.mockRestore();
  });

  it("uses the canonical atomic amount when the facilitator omits settlement.amount", async () => {
    const resource = createIntegratedResource();
    const settleFn = vi.fn().mockResolvedValue({
      success: true, transaction: "tx_omitted_amount", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY,
    });
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_omitted_amount", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const rpcSpy = mockRpcForMemo(canonical.extra.memo);

    const result = await resource.accept(
      encodeDevnetPayment(canonical, "pay_test_omitted_amount"),
      digest,
      spendingRequest,
    );

    expect(result.status).toBe(200);
    const evidence = (result.body as Record<string, unknown>).settlementEvidence as Record<string, unknown>;
    expect(evidence.amount).toBe("10000");
    const response = parsePaymentResponse(result.headers["PAYMENT-RESPONSE"]!);
    expect(response.amount).toBe("10000");
    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it("retains a transport-uncertain attempt and never resubmits it", async () => {
    const resource = createIntegratedResource();
    const transportError = Object.assign(new Error("facilitator timeout"), { transactionHash: "tx_transport_uncertain" });
    const settleFn = vi.fn().mockRejectedValue(transportError);
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_transport_uncertain", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_transport_uncertain");
    const rpcSpy = mockRpcForMemo(canonical.extra.memo);

    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    expect(JSON.stringify(first.body)).toContain("tx_transport_uncertain");
    expect((first.body as Record<string, unknown>).reconciliationState).toBe("pending");
    expect((first.body as Record<string, unknown>).retryable).toBe(true);

    const retry = await resource.accept(encoded, digest, spendingRequest);
    expect(retry.status).toBe(200);
    expect((retry.body as Record<string, unknown>).settlementEvidence).toMatchObject({
      transactionHash: "tx_transport_uncertain",
      settlementResult: "reconciled",
    });
    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it("retains an incomplete settlement response and never resubmits it", async () => {
    const resource = createIntegratedResource();
    const settleFn = vi.fn().mockResolvedValue({
      success: true, transaction: "", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000",
    });
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_incomplete_settlement", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_incomplete_settlement");

    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    expect((first.body as Record<string, unknown>).reconciliationState).toBe("manual_reconciliation_required");
    expect((first.body as Record<string, unknown>).retryable).toBe(false);
    expect(JSON.stringify(first.body)).toContain("no discovery path");

    const retry = await resource.accept(encoded, digest, spendingRequest);
    expect(retry.status).toBe(202);
    expect((retry.body as Record<string, unknown>).reconciliationState).toBe("manual_reconciliation_required");
    expect((retry.body as Record<string, unknown>).retryable).toBe(false);
    expect(settleFn).toHaveBeenCalledTimes(1);
  });

  it("cached replay preserves evidence and rejects altered/invalid payment proof", async () => {
    const resource = createIntegratedResource();
    mockResourceServer(resource);
    const rpcSpy = mockRpcForMemo(`agentcart:v1:${resource.buildRequestDigest({
      orderId: "ord_replay", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    })}`);

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_replay", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);

    const validEncoded = encodeDevnetPayment(canonical, "pay_test_replay_01");

    const first = await resource.accept(validEncoded, digest, spendingRequest);
    expect(first.status).toBe(200);
    const firstEvidence = (first.body as Record<string, unknown>).settlementEvidence as Record<string, unknown>;
    expect(firstEvidence.memoVerification).toBe("verified");
    expect(firstEvidence.transferVerification).toBe("verified");

    const second = await resource.accept(validEncoded, digest, spendingRequest);
    expect(second.status).toBe(200);
    const secondBody = second.body as Record<string, unknown>;
    expect(secondBody.note).toContain("no second charge");
    expect(secondBody.settlementEvidence).toEqual(firstEvidence);

    const alteredCanonical = { ...canonical, asset: "WRONG_ASSET" };
    const alteredEncoded = encodeDevnetPayment(alteredCanonical, "pay_test_replay_01");
    const alteredResult = await resource.accept(alteredEncoded, digest, spendingRequest);
    expect(alteredResult.status).toBe(402);
    expect(JSON.stringify(alteredResult.body)).toContain("wrong asset");

    rpcSpy.mockRestore();
  });

  it("binds a cached payment identifier to the original signed payload owner", async () => {
    const resource = createIntegratedResource();
    const { settleFn } = mockResourceServer(resource);
    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_owner_replay", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const paymentId = "pay_test_owner_replay";
    const rpcSpy = mockRpcForMemo(`agentcart:v1:${digest}`);

    const first = await resource.accept(encodeDevnetPayment(canonical, paymentId, PAYER_KEY), digest, spendingRequest);
    expect(first.status).toBe(200);

    const replay = await resource.accept(encodeDevnetPayment(canonical, paymentId, "DifferentPayerKey111111111111111111111111"), digest, spendingRequest);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.body)).toContain("payment_ownership_conflict");
    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it("reconciles the original ambiguous transaction without a second payment", async () => {
    const resource = createIntegratedResource();
    const settleFn = vi.fn()
      .mockResolvedValueOnce({
        success: false, transaction: "tx_ambiguous_original", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000",
      });
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_ambiguous", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);

    const rpcSpy = mockRpcForMemo(`agentcart:v1:${digest}`);

    const encoded = encodeDevnetPayment(canonical, "pay_test_ambiguous_01");

    const firstResult = await resource.accept(encoded, digest, spendingRequest);
    expect(firstResult.status).toBe(202);
    expect(JSON.stringify(firstResult.body)).toContain("settlement_ambiguous");

    const secondResult = await resource.accept(encoded, digest, spendingRequest);
    expect(secondResult.status).toBe(200);

    const body = secondResult.body as Record<string, unknown>;
    const evidence = body.settlementEvidence as Record<string, unknown>;
    expect(evidence.transactionHash).toBe("tx_ambiguous_original");
    expect(evidence.payer).toBe(PAYER_KEY);
    expect(evidence.settlementResult).toBe("reconciled");
    expect(evidence.memoVerification).toBe("verified");
    expect(evidence.transferVerification).toBe("verified");
    expect(evidence.transfer).toEqual({ mint: USDC_MINT, amount: "10000", recipient: PAYEE_KEY, payer: PAYER_KEY });

    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it.each([
    ["failed execution", { metaErr: { InstructionError: [0, "Custom"] } }],
    ["mismatched mint", { transfer: { mint: "WrongMint111111111111111111111111111111111" } }],
    ["mismatched amount", { transfer: { amount: "9999" } }],
    ["mismatched recipient", { transfer: { recipient: "OtherPayee111111111111111111111111111111" } }],
    ["mismatched payer", { transfer: { payer: "OtherPayer1111111111111111111111111111111" } }],
    ["memo-only evidence", { transfer: null }],
  ] as const)("rejects reconciliation with %s", async (_label, rpcOptions) => {
    const resource = createIntegratedResource();
    const settleFn = vi.fn().mockResolvedValue({
      success: false, transaction: "tx_reconcile_mismatch", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000",
    });
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequest: ToolSpendRequest = {
      orderId: `ord_reconcile_${_label.replaceAll(" ", "_")}`, intentVersion: 1,
      resource: "/api/resources/premium-fit-score", amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const rpcSpy = mockRpcForMemo(canonical.extra.memo, rpcOptions);

    const first = await resource.accept(
      encodeDevnetPayment(canonical, `pay_test_mismatch_${_label.replaceAll(" ", "_")}`),
      digest,
      spendingRequest,
    );
    expect(first.status).toBe(202);

    const retry = await resource.accept(
      encodeDevnetPayment(canonical, `pay_test_mismatch_${_label.replaceAll(" ", "_")}`),
      digest,
      spendingRequest,
    );
    expect(retry.status).toBe(502);
    expect(JSON.stringify(retry.body)).toContain("settlement_transaction_mismatch");
    expect(settleFn).toHaveBeenCalledTimes(1);

    rpcSpy.mockRestore();
  });

  it("concurrent same-ID/different-digest requests cannot both settle", async () => {
    const resource = createIntegratedResource();
    let settleResolve!: (value: { success: boolean; transaction: string; network: string; payer: string; amount: string }) => void;
    const settleBlocker = new Promise<{ success: boolean; transaction: string; network: string; payer: string; amount: string }>((resolve) => { settleResolve = resolve; });
    const settleFn = vi.fn().mockImplementation(async () => settleBlocker);
    mockResourceServer(resource, { settlePayment: settleFn });

    const spendingRequestA: ToolSpendRequest = {
      orderId: "ord_concurrent_diff", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const spendingRequestB: ToolSpendRequest = { ...spendingRequestA, purpose: "different_purpose" };
    const digestA = resource.buildRequestDigest(spendingRequestA);
    const digestB = resource.buildRequestDigest(spendingRequestB);
    const canonicalA = resource.getCanonicalRequirements(digestA);
    const canonicalB = resource.getCanonicalRequirements(digestB);

    const encodedA = encodeDevnetPayment(canonicalA, "pay_test_concurrent_diff");
    const encodedB = encodeDevnetPayment(canonicalB, "pay_test_concurrent_diff");

    const p1 = resource.accept(encodedA, digestA, spendingRequestA);
    const p2 = resource.accept(encodedB, digestB, spendingRequestB);

    settleResolve({ success: true, transaction: "tx_concurrent_diff_1", network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000" });

    const [result1, result2] = await Promise.all([p1, p2]);
    expect(result1.status).toBe(202);
    expect(result2.status).toBe(409);
    expect(JSON.stringify(result2.body)).toContain("idempotency_conflict");

    expect(settleFn).toHaveBeenCalledTimes(1);
  });
});

describe("application-driven Devnet payment", () => {
  const APP_ORIGIN = "http://app.test";
  const FACILITATOR_URL = "https://facilitator.test/x402";
  const RPC_URL = "https://solana.test/rpc";
  const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const BLOCKHASH = "11111111111111111111111111111111";
  const savedEnv = { ...process.env };
  let keypairDirectory: string | undefined;

  beforeEach(async () => {
    const payerSecretKey = new Uint8Array(32).fill(1);
    const feePayerSecretKey = new Uint8Array(32).fill(2);
    const payeeSecretKey = new Uint8Array(32).fill(3);
    const payer = await createKeyPairSignerFromPrivateKeyBytes(payerSecretKey);
    const feePayer = await createKeyPairSignerFromPrivateKeyBytes(feePayerSecretKey);
    const payee = await createKeyPairSignerFromPrivateKeyBytes(payeeSecretKey);

    keypairDirectory = await mkdtemp(join(tmpdir(), "agentready-x402-"));
    const keypairPath = join(keypairDirectory, "payer.json");
    await writeFile(keypairPath, JSON.stringify(Array.from(payerSecretKey)), "utf8");

    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      NODE_ENV: "test",
      RAZORPAY_KEY_ID: "rzp_test_mock",
      RAZORPAY_KEY_SECRET: "mock_secret",
      ENVELOPE_SIGNING_SECRET: "test-secret",
      NEXT_PUBLIC_APP_URL: APP_ORIGIN,
      X402_MODE: "devnet",
      X402_FACILITATOR_URL: FACILITATOR_URL,
      X402_SOLANA_RPC_URL: RPC_URL,
      X402_PAYER_KEYPAIR_PATH: keypairPath,
      X402_PAYEE_PUBLIC_KEY: payee.address,
      X402_DEVNET_USDC_MINT: USDC_MINT,
      X402_AMOUNT_MINOR: "10000",
    });

    const { getDevnetMachineResource, setDevnetMachineResourceForTests } = await import("../lib/machine");
    const { DevnetMachineResource: TestResource } = await import("@agentready/payments/devnet-machine");
    const { loadX402Config: loadTestConfig } = await import("@agentready/payments/x402-config");
    // In-memory store double: boot gates stay enforced for real factories,
    // while these hermetic tests inject settlement state explicitly.
    setDevnetMachineResourceForTests(
      new TestResource(loadTestConfig() as import("@agentready/payments/x402-config").X402DevnetConfig, new InMemorySettlementStore()),
    );
    const devnetResource = getDevnetMachineResource();
    await devnetResource.reset();
    void payer;
    void feePayer;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { setDevnetMachineResourceForTests } = await import("../lib/machine");
    setDevnetMachineResourceForTests(null);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    if (keypairDirectory) await rm(keypairDirectory, { recursive: true, force: true });
    keypairDirectory = undefined;
  });

  it("uses one trusted request and SDK requirement through service, client, and HTTP route with 50k compute", async () => {
    const payer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
    const feePayer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
    const payee = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(3));
    const payerAddress = payer.address.toString();
    const feePayerAddress = feePayer.address.toString();
    const payeeAddress = payee.address.toString();
    const routeRequests: Array<{ requestDigest?: string; spendingRequest?: ToolSpendRequest }> = [];
    const routeStatuses: number[] = [];
    const serverRequestDigests: string[] = [];
    const serverPaymentIdentifiers: string[] = [];
    const facilitatorPaymentIdentifiers: string[] = [];
    const signingFeePayers: string[] = [];
    const signingComputeLimits: number[] = [];
    const verificationRequirements: Array<Record<string, unknown>> = [];
    const settlementRequirements: Array<Record<string, unknown>> = [];
    const mintData = new Uint8Array(82);
    mintData[44] = 6;
    mintData[45] = 1;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === `${APP_ORIGIN}/api/resources/premium-fit-score`) {
        const body = typeof init?.body === "string" ? init.body : undefined;
        routeRequests.push(body ? JSON.parse(body) as { requestDigest?: string; spendingRequest?: ToolSpendRequest } : {});
        const routeResponse = await premiumFitScorePost(new NextRequest(url, {
          method,
          headers: init?.headers,
          body,
        }));
        const responseText = await routeResponse.text();
        routeStatuses.push(routeResponse.status);
        if (routeResponse.status === 200) {
          const responseBody = JSON.parse(responseText) as { settlementEvidence?: { requestDigest?: string; paymentIdentifier?: string } };
          if (responseBody.settlementEvidence?.requestDigest) {
            serverRequestDigests.push(responseBody.settlementEvidence.requestDigest);
          }
          if (responseBody.settlementEvidence?.paymentIdentifier) {
            serverPaymentIdentifiers.push(responseBody.settlementEvidence.paymentIdentifier);
          }
        }
        return new Response(responseText, {
          status: routeResponse.status,
          headers: routeResponse.headers,
        });
      }

      if (url === `${FACILITATOR_URL}/supported`) {
        return new Response(JSON.stringify({
          kinds: [{
            x402Version: 2,
            scheme: "exact",
            network: SOLANA_DEVNET_CAIP2,
            extra: { feePayer: feePayerAddress },
          }],
          extensions: [],
          signers: { solana: [feePayerAddress] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url === `${FACILITATOR_URL}/verify` || url === `${FACILITATOR_URL}/settle`) {
        const requestBody = JSON.parse(String(init?.body)) as {
          paymentPayload: {
            payload: { transaction: string };
            extensions?: Record<string, { info?: { id?: string } }>;
          };
          paymentRequirements: Record<string, unknown>;
        };
        const requirements = requestBody.paymentRequirements;
        const paymentIdentifier = requestBody.paymentPayload.extensions?.[PAYMENT_IDENTIFIER]?.info?.id;
        if (paymentIdentifier) facilitatorPaymentIdentifiers.push(paymentIdentifier);
        const transaction = getTransactionDecoder().decode(
          getBase64Encoder().encode(requestBody.paymentPayload.payload.transaction),
        );
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        signingFeePayers.push(String(compiled.staticAccounts[0]));
        for (const instruction of compiled.instructions) {
          const data = instruction.data;
          if (!data) continue;
          const [tag, byte0 = 0, byte1 = 0, byte2 = 0, byte3 = 0] = data;
          if (
            String(compiled.staticAccounts[instruction.programAddressIndex]) === "ComputeBudget111111111111111111111111111111"
            && tag === 2
          ) {
            signingComputeLimits.push(
              byte0
              | (byte1 << 8)
              | (byte2 << 16)
              | (byte3 << 24),
            );
          }
        }
        if (url.endsWith("/verify")) {
          verificationRequirements.push(requirements);
          return new Response(JSON.stringify({ isValid: true, payer: payerAddress }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        settlementRequirements.push(requirements);
        return new Response(JSON.stringify({
          success: true,
          transaction: "tx_application_devnet_1",
          network: SOLANA_DEVNET_CAIP2,
          payer: payerAddress,
          amount: requirements.amount,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url === RPC_URL) {
        const requestBody = JSON.parse(String(init?.body)) as { method: string };
        if (requestBody.method === "getAccountInfo") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: {
                data: [Buffer.from(mintData).toString("base64"), "base64"],
                executable: false,
                lamports: 1,
                owner: TOKEN_PROGRAM_ID,
                rentEpoch: 0,
              },
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (requestBody.method === "getLatestBlockhash") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (requestBody.method === "getTransaction") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              transaction: {
                message: {
                  instructions: [
                    { parsed: `agentcart:v1:${routeRequests[0]?.requestDigest}`, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                    {
                      parsed: {
                        type: "transferChecked",
                        info: {
                          mint: USDC_MINT,
                          destination: payeeAddress,
                          authority: payerAddress,
                          tokenAmount: { amount: "10000" },
                        },
                      },
                      program: "spl-token",
                      programId: TOKEN_PROGRAM_ID,
                    },
                  ],
                },
              },
              meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
      }

      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const services = getServices(process.env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    await services.respond(session.logicalOrderId, "I need black shoes under ₹5,000.");
    await services.respond(session.logicalOrderId, "UK 9");
    const result = await services.respond(session.logicalOrderId, "Road running up to 10K, wide fit");

    expect(result.kind).toBe("shortlist");
    if (result.kind !== "shortlist") throw new Error("Expected a shortlist result");
    expect(result.machineSpend).toBeDefined();
    expect(routeRequests).toHaveLength(1);
    expect(routeStatuses).toEqual([200]);
    const request = routeRequests[0]!;
    const storedSession = services.getSession(session.logicalOrderId);
    const requestDigest = canonicalToolSpendRequestDigest(request.spendingRequest!);
    expect(request.requestDigest).toBe(requestDigest);
    expect(serverRequestDigests).toEqual([requestDigest]);
    expect(serverPaymentIdentifiers).toHaveLength(1);
    expect(storedSession?.machineSpend?.requestDigest).toBe(requestDigest);
    expect(storedSession?.machineSpend?.settlementHash).toBe("tx_application_devnet_1");
    expect(storedSession?.machineSpend?.paymentIdentifier).toBe(serverPaymentIdentifiers[0]);
    expect(storedSession?.machineSpend?.memoVerification).toBe("verified");
    expect(storedSession?.machineSpend?.amount).toBe("10000");
    expect(storedSession?.machineSpend?.transferVerification).toBe("verified");
    expect(storedSession?.machineSpend?.transfer).toEqual({
      mint: USDC_MINT,
      amount: "10000",
      recipient: payeeAddress,
      payer: payerAddress,
    });
    expect(storedSession?.machineSpend?.feePayer).toBe(feePayerAddress);
    expect(request.spendingRequest).toMatchObject({
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_MINT,
      payee: payeeAddress,
      purpose: "fit_scoring",
    });
    expect(verificationRequirements[0]?.extra).toMatchObject({ feePayer: feePayerAddress });
    expect(settlementRequirements[0]?.extra).toMatchObject({ feePayer: feePayerAddress });
    expect(settlementRequirements[0]).toEqual(verificationRequirements[0]);
    expect(signingFeePayers).toEqual([feePayerAddress, feePayerAddress]);
    expect(signingComputeLimits).toEqual([50_000, 50_000]);
    expect(facilitatorPaymentIdentifiers).toEqual([serverPaymentIdentifiers[0], serverPaymentIdentifiers[0]]);
    expect((await services.timeline(session.logicalOrderId)).some((event) => event.type === "machine.paid_resource")).toBe(true);
    expect(payerAddress).not.toBe(feePayerAddress);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("audits an ambiguous route response when settled persistence fails", async () => {
    const { getDevnetMachineResource } = await import("../lib/machine");
    const resource = getDevnetMachineResource();
    const config = loadX402Config() as X402DevnetConfig;
    const settleFn = vi.fn().mockResolvedValue({
      success: true,
      transaction: "tx_route_persist_fail",
      network: SOLANA_DEVNET_CAIP2,
      payer: resource.payerPublicKey(),
      amount: "10000",
    });
    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      verifyPayment: vi.fn().mockResolvedValue({ isValid: true, payer: resource.payerPublicKey() }),
      settlePayment: settleFn,
    };
    (resource as unknown as { initialized: boolean }).initialized = true;

    const servicesGlobal = globalThis as typeof globalThis & {
      __agentreadyServices?: ReturnType<typeof getServices>;
    };
    const previousServices = servicesGlobal.__agentreadyServices;
    servicesGlobal.__agentreadyServices = undefined;

    try {
      const services = getServices(process.env, { forceMock: true });
      const session = services.createSession();
      const spendingRequest = buildDevnetToolSpendRequest(config, session.logicalOrderId, 1);
      const digest = resource.buildRequestDigest(spendingRequest);
      const canonical = resource.getCanonicalRequirements(digest);
      const paymentId = "pay_route_audit_01";
      const encoded = encodeDevnetPayment(canonical, paymentId, resource.payerPublicKey());
      const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url !== RPC_URL) throw new Error(`Unexpected offline audit-test request: ${url}`);
        return {
          json: async () => ({
            result: {
              transaction: {
                message: {
                  instructions: [
                    { parsed: canonical.extra.memo, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                    {
                      parsed: {
                        type: "transferChecked",
                        info: {
                          mint: config.devnetUsdcMint,
                          destination: config.payeePublicKey,
                          authority: resource.payerPublicKey(),
                          tokenAmount: { amount: "10000" },
                        },
                      },
                      program: "spl-token",
                      programId: TOKEN_PROGRAM_ID,
                    },
                  ],
                },
              },
              meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
            },
          }),
        } as Response;
      });
      const store = (resource as unknown as { store: InMemorySettlementStore }).store;
      const originalTransition = store.transition.bind(store);
      const transitionSpy = vi.spyOn(store, "transition").mockImplementation(async (...args) => {
        if (args[2] === "settled") throw new Error("persistence down (stub)");
        return originalTransition(...args);
      });

      const response = await premiumFitScorePost(new NextRequest(`${APP_ORIGIN}/api/resources/premium-fit-score`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": encoded,
        },
        body: JSON.stringify({ requestDigest: digest, spendingRequest }),
      }));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(202);
      expect(body.error).toBe("settlement_ambiguous");
      expect(body.transactionHash).toBe("tx_route_persist_fail");
      expect(settleFn).toHaveBeenCalledTimes(1);

      const pendingEvent = (await services.timeline(session.logicalOrderId))
        .find((event) => event.type === "machine.spend_pending");
      expect(pendingEvent).toBeDefined();
      expect(pendingEvent?.decision).toBe("review");
      expect(pendingEvent?.externalReferences).toMatchObject({
        paymentIdentifier: paymentId,
        requestDigest: digest,
        txHash: "tx_route_persist_fail",
        responseStatus: "202",
      });
      expect(JSON.stringify(pendingEvent)).not.toContain(encoded);

      transitionSpy.mockRestore();
      rpcSpy.mockRestore();
    } finally {
      servicesGlobal.__agentreadyServices = previousServices;
    }
  });

  it("persists and reconciles an ambiguous tool spend through getServices without resubmitting", async () => {
    const payer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
    const feePayer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
    const payee = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(3));
    const routeHeaders: string[] = [];
    const routeRequests: Array<{ requestDigest?: string; spendingRequest?: ToolSpendRequest }> = [];
    let routeCalls = 0;
    let settleCalls = 0;
    let requestDigest = "";
    const mintData = new Uint8Array(82);
    mintData[44] = 6;
    mintData[45] = 1;

    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const signingSpy = vi.spyOn(ExactSvmScheme.prototype, "createPaymentPayload");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === `${APP_ORIGIN}/api/resources/premium-fit-score`) {
        routeCalls++;
        const body = typeof init?.body === "string" ? init.body : undefined;
        const routeRequest = body ? JSON.parse(body) as { requestDigest?: string; spendingRequest?: ToolSpendRequest } : {};
        routeRequests.push(routeRequest);
        requestDigest = routeRequest.requestDigest ?? requestDigest;
        const paymentSignature = new Headers(init?.headers).get("PAYMENT-SIGNATURE") ?? "";
        routeHeaders.push(paymentSignature);
        const routeResponse = await premiumFitScorePost(new NextRequest(url, {
          method: init?.method ?? "POST",
          headers: init?.headers,
          body,
        }));
        const responseText = await routeResponse.text();
        return new Response(responseText, { status: routeResponse.status, headers: routeResponse.headers });
      }

      if (url === `${FACILITATOR_URL}/supported`) {
        return new Response(JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP2, extra: { feePayer: feePayer.address.toString() } }],
          extensions: [],
          signers: { solana: [feePayer.address.toString()] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url === `${FACILITATOR_URL}/verify`) {
        return new Response(JSON.stringify({ isValid: true, payer: payer.address.toString() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === `${FACILITATOR_URL}/settle`) {
        settleCalls++;
        return new Response(JSON.stringify({
          success: false,
          transaction: "tx_service_ambiguous",
          network: SOLANA_DEVNET_CAIP2,
          payer: payer.address.toString(),
          amount: "10000",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url === RPC_URL) {
        const rpcRequest = JSON.parse(String(init?.body)) as { method: string };
        if (rpcRequest.method === "getAccountInfo") {
          return new Response(JSON.stringify({
            result: {
              context: { slot: 1 },
              value: {
                data: [Buffer.from(mintData).toString("base64"), "base64"],
                executable: false,
                lamports: 1,
                owner: TOKEN_PROGRAM_ID,
                rentEpoch: 0,
              },
            },
          }), { status: 200 });
        }
        if (rpcRequest.method === "getLatestBlockhash") {
          return new Response(JSON.stringify({
            result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } },
          }), { status: 200 });
        }
        if (rpcRequest.method === "getTransaction") {
          return new Response(JSON.stringify({
            result: {
              transaction: {
                message: {
                  instructions: [
                    { parsed: `agentcart:v1:${requestDigest}`, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                    {
                      parsed: {
                        type: "transferChecked",
                        info: {
                          mint: USDC_MINT,
                          destination: payee.address.toString(),
                          authority: payer.address.toString(),
                          tokenAmount: { amount: "10000" },
                        },
                      },
                      program: "spl-token",
                      programId: TOKEN_PROGRAM_ID,
                    },
                  ],
                },
              },
              meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
            },
          }), { status: 200 });
        }
      }

      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const services = getServices(process.env, { forceMock: true, skipCache: true });
    const session = services.createSession();
    const orderId = session.logicalOrderId;
    await services.respond(orderId, "I need black shoes under ₹5,000.");
    await services.respond(orderId, "UK 9");

    const first = await services.respond(orderId, "Road running up to 10K, wide fit");
    expect(first.kind).toBe("shortlist");
    if (first.kind !== "shortlist") throw new Error("Expected a shortlist result");
    expect(first.machineSpend).toBeUndefined();
    expect(session.machineSpendAttempt?.status, session.machineSpendAttempt?.lastError).toBe("pending");

    const originalAttempt = session.machineSpendAttempt;
    expect(originalAttempt?.paymentIdentifier).toBeTruthy();
    expect(originalAttempt?.requestDigest).toBe(routeRequests[0]?.requestDigest);
    expect(originalAttempt?.signedAttempt).toBe(routeHeaders[0]);
    expect(first.machineSpendAttempt).toMatchObject({
      paymentIdentifier: originalAttempt?.paymentIdentifier,
      requestDigest: originalAttempt?.requestDigest,
      status: "pending",
      retryable: true,
    });

    const second = await services.respond(orderId, "Road running up to 10K, wide fit");
    expect(second.kind).toBe("shortlist");
    if (second.kind !== "shortlist") throw new Error("Expected a shortlist result");
    expect(second.machineSpend).toBeDefined();
    expect(session.machineSpendAttempt?.status).toBe("settled");
    expect(session.machineSpendAttempt?.paymentIdentifier).toBe(originalAttempt?.paymentIdentifier);
    expect(session.machineSpendAttempt?.requestDigest).toBe(originalAttempt?.requestDigest);
    expect(session.machineSpendAttempt?.signedAttempt).toBe(originalAttempt?.signedAttempt);
    expect(routeCalls).toBe(2);
    expect(routeHeaders[1]).toBe(routeHeaders[0]);
    expect(routeRequests[1]?.requestDigest).toBe(originalAttempt?.requestDigest);
    expect(routeRequests[1]?.spendingRequest).toEqual(routeRequests[0]?.spendingRequest);
    expect(signingSpy).toHaveBeenCalledTimes(1);
    expect(settleCalls).toBe(1);
    expect((await services.timeline(orderId)).some((event) => event.type === "machine.spend_failed")).toBe(false);

    fetchSpy.mockRestore();
    signingSpy.mockRestore();
  });

  it("reuses the original signed client attempt after an HTTP 202", async () => {
    const payer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
    const feePayer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
    const payee = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(3));
    const request: ToolSpendRequest = {
      orderId: "ord_client_retry", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT,
      payee: payee.address.toString(), purpose: "fit_scoring",
    };
    const paymentId = "pay_client_retry_01";
    const routeHeaders: string[] = [];
    let routeCalls = 0;
    const mintData = new Uint8Array(82);
    mintData[44] = 6;
    mintData[45] = 1;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${FACILITATOR_URL}/supported`) {
        return new Response(JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP2, extra: { feePayer: feePayer.address.toString() } }],
          extensions: [],
          signers: { solana: [feePayer.address.toString()] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === RPC_URL) {
        const rpcRequest = JSON.parse(String(init?.body)) as { method: string };
        if (rpcRequest.method === "getAccountInfo") {
          return new Response(JSON.stringify({ result: { context: { slot: 1 }, value: { data: [Buffer.from(mintData).toString("base64"), "base64"], executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 } } }), { status: 200 });
        }
        if (rpcRequest.method === "getLatestBlockhash") {
          return new Response(JSON.stringify({ result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } } }), { status: 200 });
        }
      }
      if (url === `${APP_ORIGIN}/api/resources/premium-fit-score`) {
        routeCalls++;
        routeHeaders.push(String(new Headers(init?.headers).get("PAYMENT-SIGNATURE")));
        if (routeCalls === 1) {
          return new Response(JSON.stringify({
            error: "settlement_ambiguous",
            paymentIdentifier: paymentId,
            reconciliationState: "pending",
            retryable: true,
          }), { status: 202 });
        }
        return new Response(JSON.stringify({
          resourceName: "RunVista Premium Fit-Scoring API",
          scoredAt: new Date().toISOString(),
          fit: "wide",
          scores: [],
          settlementEvidence: { paymentIdentifier: paymentId, transactionHash: "tx_client_retry", memoVerification: "verified", transferVerification: "verified" },
        }), {
          status: 200,
          headers: { "PAYMENT-RESPONSE": encodeHeader({ success: true, network: SOLANA_DEVNET_CAIP2, payer: payer.address.toString(), amount: "10000", transactionHash: "tx_client_retry", paymentIdentifier: paymentId }) },
        });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const first = await runDevnetMachineSpend(request, APP_ORIGIN, paymentId);
    expect(first.ok).toBe(false);
    expect(first.pending).toBe(true);
    expect(first.status).toBe(202);

    const second = await runDevnetMachineSpend(request, APP_ORIGIN, paymentId);
    expect(second.ok).toBe(true);
    expect(second.settlement?.amount).toBe("10000");
    expect(routeCalls).toBe(2);
    expect(routeHeaders[0]).toBe(routeHeaders[1]);

    fetchSpy.mockRestore();
  });
});

describe("env-gated live Devnet integration", () => {
  const runLive = process.env.X402_LIVE_DEVNET_TEST === "1"
    && process.env.X402_MODE === "devnet"
    && !!process.env.X402_PAYER_KEYPAIR_PATH
    && !!process.env.X402_PAYEE_PUBLIC_KEY
    && !!process.env.X402_SOLANA_RPC_URL;

  const describeOrSkip = runLive ? describe : describe.skip;

  describeOrSkip("real Devnet settlement (manual approval required)", () => {
    it("completes full x402 Devnet flow with real facilitator", async () => {
      const { loadX402Config: loadConfig } = await import("@agentready/payments/x402-config");
      const config = loadConfig();
      if (config.mode !== "devnet") throw new Error("Not in devnet mode");

      const { DevnetMachineResource: LiveResource } = await import("@agentready/payments/devnet-machine");
      const resource = new LiveResource(config, new InMemorySettlementStore());

      const spendingRequest: ToolSpendRequest = {
        orderId: `live_test_${Date.now()}`,
        intentVersion: 0,
        resource: "/api/resources/premium-fit-score",
        amountMinor: config.amountMinor,
        network: SOLANA_DEVNET_CAIP2,
        asset: config.devnetUsdcMint,
        payee: config.payeePublicKey,
        purpose: "fit_scoring",
      };

      const digest = resource.buildRequestDigest(spendingRequest);
      const canonical = resource.getCanonicalRequirements(digest);

      await resource.ensureInitialized();

      const quoteHeader = await resource.quote(digest);
      expect(quoteHeader).toBeTruthy();

      const quote = JSON.parse(Buffer.from(quoteHeader, "base64url").toString("utf8"));
      expect(quote.accepts).toBeDefined();
      expect(quote.accepts.length).toBeGreaterThan(0);
      expect(quote.accepts[0].asset).toBe(config.devnetUsdcMint);
      expect(quote.accepts[0].amount).toBe(String(config.amountMinor));
      const expectedFeePayer = quote.accepts[0].extra?.feePayer;
      expect(typeof expectedFeePayer).toBe("string");

      const { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const { ExactSvmScheme } = await import("@x402/svm/exact/client");

      const signer = config.payerSecretKey.length === 64
        ? await createKeyPairSignerFromBytes(config.payerSecretKey)
        : await createKeyPairSignerFromPrivateKeyBytes(config.payerSecretKey);
      const svmScheme = new ExactSvmScheme(signer, { rpcUrl: config.solanaRpcUrl });

      const paymentPayload = await svmScheme.createPaymentPayload(2, quote.accepts[0]);

      const encodedPayment = Buffer.from(JSON.stringify({
        x402Version: quote.x402Version ?? 2,
        resource: quote.resource,
        accepted: quote.accepts[0],
        payload: paymentPayload.payload,
        extensions: appendPaymentIdentifierToExtensions(
          { ...(quote.extensions ?? {}) },
          "pay_live_devnet_test",
        ),
      })).toString("base64url");

      const response = await resource.accept(encodedPayment, digest, spendingRequest);

      if (response.status !== 200) {
        throw new Error(`Live Devnet test failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      }

      const body = response.body as Record<string, unknown>;
      const evidence = body.settlementEvidence as Record<string, unknown> | undefined;
      expect(evidence).toBeDefined();
      expect(evidence?.transactionHash).toBeTruthy();
      expect(evidence?.settlementResult).toBe("settled");
      expect(evidence?.network).toBe(SOLANA_DEVNET_CAIP2);
      expect(evidence?.asset).toBe(config.devnetUsdcMint);
      expect(evidence?.amount).toBe(String(config.amountMinor));
      expect(evidence?.payer).toBe(config.payerPublicKey);
      expect(evidence?.payee).toBe(config.payeePublicKey);
      expect(evidence?.feePayer).toBe(expectedFeePayer);
      expect(evidence?.memoVerification).toBe("verified");
      expect(evidence?.transferVerification).toBe("verified");
      expect(evidence?.transfer).toEqual({
        mint: config.devnetUsdcMint,
        amount: String(config.amountMinor),
        recipient: config.payeePublicKey,
        payer: config.payerPublicKey,
      });

      const retry = await resource.accept(encodedPayment, digest, spendingRequest);
      expect(retry.status).toBe(200);
      const retryBody = retry.body as Record<string, unknown>;
      expect(retryBody.note).toContain("replay: cached result returned, no second charge");
      const retryEvidence = retryBody.settlementEvidence as Record<string, unknown> | undefined;
      expect(retryEvidence?.transactionHash).toBe(evidence?.transactionHash);
      expect(retryEvidence?.paymentIdentifier).toBe(evidence?.paymentIdentifier);
    }, 30_000);
  });
});

describe("verification failure never settles (offline stubs)", () => {
  // Any outbound request fails the test — no facilitator, RPC, or Devnet calls.
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`Offline test attempted unexpected outbound request: ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const PAYER = "TestPayerPubKey1111111111111111111111111111";
  const PAYEE = "TestPayeePubKey1111111111111111111111111111";

  function createStubbedResource(verifyResult: unknown, settleImpl: (...args: never[]) => unknown) {
    const resource = new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: PAYER,
      payeePublicKey: PAYEE,
      devnetUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountMinor: 10000,
    },
      new InMemorySettlementStore(),
    );
    const verifyPayment = vi.fn().mockResolvedValue(verifyResult);
    const settlePayment = vi.fn().mockImplementation(settleImpl);
    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      verifyPayment,
      settlePayment,
    };
    (resource as unknown as { initialized: boolean }).initialized = true;
    return { resource, verifyPayment, settlePayment };
  }

  function buildAttempt(resource: DevnetMachineResource, orderId: string, paymentId: string) {
    const spendingRequest: ToolSpendRequest = {
      orderId,
      intentVersion: 1,
      resource: "/api/resources/premium-fit-score",
      amountMinor: 10000,
      network: SOLANA_DEVNET_CAIP2,
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payee: PAYEE,
      purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment({ ...canonical }, paymentId);
    return { spendingRequest, digest, encoded };
  }

  it("failed facilitator verification returns 402 and never calls settle", async () => {
    const { resource, settlePayment } = createStubbedResource(
      { isValid: false, invalidReason: "bad_signature_stub" },
      async () => { throw new Error("settle must not be called"); },
    );
    const { spendingRequest, digest, encoded } = buildAttempt(resource, "ord_verify_fail_1", "pay_test_verify_fail_01");

    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(402);
    expect(JSON.stringify(first.body)).toContain("payment_verification_failed");
    expect(settlePayment).not.toHaveBeenCalled();
    expect(await resource.hasProcessed("pay_test_verify_fail_01", digest)).toBe(false);

    // Retry while unresolved: still rejected, still no settlement attempt.
    const second = await resource.accept(encoded, digest, spendingRequest);
    expect(second.status).toBe(402);
    expect(settlePayment).not.toHaveBeenCalled();
    expect(await resource.hasProcessed("pay_test_verify_fail_01", digest)).toBe(false);
  });

  it("settle transport failure without signature goes manual with exactly one settle call", async () => {
    const { resource, settlePayment } = createStubbedResource(
      { isValid: true, payer: PAYER },
      async () => { throw new Error("facilitator transport down (stub)"); },
    );
    const { spendingRequest, digest, encoded } = buildAttempt(resource, "ord_settle_fail_1", "pay_test_settle_fail_01");

    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    expect(JSON.stringify(first.body)).toContain("manual_reconciliation_required");
    expect(settlePayment).toHaveBeenCalledTimes(1);

    // Retry reconciles the stored attempt — no replacement submission.
    const second = await resource.accept(encoded, digest, spendingRequest);
    expect(second.status).toBe(202);
    expect(JSON.stringify(second.body)).toContain("manual_reconciliation_required");
    expect(settlePayment).toHaveBeenCalledTimes(1);
    expect(await resource.hasProcessed("pay_test_settle_fail_01", digest)).toBe(false);
  });

  it("ambiguous settlement stays pending across retries with exactly one settle call", async () => {
    const { resource, settlePayment } = createStubbedResource(
      { isValid: true, payer: PAYER },
      async () => ({ success: true, transaction: "tx_ambiguous_stub_1", network: SOLANA_DEVNET_CAIP2, payer: PAYER, amount: "10000" }),
    );
    const { spendingRequest, digest, encoded } = buildAttempt(resource, "ord_ambiguous_1", "pay_test_ambiguous_01");

    // No solanaRpcUrl is configured, so on-chain evidence is unavailable by
    // construction — the attempt must stay pending, never settle again.
    const first = await resource.accept(encoded, digest, spendingRequest);
    expect(first.status).toBe(202);
    const firstBody = JSON.stringify(first.body);
    expect(firstBody).toContain("settlement_ambiguous");
    expect(firstBody).toContain("tx_ambiguous_stub_1");
    expect(settlePayment).toHaveBeenCalledTimes(1);

    const second = await resource.accept(encoded, digest, spendingRequest);
    expect(second.status).toBe(202);
    expect(JSON.stringify(second.body)).toContain("settlement_ambiguous");
    expect(settlePayment).toHaveBeenCalledTimes(1);
    expect(await resource.hasProcessed("pay_test_ambiguous_01", digest)).toBe(false);
  });
});

describe("chain finalized but persistence fails → operator reconcile without resubmission (offline stubs)", () => {
  // Production incident: the settled transition rolled back (multi-status
  // history enum write) after the facilitator submission finalized on-chain.
  // The route returned 500 with no signature persisted. The fix returns 202
  // with the transaction hash, and the operator reconcile path persists it
  // with zero additional submissions. No facilitator, RPC, or Devnet calls:
  // every external boundary is stubbed.
  const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const PAYER_KEY = "IntegrationPayerKey111111111111111111111111";
  const PAYEE_KEY = "IntegrationPayeeKey111111111111111111111111";
  const FEE_PAYER_KEY = "IntegrationFeePayerKey111111111111111111111";
  const STUB_TX = "5".repeat(64);
  const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

  function createResource() {
    return new DevnetMachineResource({
      mode: "devnet",
      facilitatorUrl: "https://x402.org/facilitator",
      payerSecretKey: new Uint8Array(32),
      payerPublicKey: PAYER_KEY,
      payeePublicKey: PAYEE_KEY,
      devnetUsdcMint: USDC_MINT,
      amountMinor: 10000,
      solanaRpcUrl: "http://localhost:9999/rpc",
    },
      new InMemorySettlementStore(),
    );
  }

  function stubAdapters(resource: DevnetMachineResource) {
    const verifyFn = vi.fn().mockResolvedValue({ isValid: true, payer: PAYER_KEY });
    const settleFn = vi.fn().mockResolvedValue({
      success: true, transaction: STUB_TX, network: SOLANA_DEVNET_CAIP2, payer: PAYER_KEY, amount: "10000",
    });
    (resource as unknown as { resourceServer: Record<string, unknown> }).resourceServer = {
      initialize: vi.fn().mockResolvedValue(undefined),
      verifyPayment: verifyFn,
      settlePayment: settleFn,
    };
    (resource as unknown as { initialized: boolean }).initialized = true;
    return { verifyFn, settleFn };
  }

  function stubVerifiedRpc(expectedMemo: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr === "http://localhost:9999/rpc") {
        return {
          json: async () => ({
            result: {
              transaction: {
                message: {
                  instructions: [
                    { parsed: expectedMemo, program: "spl-memo", programId: MEMO_PROGRAM_ID },
                    {
                      parsed: {
                        type: "transferChecked",
                        info: { mint: USDC_MINT, destination: PAYEE_KEY, authority: PAYER_KEY, tokenAmount: { amount: "10000" } },
                      },
                      program: "spl-token",
                      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    },
                  ],
                },
              },
              meta: { err: null, innerInstructions: [], postTokenBalances: [], preTokenBalances: [] },
            },
          }),
        } as Response;
      }
      throw new Error(`Offline test attempted unexpected outbound request: ${urlStr}`);
    }) as typeof fetch);
  }

  it("returns the signature for operator recovery, then replays cached with one settle total", async () => {
    // Let the simulated worker lease expire before the operator takeover.
    process.env.X402_LEASE_TTL_MS = "1";
    const resource = createResource();
    const { settleFn: settlePayment } = stubAdapters(resource);
    const store = (resource as unknown as { store: InMemorySettlementStore }).store;
    const spendingRequest: ToolSpendRequest = {
      orderId: "ord_persist_fail_1", intentVersion: 1, resource: "/api/resources/premium-fit-score",
      amountMinor: 10000, network: SOLANA_DEVNET_CAIP2, asset: USDC_MINT, payee: PAYEE_KEY, purpose: "fit_scoring",
    };
    const digest = resource.buildRequestDigest(spendingRequest);
    const canonical = resource.getCanonicalRequirements(digest);
    const encoded = encodeDevnetPayment(canonical, "pay_test_persist_fail_01");
    const rpcSpy = stubVerifiedRpc(canonical.extra.memo);

    // Persistence outage confined to the settled write (chain already final).
    const origTransition = store.transition.bind(store);
    const transitionSpy = vi.spyOn(store, "transition").mockImplementation(async (
      operationId: string, from: Array<"pending" | "rejected" | "settling" | "awaiting_evidence" | "settled" | "mismatch" | "manual" | "released">,
      to: "pending" | "rejected" | "settling" | "awaiting_evidence" | "settled" | "mismatch" | "manual" | "released",
      update: Partial<{ txHash: string | null }>, owner: string | null, fenceToken: string | null, trigger: string, note: string,
    ) => {
      if (to === "settled") throw new Error("persistence down (stub)");
      return origTransition(operationId, from as never, to as never, update as never, owner, fenceToken, trigger, note) as never;
    });

    const first = await resource.accept(encoded, digest, spendingRequest);
    // Never a 500 that loses the signature: 202 carries it for the operator.
    expect(first.status).toBe(202);
    const firstBody = first.body as Record<string, unknown>;
    expect(firstBody.transactionHash).toBe(STUB_TX);
    expect(firstBody.retryable).toBe(true);
    expect(settlePayment).toHaveBeenCalledTimes(1);
    const row = await store.findByDigestPayment(digest, "pay_test_persist_fail_01");
    expect(row?.status).toBe("settling");
    expect(row?.txHash).toBeNull();

    // Operator incident path: persist the finalized signature, no resubmission.
    transitionSpy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { persistReconciledSettlement } = await import("@agentready/payments/operator");
    const reconciled = await persistReconciledSettlement(store, {
      operationId: row!.operationId,
      operatorId: "op_test",
      txHash: STUB_TX,
      checkedSlot: 1,
      note: "incident reconcile (stub)",
      evidenceJson: { paymentIdentifier: "pay_test_persist_fail_01", transactionHash: STUB_TX },
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(reconciled.reasons.join("; "));
    expect(reconciled.row.status).toBe("settled");
    expect(store.historyForTests().at(-1)).toMatchObject({
      from: "settling",
      to: "settled",
      trigger: "operator-reconcile",
    });

    const retry = await resource.accept(encoded, digest, spendingRequest);
    expect(retry.status).toBe(200);
    expect(settlePayment).toHaveBeenCalledTimes(1);
    expect(((retry.body as Record<string, unknown>).settlementEvidence as Record<string, unknown>).transactionHash).toBe(STUB_TX);

    rpcSpy.mockRestore();
  });
});
