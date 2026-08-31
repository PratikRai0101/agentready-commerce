import { createHash } from "node:crypto";
import { createAuditLedger, MemoryAuditStore } from "@agentready/audit";
import type { AuditEvent } from "@agentready/audit";
import {
  SHOE_CATALOG,
  estimateShipping,
  formatMinor,
  rankProducts,
  type ProductMatch,
  type RankingResult,
} from "@agentready/catalog";
import {
  checkEnvelopeForPayment,
  envelopeDigest,
  newId,
  requiresReapproval,
  signEnvelope,
  transitionState,
  type CommerceEnvelope,
  type OrderState,
  type PurchaseIntent,
  type PurchaseMandate,
} from "@agentready/domain";
import { createAdapterRegistry, razorpaySignature, type AdapterRegistry, type PaymentAttempt, type VerificationResult } from "@agentready/payments";
import { intentDigest, mergeIntents, parseIntentMessage, type ParsedIntent } from "./intent";

export type Session = {
  logicalOrderId: string;
  customerId: string;
  state: OrderState;
  message: string;
  intent: ParsedIntent;
  lastRanking?: RankingResult;
  approvalEventId?: string;
  approvedDigest?: string;
  externalOrderId?: string;
  externalPaymentId?: string;
  verification?: VerificationResult;
  compensation?: { refundId?: string; reason?: string; ok: boolean };
};

export type EnvelopeRecord = {
  envelope: CommerceEnvelope;
  digest: string;
  signature: string;
  issuedAt: string;
};

export type RespondResult =
  | { kind: "clarify"; message: string; questions: string[]; quickReplies: string[]; state: OrderState }
  | { kind: "shortlist"; message: string; matches: ProductMatch[]; state: OrderState }
  | { kind: "error"; message: string; state: OrderState };

export type AppServices = {
  createSession(): Session;
  respond(orderId: string, message: string): Promise<RespondResult>;
  buildQuote(orderId: string, productId: string): Promise<{ envelope: CommerceEnvelope; digest: string; signature: string; approvalEventId?: string; state: OrderState }>;
  approve(orderId: string, digest: string): Promise<{ ok: boolean; approvalEventId?: string; state: OrderState; error?: string }>;
  initiatePayment(orderId: string, rail: string): Promise<{ ok: boolean; attempt?: PaymentAttempt; state: OrderState; error?: string; reasonCodes?: string[] }>;
  mockCapture(orderId: string): Promise<{ paymentId: string; signature: string; orderId: string }>;
  verifyPayment(orderId: string, externalOrderId: string, externalPaymentId: string, signature: string): Promise<{ ok: boolean; state: OrderState; error?: string }>;
  fulfil(orderId: string, fail: boolean): Promise<{ ok: boolean; state: OrderState; error?: string }>;
  compensate(orderId: string): Promise<{ ok: boolean; state: OrderState; error?: string; refundId?: string }>;
  tamper(orderId: string, field: "price" | "variant"): Promise<{ ok: boolean; state: OrderState; changes: string[]; error?: string }>;
  timeline(orderId: string): Promise<AuditEvent[]>;
  getSession(orderId: string): Session | undefined;
  getEnvelope(orderId: string): EnvelopeRecord | undefined;
  getMandate(customerId: string): PurchaseMandate | undefined;
  isWebhookProcessed(eventId: string): boolean;
  markWebhookProcessed(eventId: string): void;
  markVerifiedFromWebhook(orderId: string, paymentId: string, orderIdExternal: string): Promise<void>;
  policyCheck(orderId: string, rail: string, candidate?: CommerceEnvelope): { allow: boolean; reasonCodes: string[] };
  registry: AdapterRegistry;
  audit: ReturnType<typeof createAuditLedger>;
  razorpayKeySecret: string;
  webhookSecret: string | undefined;
  isMock: boolean;
};

const DEMO_CUSTOMER = "cust_demo_01";
const MANDATE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const QUOTE_EXPIRY_MS = 15 * 60 * 1000;

function buildMandate(customerId: string): PurchaseMandate {
  return {
    mandateId: newId("mdt"),
    customerId,
    allowedMerchantIds: [SHOE_CATALOG.merchantId],
    allowedRails: ["razorpay_checkout"],
    maxAmountMinor: 1_000_000,
    expiresAt: new Date(Date.now() + MANDATE_EXPIRY_MS).toISOString(),
    humanConfirmationRequired: true,
  };
}

export function getServices(env: NodeJS.ProcessEnv = process.env, options?: { forceMock?: boolean }): AppServices {
  const globalServices = globalThis as unknown as { __agentreadyServices?: AppServices };
  if (globalServices.__agentreadyServices) {
    return globalServices.__agentreadyServices;
  }

  const razorpayKeySecret = env.RAZORPAY_KEY_SECRET ?? "mock_secret";
  const forceMock = options?.forceMock === true;
  const registry = createAdapterRegistry({
    razorpayKeyId: env.RAZORPAY_KEY_ID,
    razorpayKeySecret,
    razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    forceMock,
  });
  const webhookSecret =
    env.RAZORPAY_WEBHOOK_SECRET ?? (registry.isMock("razorpay_checkout") ? "mock_secret" : undefined);
  const store = new MemoryAuditStore();
  const audit = createAuditLedger(store);
  const sessions = new Map<string, Session>();
  const envelopes = new Map<string, EnvelopeRecord>();
  const mandates = new Map<string, PurchaseMandate>();
  const webhookDedup = new Map<string, string>();
  const signingSecret = env.ENVELOPE_SIGNING_SECRET ?? "dev-secret-change-me";

  const services: AppServices = {
    registry,
    audit,
    razorpayKeySecret,
    webhookSecret,
    isMock: registry.isMock("razorpay_checkout"),

    createSession() {
      const logicalOrderId = newId("ord");
      const customerId = DEMO_CUSTOMER;
      const mandate = buildMandate(customerId);
      mandates.set(customerId, mandate);
      const session: Session = {
        logicalOrderId,
        customerId,
        state: "DRAFT",
        message: "",
        intent: {},
      };
      sessions.set(logicalOrderId, session);
      void audit.log({
        logicalOrderId,
        type: "session.created",
        actor: "system",
        summary: `Session created for ${customerId}`,
        externalReferences: { mandateId: mandate.mandateId },
      });
      return session;
    },

    getSession(orderId) {
      return sessions.get(orderId);
    },

    getEnvelope(orderId) {
      return envelopes.get(orderId);
    },

    getMandate(customerId) {
      return mandates.get(customerId);
    },

    async respond(orderId, message) {
      const session = sessions.get(orderId);
      if (!session) {
        return { kind: "error", message: "Unknown session. Start a new conversation.", state: "DRAFT" };
      }

      const parsed = parseIntentMessage(message);
      session.intent = mergeIntents(session.intent, parsed);
      session.message = message;

      if (session.state === "DRAFT" || session.state === "CLARIFYING" || session.state === "REAPPROVAL_REQUIRED" || session.state === "QUOTED") {
        const intent: PurchaseIntent = {
          merchantId: SHOE_CATALOG.merchantId,
          category: "running_shoes",
          hardConstraints: {
            maxAmountMinor: session.intent.maxAmountMinor ?? 0,
            currency: "INR",
            size: session.intent.size,
            colour: session.intent.colour,
            useCase: session.intent.useCase as PurchaseIntent["hardConstraints"]["useCase"],
            mustBeReturnable: session.intent.mustBeReturnable,
            deliverBy: session.intent.deliverBy,
          },
          softPreferences: [
            { name: "distance", value: String(session.intent.distanceKm ?? 0), weight: 1 },
            { name: "fit", value: session.intent.fit ?? "", weight: 1 },
            { name: "cushioning", value: session.intent.cushioning ?? "", weight: 1 },
          ],
        };

        const ranking = rankProducts(intent, SHOE_CATALOG);
        session.lastRanking = ranking;

        if (!ranking.ranked) {
          setState(session, "CLARIFYING");
          const questions = ranking.missing.map((m) => m.label);
          const quickReplies = ranking.missing.flatMap((m) => m.options ?? []);
          const message = composeClarification(session, ranking.missing.map((m) => m.name));
          void audit.log({
            logicalOrderId: orderId,
            type: "intent.clarification_requested",
            actor: "agent",
            summary: message,
            inputDigest: intentDigest(session.intent),
          });
          return { kind: "clarify", message, questions, quickReplies, state: session.state };
        }

        setState(session, "QUOTED");
        const message = composeShortlist(session, ranking);
        void audit.log({
          logicalOrderId: orderId,
          type: "intent.shortlist_ranked",
          actor: "agent",
          summary: `Ranked ${ranking.matches.length} products for ${intentDigest(session.intent)}`,
          inputDigest: intentDigest(session.intent),
        });
        return { kind: "shortlist", message, matches: ranking.matches, state: session.state };
      }

      return {
        kind: "error",
        message: `Current state ${session.state} does not accept new product messages.`,
        state: session.state,
      };
    },

    async buildQuote(orderId, productId) {
      const session = sessions.get(orderId);
      if (!session) throw new Error("Unknown session");
      const product = SHOE_CATALOG.products.find((p) => p.productId === productId);
      if (!product) throw new Error(`Unknown product ${productId}`);
      const size = session.intent.size;
      if (!size) throw new Error("Size is required before quoting");
      const variant = product.variants.find((v) => v.size === size);
      if (!variant) {
        throw new Error(`Size ${size} not available for ${product.name}`);
      }
      if (variant.inStock <= 0) {
        throw new Error(`${product.name} in size ${size} is out of stock`);
      }

      const now = new Date();
      const shipping = estimateShipping(product.deliveryLeadDays, now.toISOString());
      const quantity = 1;
      const subtotal = product.priceMinor * quantity;
      const shippingMinor = shipping.feeMinor;
      const taxMinor = 0;
      const total = subtotal + shippingMinor + taxMinor;

      const envelope: CommerceEnvelope = {
        version: 1,
        logicalOrderId: orderId,
        merchantId: SHOE_CATALOG.merchantId,
        quoteId: newId("qt"),
        customerId: session.customerId,
        items: [
          {
            productId: product.productId,
            sku: variant.sku,
            variant: { size, colour: session.intent.colour ?? "black" },
            quantity,
            unitAmountMinor: product.priceMinor,
          },
        ],
        subtotalMinor: subtotal,
        taxMinor,
        shippingMinor,
        totalMinor: total,
        currency: "INR",
        inventoryHoldId: newId("hold"),
        returnPolicyDigest: SHA256(JSON.stringify(SHOE_CATALOG.returnPolicy)),
        shippingDestinationDigest: SHA256("Bengaluru, Karnataka, India"),
        mandateId: mandates.get(session.customerId)?.mandateId ?? "",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + QUOTE_EXPIRY_MS).toISOString(),
        nonce: newId("nonce"),
      };

      const digest = envelopeDigest(envelope);
      const signature = signEnvelope(envelope, signingSecret);
      envelopes.set(orderId, { envelope, digest, signature, issuedAt: now.toISOString() });

      setState(session, "AWAITING_APPROVAL");
      void audit.log({
        logicalOrderId: orderId,
        type: "quote.envelope_created",
        actor: "system",
        summary: `Envelope ${digest.slice(0, 16)}… for ${product.name} ${size} — ${formatMinor(total)}`,
        inputDigest: digest,
      });
      return {
        envelope,
        digest,
        signature,
        state: session.state,
        approvalEventId: session.approvalEventId,
      };
    },

    async approve(orderId, digest) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };
      const record = envelopes.get(orderId);
      if (!record) return { ok: false, state: session.state, error: "No envelope to approve" };

      if (session.approvalEventId && session.approvedDigest === digest) {
        return { ok: true, approvalEventId: session.approvalEventId, state: session.state };
      }

      if (record.digest !== digest) {
        return { ok: false, state: session.state, error: "Digest mismatch: approval must bind to the exact envelope hash" };
      }
      if (record.envelope.expiresAt < new Date().toISOString()) {
        setState(session, "EXPIRED");
        return { ok: false, state: session.state, error: "Quote expired" };
      }

      const approvalEventId = newId("appr");
      session.approvalEventId = approvalEventId;
      session.approvedDigest = digest;
      setState(session, "APPROVED");
      void audit.log({
        logicalOrderId: orderId,
        type: "approval.granted",
        actor: "customer",
        summary: `Approved envelope ${digest.slice(0, 16)}…`,
        inputDigest: digest,
        outputDigest: approvalEventId,
        decision: "allow",
        reasonCodes: ["approval_binds_hash"],
      });
      return { ok: true, approvalEventId, state: session.state };
    },

    async initiatePayment(orderId, rail) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };
      const record = envelopes.get(orderId);
      if (!record) return { ok: false, state: session.state, error: "No envelope" };

      if (session.state === "PAID_VERIFIED" || session.state === "FULFILMENT_PENDING" || session.state === "FULFILLED") {
        return { ok: false, state: session.state, error: "This order already has a successful payment; new rail initiation is rejected." };
      }

      const mandate = mandates.get(session.customerId);
      const verdict = checkEnvelopeForPayment({
        envelope: record.envelope,
        mandate,
        expectedDigest: record.digest,
        rail: rail as "razorpay_checkout",
        approved: Boolean(session.approvalEventId && session.approvedDigest === record.digest),
        allowAutoApprove: false,
      });

      if (!verdict.allow) {
        void audit.log({
          logicalOrderId: orderId,
          type: "policy.payment_blocked",
          actor: "policy",
          summary: `Payment blocked: ${verdict.reasonCodes.join(", ")}`,
          inputDigest: record.digest,
          decision: verdict.decision,
          reasonCodes: verdict.reasonCodes,
        });
        return { ok: false, state: session.state, error: `Policy blocked payment: ${verdict.reasonCodes.join(", ")}`, reasonCodes: verdict.reasonCodes };
      }

      if (session.externalOrderId) {
        if (session.state === "PAYMENT_FAILED") {
          setState(session, "PAYMENT_PENDING");
        }
        const attempt: PaymentAttempt = {
          attemptId: newId("att"),
          logicalOrderId: orderId,
          rail: "razorpay_checkout",
          externalOrderId: session.externalOrderId,
          status: "created",
          createdAt: record.issuedAt,
          amountMinor: record.envelope.totalMinor,
          currency: record.envelope.currency,
        };
        return { ok: true, attempt, state: session.state };
      }

      const adapter = registry.get(rail as "razorpay_checkout");
      if (!adapter) return { ok: false, state: session.state, error: `No adapter for rail ${rail}` };

      setState(session, "PAYMENT_PENDING");
      try {
        const attempt = await adapter.initiate(record.envelope);
        session.externalOrderId = attempt.externalOrderId;
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.initiated",
          actor: "payment",
          summary: `Razorpay order ${attempt.externalOrderId} created for ${formatMinor(attempt.amountMinor)}`,
          externalReferences: { orderId: attempt.externalOrderId ?? "" },
          decision: "allow",
        });
        return { ok: true, attempt, state: session.state };
      } catch (error) {
        setState(session, "PAYMENT_FAILED");
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.initiate_failed",
          actor: "payment",
          summary: `Order creation failed: ${error instanceof Error ? error.message : String(error)}`,
          decision: "review",
        });
        return { ok: false, state: session.state, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async mockCapture(orderId) {
      const session = sessions.get(orderId);
      if (!session || !session.externalOrderId) throw new Error("No initiated order");
      const paymentId = `pay_MOCK_${session.externalOrderId}_${Date.now()}`;
      const signature = razorpaySignature(razorpayKeySecret, `${session.externalOrderId}|${paymentId}`);
      return { paymentId, signature, orderId: session.externalOrderId };
    },

    async verifyPayment(orderId, externalOrderId, externalPaymentId, signature) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };
      const record = envelopes.get(orderId);
      if (!record) return { ok: false, state: session.state, error: "No envelope" };

      if (session.verification?.verified) {
        return { ok: true, state: session.state };
      }

      const adapter = registry.get("razorpay_checkout")!;
      const result = await adapter.verify({
        logicalOrderId: orderId,
        envelopeHash: record.digest,
        rail: "razorpay_checkout",
        externalOrderId,
        externalPaymentId,
        expectedAmountMinor: record.envelope.totalMinor,
        signature,
      });
      session.verification = result;
      session.externalPaymentId = externalPaymentId;

      if (result.verified) {
        setState(session, "PAID_VERIFIED");
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.verified",
          actor: "payment",
          summary: `Payment ${externalPaymentId} verified (${result.amountMinor} ${result.currency})`,
          externalReferences: { orderId: externalOrderId, paymentId: externalPaymentId },
          decision: "allow",
          reasonCodes: ["signature_verified", "rail_single_success"],
        });
        return { ok: true, state: session.state };
      }

      setState(session, "PAYMENT_FAILED");
      void audit.log({
        logicalOrderId: orderId,
        type: "payment.verification_failed",
        actor: "payment",
        summary: `Payment verification failed: ${result.reason ?? "unknown"}`,
        externalReferences: { paymentId: externalPaymentId },
        decision: "block",
        reasonCodes: ["signature_invalid"],
      });
      return { ok: false, state: session.state, error: result.reason ?? "Verification failed" };
    },

    async fulfil(orderId, fail) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };
      if (session.state !== "PAID_VERIFIED") {
        return { ok: false, state: session.state, error: `Fulfilment requires PAID_VERIFIED, current state ${session.state}` };
      }
      setState(session, "FULFILMENT_PENDING");
      if (fail) {
        setState(session, "FULFILMENT_FAILED");
        void audit.log({
          logicalOrderId: orderId,
          type: "fulfilment.failed",
          actor: "merchant",
          summary: "Inventory reservation lost at fulfilment; order cannot ship",
          decision: "review",
          reasonCodes: ["inventory_unavailable"],
        });
        return { ok: false, state: session.state, error: "Simulated fulfilment failure: inventory unavailable" };
      }
      setState(session, "FULFILLED");
      void audit.log({
        logicalOrderId: orderId,
        type: "fulfilment.completed",
        actor: "merchant",
        summary: "Order shipped",
        decision: "allow",
      });
      return { ok: true, state: session.state };
    },

    async compensate(orderId) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };
      if (session.state !== "FULFILMENT_FAILED" && session.state !== "COMPENSATION_PENDING") {
        return { ok: false, state: session.state, error: `Compensation requires FULFILMENT_FAILED, current state ${session.state}` };
      }
      const record = envelopes.get(orderId);
      if (!record) return { ok: false, state: session.state, error: "No envelope" };
      if (!session.externalPaymentId) return { ok: false, state: session.state, error: "No external payment id" };

      setState(session, "COMPENSATION_PENDING");
      const adapter = registry.get("razorpay_checkout")!;
      try {
        const result = await adapter.compensate({
          logicalOrderId: orderId,
          envelopeHash: record.digest,
          rail: "razorpay_checkout",
          externalPaymentId: session.externalPaymentId,
          amountMinor: record.envelope.totalMinor,
          reason: "Fulfilment failure — full refund",
        });
        session.compensation = { refundId: result.refundId, ok: result.compensated, reason: "full refund" };
        setState(session, "REFUNDED");
        void audit.log({
          logicalOrderId: orderId,
          type: "compensation.refunded",
          actor: "payment",
          summary: `Refund ${result.refundId} initiated for ${formatMinor(record.envelope.totalMinor)}`,
          externalReferences: { refundId: result.refundId ?? "" },
          decision: "allow",
          reasonCodes: ["paid_fulfilment_failure_refunded"],
        });
        return { ok: true, state: session.state, refundId: result.refundId };
      } catch (error) {
        setState(session, "MANUAL_REVIEW");
        void audit.log({
          logicalOrderId: orderId,
          type: "compensation.manual_review",
          actor: "merchant",
          summary: `Refund failed; routed to manual review: ${error instanceof Error ? error.message : String(error)}`,
          decision: "review",
        });
        return { ok: false, state: session.state, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async tamper(orderId, field) {
      const session = sessions.get(orderId);
      if (!session) return { ok: false, state: "DRAFT", error: "Unknown session", changes: [] };
      const record = envelopes.get(orderId);
      if (!record) return { ok: false, state: session.state, error: "No envelope", changes: [] };

      const candidate: CommerceEnvelope = structuredClone(record.envelope);
      const changes: string[] = [];
      if (field === "price") {
        candidate.items[0]!.unitAmountMinor = candidate.items[0]!.unitAmountMinor - 5000;
        candidate.subtotalMinor = candidate.items[0]!.unitAmountMinor;
        candidate.totalMinor = candidate.subtotalMinor + candidate.shippingMinor;
        changes.push(`price changed by tool retry to ₹${(candidate.totalMinor / 100).toFixed(2)}`);
      } else if (field === "variant") {
        candidate.items[0]!.variant = { ...candidate.items[0]!.variant, size: "UK 10" };
        changes.push("variant changed by tool retry to UK 10");
      }
      candidate.nonce = newId("nonce");

      const changed = requiresReapproval(record.envelope, candidate);
      if (!changed) {
        return { ok: false, state: session.state, error: "No material change detected", changes };
      }

      const newDigest = envelopeDigest(candidate);
      const newSignature = signEnvelope(candidate, signingSecret);
      envelopes.set(orderId, { envelope: candidate, digest: newDigest, signature: newSignature, issuedAt: new Date().toISOString() });
      session.approvedDigest = undefined;
      session.approvalEventId = undefined;
      setState(session, "REAPPROVAL_REQUIRED");

      void audit.log({
        logicalOrderId: orderId,
        type: "policy.reapproval_required",
        actor: "policy",
        summary: `Material change detected: ${changes.join("; ")}. Approval invalidated.`,
        inputDigest: record.digest,
        outputDigest: newDigest,
        decision: "block",
        reasonCodes: ["material_change_reapproval"],
      });
      return { ok: true, state: session.state, changes };
    },

    timeline(orderId) {
      return audit.timeline(orderId);
    },

    policyCheck(orderId, rail, candidate) {
      const session = sessions.get(orderId);
      const record = envelopes.get(orderId);
      if (!session || !record) return { allow: false, reasonCodes: ["no_envelope"] };
      const envelope = candidate ?? record.envelope;
      const expectedDigest = candidate ? record.digest : record.digest;
      const verdict = checkEnvelopeForPayment({
        envelope,
        mandate: mandates.get(session.customerId),
        expectedDigest,
        rail: rail as "razorpay_checkout",
        approved: Boolean(session.approvalEventId && session.approvedDigest === record.digest),
        allowAutoApprove: false,
      });
      return { allow: verdict.allow, reasonCodes: verdict.reasonCodes };
    },

    isWebhookProcessed(eventId) {
      return webhookDedup.has(eventId);
    },

    markWebhookProcessed(eventId) {
      webhookDedup.set(eventId, new Date().toISOString());
    },

    async markVerifiedFromWebhook(orderId, paymentId, orderIdExternal) {
      const session = sessions.get(orderId);
      const record = envelopes.get(orderId);
      if (!session || !record) return;
      const eventId = `webhook_mark_${paymentId}`;
      if (webhookDedup.has(eventId)) return;
      webhookDedup.set(eventId, new Date().toISOString());
      session.externalPaymentId = paymentId;
      session.verification = {
        verified: true,
        rail: "razorpay_checkout",
        externalOrderId: orderIdExternal,
        externalPaymentId: paymentId,
        amountMinor: record.envelope.totalMinor,
        currency: record.envelope.currency,
        status: "captured",
      };
      setState(session, "PAID_VERIFIED");
      void audit.log({
        logicalOrderId: orderId,
        type: "payment.verified_via_webhook",
        actor: "payment",
        summary: `Payment ${paymentId} captured (webhook) for ${formatMinor(record.envelope.totalMinor)}`,
        externalReferences: { paymentId, orderId: orderIdExternal },
        decision: "allow",
        reasonCodes: ["webhook_verified", "rail_single_success"],
      });
    },
  };

  globalServices.__agentreadyServices = services;
  return services;
}

function setState(session: Session, next: OrderState): void {
  const result = transitionState(session.state, next);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  session.state = next;
}

function SHA256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function composeClarification(session: Session, missingNames: string[]): string {
  const partial = [];
  if (session.intent.colour) partial.push(`colour ${session.intent.colour}`);
  if (session.intent.maxAmountMinor) partial.push(`budget ${formatMinor(session.intent.maxAmountMinor)}`);
  const preamble = partial.length > 0 ? `Got it — ${partial.join(", ")}. ` : "";
  if (missingNames.length === 1) {
    return `${preamble}One more detail before I shortlist: ${missingNames[0]}.`;
  }
  return `${preamble}Before I shortlist, I need ${missingNames.length} details: ${missingNames.join(", ")}.`;
}

function composeShortlist(session: Session, ranking: RankingResult): string {
  const best = ranking.matches[0];
  if (!best) return "No products satisfy your constraints with current stock.";
  return `Here are your top ${ranking.matches.length} matches. Best under the stated evidence: ${best.product.name} (₹${(best.product.priceMinor / 100).toFixed(2)}, score ${best.score}).`;
}