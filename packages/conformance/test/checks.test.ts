import { describe, expect, it } from "vitest";
import { runCriticalInvariants, type PlaneHooks } from "../src";
import { envelopeDigest } from "@agentready/domain";
import type { CommerceEnvelope, PurchaseMandate } from "@agentready/domain";
import { buildPaymentRequired, type SettlementResponse } from "@agentready/payments";

class TestMachineResource {
  private processed = new Map<string, SettlementResponse>();
  quote(envelopeHash: string): string {
    return buildPaymentRequired("test-resource", [
      {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "USDC",
        amount: "0.010000",
        payee: "payee_test",
        timeout: new Date(Date.now() + 60_000).toISOString(),
        paymentIdentifier: { required: true },
        extra: { memo: `agentcart:v1:${envelopeHash}` },
      },
    ]);
  }
  accept(header: string, envelopeHash: string) {
    let payload: {
      scheme: string;
      network: string;
      paymentIdentifier: string;
      paymentPayload: { amount: string; payee?: string; memo?: string };
    };
    try {
      payload = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    } catch {
      return { ok: false, error: "malformed" };
    }
    const option = JSON.parse(Buffer.from(this.quote(envelopeHash), "base64url").toString("utf8")).options[0] as {
      network: string;
      amount: string;
      payee: string;
      extra?: { memo?: string };
    };
    if (payload.network !== option.network) return { ok: false, error: "wrong network" };
    if (Number(payload.paymentPayload.amount) < Number(option.amount)) return { ok: false, error: "underpayment" };
    if (payload.paymentPayload.payee && payload.paymentPayload.payee !== option.payee) {
      return { ok: false, error: "wrong recipient" };
    }
    if (payload.paymentPayload.memo !== option.extra?.memo) return { ok: false, error: "memo mismatch" };
    if (this.processed.has(payload.paymentIdentifier)) {
      return { ok: true, settlement: this.processed.get(payload.paymentIdentifier)! };
    }
    const settlement: SettlementResponse = {
      success: true,
      network: option.network,
      payer: "wallet_agent_demo",
      amount: option.amount,
      transactionHash: `tx_${payload.paymentIdentifier}`,
      paymentIdentifier: payload.paymentIdentifier,
    };
    this.processed.set(payload.paymentIdentifier, settlement);
    return { ok: true, settlement };
  }
  hasProcessed(paymentIdentifier: string): boolean {
    return this.processed.has(paymentIdentifier);
  }
}

const envelope: CommerceEnvelope = {
  version: 1,
  logicalOrderId: "ord_1",
  merchantId: "merchant_runvista",
  quoteId: "qt_1",
  customerId: "cust_1",
  items: [
    {
      productId: "p_streak_4",
      sku: "STRK4-BLK-9",
      variant: { size: "UK 9", colour: "black" },
      quantity: 1,
      unitAmountMinor: 429900,
    },
  ],
  subtotalMinor: 429900,
  taxMinor: 0,
  shippingMinor: 4900,
  totalMinor: 434800,
  currency: "INR",
  inventoryHoldId: "hold_1",
  returnPolicyDigest: "rp",
  shippingDestinationDigest: "dest",
  mandateId: "mdt_1",
  issuedAt: "2099-08-31T10:00:00.000Z",
  expiresAt: "2099-08-31T10:15:00.000Z",
  nonce: "nonce_1",
};

const mandate: PurchaseMandate = {
  mandateId: "mdt_1",
  customerId: "cust_1",
  allowedMerchantIds: ["merchant_runvista"],
  allowedRails: ["razorpay_checkout"],
  maxAmountMinor: 1_000_000,
  expiresAt: "2099-09-01T00:00:00.000Z",
  humanConfirmationRequired: true,
};

function passingPlane(): PlaneHooks {
  let paid = false;
  const machine = new TestMachineResource();
  const processedWebhooks = new Set<string>();
  let bindingState = "PAYMENT_PENDING";
  const bindingReject = (reasons: string[]) => ({ ok: false, reasons, state: (bindingState = "PAYMENT_FAILED") });
  const railBinding: NonNullable<PlaneHooks["railBinding"]> = {
    attemptClientVerify: async (claims) => {
      const reasons: string[] = [];
      if (claims.orderId !== "order_binding") reasons.push("order id mismatch");
      if (claims.simulate?.orderId) reasons.push("fetched order_id mismatch");
      if (claims.simulate?.amountMinor !== undefined && claims.simulate.amountMinor !== envelope.totalMinor) {
        reasons.push(`amount ${claims.simulate.amountMinor} does not match approved envelope`);
      }
      if (claims.simulate?.currency && claims.simulate.currency !== envelope.currency) {
        reasons.push(`currency ${claims.simulate.currency} mismatch`);
      }
      if (claims.simulate?.status && claims.simulate.status !== "captured") {
        reasons.push(`payment status is ${claims.simulate.status}, not captured`);
      }
      if (reasons.length > 0) return bindingReject(reasons);
      if (bindingState === "PAYMENT_PENDING") bindingState = "PAID_VERIFIED";
      return { ok: true, reasons: [], state: bindingState };
    },
    applyWebhook: async (claims) => {
      const reasons: string[] = [];
      if (claims.orderId !== "order_binding") reasons.push("order id mismatch");
      if (claims.amountMinor !== envelope.totalMinor) reasons.push(`amount ${claims.amountMinor} mismatch`);
      if (claims.currency !== envelope.currency) reasons.push(`currency ${claims.currency} mismatch`);
      if (claims.status !== "captured") reasons.push(`status ${claims.status}, not captured`);
      if (reasons.length > 0) return bindingReject(reasons);
      bindingState = "PAID_VERIFIED";
      return { ok: true, reasons: [], state: bindingState };
    },
    currentState: async () => bindingState,
  };
  return {
    findMandate: async () => mandate,
    checkPaymentPolicy: async (candidate) => {
      if (envelopeDigest(candidate) !== envelopeDigest(envelope)) {
        return { allow: false, reasonCodes: ["material_change_reapproval"] };
      }
      return { allow: true, reasonCodes: [] };
    },
    attemptPayment: async () => {
      if (paid) return { ok: false, error: "already paid" };
      paid = true;
      return { ok: true };
    },
    approveEnvelope: async () => ({ ok: true, approvalEventId: "appr_1" }),
    verifyPayment: async (_env, signature) =>
      signature === "forged_signature"
        ? { verified: false, reason: "invalid signature" }
        : { verified: true },
    fulfil: async () => ({ ok: false, error: "inventory unavailable" }),
    compensate: async () => ({ ok: true, refundId: "rfnd_1" }),
    isAlreadyPaid: async () => paid,
    countSuccessRail: async () => (paid ? 1 : 0),
    replayWebhook: async (eventId) => {
      if (processedWebhooks.has(eventId)) return { processed: false, deduplicated: true };
      processedWebhooks.add(eventId);
      return { processed: true, deduplicated: false };
    },
    machine: {
      quote: (hash) => machine.quote(hash),
      accept: (header, hash) => machine.accept(header, hash),
      hasProcessed: (pid) => machine.hasProcessed(pid),
    },
    railBinding,
  };
}

describe("critical invariants", () => {
  it("passes all fifteen gates with a compliant plane", async () => {
    const report = await runCriticalInvariants(passingPlane(), envelope, mandate);
    expect(report.failCount).toBe(0);
    expect(report.passCount).toBe(15);
  });

  it("fails gate_12 when the plane does not enforce the payment amount", async () => {
    const plane = passingPlane();
    plane.railBinding!.attemptClientVerify = async (claims) =>
      claims.orderId !== "order_binding"
        ? { ok: false, reasons: ["order id mismatch"], state: "PAYMENT_FAILED" }
        : { ok: true, reasons: [], state: "PAID_VERIFIED" };
    const report = await runCriticalInvariants(plane, envelope, mandate);
    const gate = report.checks.find((check) => check.id === "gate_12")!;
    expect(gate.pass).toBe(false);
  });

  it("fails gate_03 when the plane allows a tampered cart", async () => {
    const plane = passingPlane();
    plane.checkPaymentPolicy = async () => ({ allow: true, reasonCodes: [] });
    const report = await runCriticalInvariants(plane, envelope, mandate);
    const gate = report.checks.find((check) => check.id === "gate_03")!;
    expect(gate.pass).toBe(false);
  });

  it("reports errors as failing checks without throwing", async () => {
    const plane = passingPlane();
    plane.approveEnvelope = async () => {
      throw new Error("boom");
    };
    const report = await runCriticalInvariants(plane, envelope, mandate);
    const gate = report.checks.find((check) => check.id === "gate_05")!;
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("boom");
  });

  it("detects digest mismatch on a tampered envelope", async () => {
    const tampered = { ...envelope, totalMinor: 1 };
    const report = await runCriticalInvariants(passingPlane(), envelope, mandate, {
      makeTampered: () => tampered,
    });
    const gate = report.checks.find((check) => check.id === "gate_03")!;
    expect(gate.pass).toBe(true);
    expect(envelopeDigest(tampered)).not.toBe(envelopeDigest(envelope));
  });
});