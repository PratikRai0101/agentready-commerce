import { describe, expect, it } from "vitest";
import { runCriticalInvariants, type PlaneHooks } from "../src";
import { envelopeDigest } from "@agentready/domain";
import type { CommerceEnvelope, PurchaseMandate } from "@agentready/domain";

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
  };
}

describe("critical invariants", () => {
  it("passes all six gates with a compliant plane", async () => {
    const report = await runCriticalInvariants(passingPlane(), envelope, mandate);
    expect(report.failCount).toBe(0);
    expect(report.passCount).toBe(6);
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