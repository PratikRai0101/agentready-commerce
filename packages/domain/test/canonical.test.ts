import { describe, expect, it } from "vitest";
import { canonicalize, envelopeDigest, signEnvelope, verifyEnvelopeSignature } from "../src/canonical";
import type { CommerceEnvelope } from "../src/types";

const baseEnvelope: CommerceEnvelope = {
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

describe("canonicalization", () => {
  it("is deterministic across key orders", () => {
    const a = canonicalize({ b: 1, a: [1, { d: "x", c: null }], z: "s" });
    const b = canonicalize({ z: "s", a: [1, { c: null, d: "x" }], b: 1 });
    expect(a).toBe(b);
  });

  it("omits undefined keys but keeps nulls", () => {
    const withUndefined = canonicalize({ a: undefined, b: null });
    expect(withUndefined).toBe('{"b":null}');
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
  });

  it("produces a stable digest for the same envelope", () => {
    expect(envelopeDigest(baseEnvelope)).toBe(envelopeDigest(structuredClone(baseEnvelope)));
  });

  it("changes digest when any commercial field changes", () => {
    const changed = { ...baseEnvelope, items: [{ ...baseEnvelope.items[0]!, quantity: 2 }] };
    expect(envelopeDigest(changed)).not.toBe(envelopeDigest(baseEnvelope));
  });
});

describe("signing", () => {
  it("signs and verifies an envelope", () => {
    const signature = signEnvelope(baseEnvelope, "secret");
    expect(verifyEnvelopeSignature(baseEnvelope, "secret", signature)).toBe(true);
  });

  it("rejects a signature from a different secret", () => {
    const signature = signEnvelope(baseEnvelope, "secret-a");
    expect(verifyEnvelopeSignature(baseEnvelope, "secret-b", signature)).toBe(false);
  });

  it("rejects a signature for tampered content", () => {
    const signature = signEnvelope(baseEnvelope, "secret");
    const tampered = { ...baseEnvelope, totalMinor: 1 };
    expect(verifyEnvelopeSignature(tampered, "secret", signature)).toBe(false);
  });
});