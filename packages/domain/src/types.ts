export const CURRENCIES = ["INR", "USDC"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_RAILS = ["razorpay_checkout", "razorpay_reserve_pay", "x402_solana"] as const;
export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export type HardConstraints = {
  maxAmountMinor: number;
  currency: Currency;
  size?: string;
  colour?: string;
  useCase?: string;
  mustBeReturnable?: boolean;
  deliverBy?: string;
};

export type SoftPreference = {
  name: string;
  value: string;
  weight: number;
};

export type PurchaseIntent = {
  merchantId: string;
  category: string;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreference[];
};

export type PurchaseMandate = {
  mandateId: string;
  customerId: string;
  allowedMerchantIds: string[];
  allowedProductIds?: string[];
  allowedRails: PaymentRail[];
  maxAmountMinor: number;
  autoApproveBelowMinor?: number;
  expiresAt: string;
  humanConfirmationRequired: boolean;
};

export type EnvelopeItem = {
  productId: string;
  sku: string;
  variant: Record<string, string>;
  quantity: number;
  unitAmountMinor: number;
};

export type CommerceEnvelope = {
  version: 1;
  logicalOrderId: string;
  merchantId: string;
  quoteId: string;
  customerId: string;
  buyerAgentId?: string;
  items: EnvelopeItem[];
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: Currency;
  inventoryHoldId: string;
  returnPolicyDigest: string;
  shippingDestinationDigest: string;
  mandateId: string;
  approvalEventId?: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export const ORDER_STATES = [
  "DRAFT",
  "CLARIFYING",
  "QUOTED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "PAYMENT_PENDING",
  "PAID_VERIFIED",
  "FULFILMENT_PENDING",
  "FULFILLED",
  "EXPIRED",
  "REAPPROVAL_REQUIRED",
  "PAYMENT_FAILED",
  "FULFILMENT_FAILED",
  "COMPENSATION_PENDING",
  "REFUNDED",
  "MANUAL_REVIEW",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export const ALLOWED_TRANSITIONS: Record<OrderState, OrderState[]> = {
  DRAFT: ["CLARIFYING", "QUOTED", "EXPIRED"],
  CLARIFYING: ["CLARIFYING", "QUOTED", "EXPIRED"],
  QUOTED: ["AWAITING_APPROVAL", "EXPIRED", "REAPPROVAL_REQUIRED"],
  AWAITING_APPROVAL: ["APPROVED", "EXPIRED", "REAPPROVAL_REQUIRED", "CLARIFYING", "QUOTED"],
  APPROVED: ["PAYMENT_PENDING", "EXPIRED", "REAPPROVAL_REQUIRED"],
  PAYMENT_PENDING: ["PAID_VERIFIED", "PAYMENT_FAILED", "REAPPROVAL_REQUIRED", "EXPIRED"],
  PAID_VERIFIED: ["FULFILMENT_PENDING", "FULFILMENT_FAILED"],
  FULFILMENT_PENDING: ["FULFILLED", "FULFILMENT_FAILED"],
  FULFILLED: [],
  EXPIRED: [],
  REAPPROVAL_REQUIRED: ["AWAITING_APPROVAL", "APPROVED", "EXPIRED", "CLARIFYING", "QUOTED"],
  PAYMENT_FAILED: ["PAYMENT_PENDING", "EXPIRED"],
  FULFILMENT_FAILED: ["COMPENSATION_PENDING"],
  COMPENSATION_PENDING: ["REFUNDED", "MANUAL_REVIEW"],
  REFUNDED: [],
  MANUAL_REVIEW: ["REFUNDED", "FULFILMENT_PENDING", "FULFILLED", "COMPENSATION_PENDING"],
};

export type StateTransitionResult =
  | { ok: true; from: OrderState; to: OrderState }
  | { ok: false; from: OrderState; to: OrderState; reason: string };

export function transitionState(from: OrderState, to: OrderState): StateTransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (from === to) {
    return { ok: true, from, to };
  }
  if (!allowed.includes(to)) {
    return {
      ok: false,
      from,
      to,
      reason: `Illegal transition ${from} -> ${to}`,
    };
  }
  return { ok: true, from, to };
}

export function assertTransition(from: OrderState, to: OrderState): void {
  const result = transitionState(from, to);
  if (!result.ok) {
    throw new Error(result.reason);
  }
}
