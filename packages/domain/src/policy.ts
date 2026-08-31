import { envelopeDigest } from "./canonical";
import type { CommerceEnvelope, PaymentRail, PurchaseMandate } from "./types";

export type PolicyVerdict = {
  allow: boolean;
  decision: "allow" | "block" | "review";
  reasonCodes: string[];
  details?: string;
};

export const REASON_CODES = {
  MANDATE_NOT_FOUND: "mandate_not_found",
  MANDATE_MERCHANT_NOT_ALLOWED: "mandate_merchant_not_allowed",
  MANDATE_PRODUCT_NOT_ALLOWED: "mandate_product_not_allowed",
  MANDATE_RAIL_NOT_ALLOWED: "mandate_rail_not_allowed",
  MANDATE_AMOUNT_EXCEEDED: "mandate_amount_exceeded",
  MANDATE_EXPIRED: "mandate_expired",
  MANDATE_HUMAN_CONFIRMATION_REQUIRED: "mandate_human_confirmation_required",
  ENVELOPE_EXPIRED: "envelope_expired",
  ENVELOPE_NOT_APPROVED: "envelope_not_approved",
  ENVELOPE_TAMPERED: "envelope_tampered",
  REAPPROVAL_REQUIRED: "reapproval_required",
  OK: "ok",
} as const;

export type CheckEnvelopeInput = {
  envelope: CommerceEnvelope;
  mandate: PurchaseMandate | undefined;
  expectedDigest: string;
  rail?: PaymentRail;
  approved: boolean;
  allowAutoApprove: boolean;
  nowIso?: string;
};

export function checkEnvelopeForPayment(input: CheckEnvelopeInput): PolicyVerdict {
  const { envelope, mandate, expectedDigest, allowAutoApprove, rail, approved } = input;
  const now = input.nowIso ?? new Date().toISOString();
  const codes: string[] = [];

  const actualDigest = envelopeDigest(envelope);
  if (actualDigest !== expectedDigest) {
    return {
      allow: false,
      decision: "block",
      reasonCodes: [REASON_CODES.ENVELOPE_TAMPERED],
      details: "Envelope content does not match the approved digest.",
    };
  }

  if (!mandate) {
    return {
      allow: false,
      decision: "block",
      reasonCodes: [REASON_CODES.MANDATE_NOT_FOUND],
    };
  }

  if (!mandate.allowedMerchantIds.includes(envelope.merchantId)) {
    codes.push(REASON_CODES.MANDATE_MERCHANT_NOT_ALLOWED);
  }
  if (mandate.allowedProductIds) {
    const productIds = new Set(envelope.items.map((item) => item.productId));
    for (const productId of productIds) {
      if (!mandate.allowedProductIds.includes(productId)) {
        codes.push(REASON_CODES.MANDATE_PRODUCT_NOT_ALLOWED);
      }
    }
  }
  if (rail && !mandate.allowedRails.includes(rail)) {
    codes.push(REASON_CODES.MANDATE_RAIL_NOT_ALLOWED);
  }
  if (envelope.totalMinor > mandate.maxAmountMinor) {
    codes.push(REASON_CODES.MANDATE_AMOUNT_EXCEEDED);
  }
  if (mandate.expiresAt < now) {
    codes.push(REASON_CODES.MANDATE_EXPIRED);
  }
  if (envelope.expiresAt < now) {
    codes.push(REASON_CODES.ENVELOPE_EXPIRED);
  }
  const isApproved = approved || (allowAutoApprove && (mandate.autoApproveBelowMinor ?? -1) >= envelope.totalMinor);
  if (!isApproved) {
    codes.push(REASON_CODES.ENVELOPE_NOT_APPROVED);
  }
  if (mandate.humanConfirmationRequired && !approved) {
    codes.push(REASON_CODES.MANDATE_HUMAN_CONFIRMATION_REQUIRED);
  }

  if (codes.length > 0) {
    return {
      allow: false,
      decision: codes.includes(REASON_CODES.MANDATE_AMOUNT_EXCEEDED) ? "review" : "block",
      reasonCodes: codes,
    };
  }

  return { allow: true, decision: "allow", reasonCodes: [REASON_CODES.OK] };
}

export type MaterialChange = {
  field: string;
  before: string;
  after: string;
};

export function materialChanges(approved: CommerceEnvelope, candidate: CommerceEnvelope): MaterialChange[] {
  const changes: MaterialChange[] = [];
  if (approved.merchantId !== candidate.merchantId) {
    changes.push({ field: "merchantId", before: approved.merchantId, after: candidate.merchantId });
  }
  if (approved.currency !== candidate.currency) {
    changes.push({ field: "currency", before: approved.currency, after: candidate.currency });
  }
  if (approved.totalMinor !== candidate.totalMinor) {
    changes.push({
      field: "totalMinor",
      before: String(approved.totalMinor),
      after: String(candidate.totalMinor),
    });
  }
  if (approved.subtotalMinor !== candidate.subtotalMinor) {
    changes.push({
      field: "subtotalMinor",
      before: String(approved.subtotalMinor),
      after: String(candidate.subtotalMinor),
    });
  }
  if (approved.shippingMinor !== candidate.shippingMinor) {
    changes.push({
      field: "shippingMinor",
      before: String(approved.shippingMinor),
      after: String(candidate.shippingMinor),
    });
  }
  if (approved.taxMinor !== candidate.taxMinor) {
    changes.push({
      field: "taxMinor",
      before: String(approved.taxMinor),
      after: String(candidate.taxMinor),
    });
  }
  if (approved.returnPolicyDigest !== candidate.returnPolicyDigest) {
    changes.push({
      field: "returnPolicyDigest",
      before: approved.returnPolicyDigest,
      after: candidate.returnPolicyDigest,
    });
  }
  if (approved.shippingDestinationDigest !== candidate.shippingDestinationDigest) {
    changes.push({
      field: "shippingDestinationDigest",
      before: approved.shippingDestinationDigest,
      after: candidate.shippingDestinationDigest,
    });
  }
  if (approved.expiresAt !== candidate.expiresAt) {
    changes.push({ field: "expiresAt", before: approved.expiresAt, after: candidate.expiresAt });
  }
  if (approved.mandateId !== candidate.mandateId) {
    changes.push({ field: "mandateId", before: approved.mandateId, after: candidate.mandateId });
  }

  const beforeItems = JSON.stringify(approved.items);
  const afterItems = JSON.stringify(candidate.items);
  if (beforeItems !== afterItems) {
    changes.push({ field: "items", before: beforeItems, after: afterItems });
  }

  return changes;
}

export function requiresReapproval(approved: CommerceEnvelope, candidate: CommerceEnvelope): boolean {
  return materialChanges(approved, candidate).length > 0;
}