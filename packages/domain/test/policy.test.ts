import { describe, expect, it } from "vitest";
import { checkEnvelopeForPayment, materialChanges, requiresReapproval } from "../src/policy";
import { envelopeDigest } from "../src/canonical";
import type { CommerceEnvelope, PurchaseMandate } from "../src/types";

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

const digest = envelopeDigest(envelope);

describe("checkEnvelopeForPayment", () => {
  it("allows an approved envelope under a valid mandate", () => {
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(true);
  });

  it("blocks a tampered envelope (digest mismatch)", () => {
    const tampered = { ...envelope, totalMinor: 1 };
    const verdict = checkEnvelopeForPayment({
      envelope: tampered,
      mandate,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("envelope_tampered");
  });

  it("blocks an unapproved envelope", () => {
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate,
      expectedDigest: digest,
      approved: false,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("envelope_not_approved");
  });

  it("blocks when no mandate exists", () => {
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate: undefined,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("mandate_not_found");
  });

  it("blocks when the rail is not allowed", () => {
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
      rail: "x402_solana",
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("mandate_rail_not_allowed");
  });

  it("blocks when the amount exceeds the mandate", () => {
    const strict = { ...mandate, maxAmountMinor: 1000 };
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate: strict,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.decision).toBe("review");
    expect(verdict.reasonCodes).toContain("mandate_amount_exceeded");
  });

  it("blocks an expired mandate", () => {
    const expired = { ...mandate, expiresAt: "2090-01-01T00:00:00.000Z" };
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate: expired,
      expectedDigest: digest,
      approved: true,
      allowAutoApprove: false,
      nowIso: "2099-08-31T10:00:00.000Z",
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("mandate_expired");
  });

  it("blocks an expired envelope", () => {
    const expired = { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" };
    const verdict = checkEnvelopeForPayment({
      envelope: expired,
      mandate,
      expectedDigest: envelopeDigest(expired),
      approved: true,
      allowAutoApprove: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reasonCodes).toContain("envelope_expired");
  });

  it("auto-approves only below the mandate threshold", () => {
    const auto = { ...mandate, humanConfirmationRequired: false, autoApproveBelowMinor: 500_000 };
    const verdict = checkEnvelopeForPayment({
      envelope,
      mandate: auto,
      expectedDigest: digest,
      approved: false,
      allowAutoApprove: true,
    });
    expect(verdict.allow).toBe(true);
  });
});

describe("material changes", () => {
  const approved = { ...envelope, approvalEventId: "appr_1" };

  it("detects price changes", () => {
    const changed = { ...approved, totalMinor: 100, subtotalMinor: 95100 };
    expect(requiresReapproval(approved, changed)).toBe(true);
    expect(materialChanges(approved, changed).map((c) => c.field)).toContain("totalMinor");
  });

  it("detects variant changes", () => {
    const changed = {
      ...approved,
      items: [{ ...approved.items[0]!, variant: { size: "UK 10", colour: "black" } }],
    };
    expect(requiresReapproval(approved, changed)).toBe(true);
  });

  it("detects quantity changes", () => {
    const changed = { ...approved, items: [{ ...approved.items[0]!, quantity: 2 }] };
    expect(requiresReapproval(approved, changed)).toBe(true);
  });

  it("ignores cosmetic changes", () => {
    const changed = { ...approved, nonce: "different-nonce" };
    expect(requiresReapproval(approved, changed)).toBe(false);
  });
});