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
import { intentDigest, type ParsedIntent } from "./intent";
import { DEFAULT_MACHINE_SPEND, DemoMachineResource, runMachineSpend, type FitScore } from "./machine";
import { createLlmProvider, productMatchToExplainInput, type LlmProvider } from "./llm";
import { deterministicInterpretation, interpretUserMessage, type InterpretationOutcome, type StructuredInterpretation } from "./interpreter";
import { createDialogueMemory, syncMemory, invalidateQuote, acknowledgeChange, nextClarification, type DialogueMemory } from "./dialogue";

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
  machineSpend?: { paymentIdentifier: string; settlementHash: string; fitScores: FitScore[] };
  heldWebhook?: { eventId: string; paymentId: string; orderId: string };
  dialogue: DialogueMemory;
};

export type EnvelopeRecord = {
  envelope: CommerceEnvelope;
  digest: string;
  signature: string;
  issuedAt: string;
};

export type RespondResult =
  | { kind: "clarify"; message: string; questions: string[]; quickReplies: string[]; state: OrderState }
  | { kind: "shortlist"; message: string; matches: ProductMatch[]; fitScores?: FitScore[]; machineSpend?: { mock: boolean; paymentIdentifier: string; txHash: string; network: string; amount: string }; state: OrderState }
  | { kind: "error"; message: string; state: OrderState }
  | { kind: "compare"; productA: ProductMatch; productB: ProductMatch; facts: { strengths: string[]; differences: string[]; compromises: string[] }; state: OrderState }
  | { kind: "explain"; match: ProductMatch; explanation: string; state: OrderState }
  | { kind: "select"; productId: string; state: OrderState }
  | { kind: "restart"; state: OrderState };

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
  holdWebhook(orderId: string, held: { eventId: string; paymentId: string; orderId: string }): void;
  markVerifiedFromWebhook(
    orderId: string,
    paymentId: string,
    orderIdExternal: string,
    claims?: { amountMinor?: number; currency?: string; status?: string },
  ): Promise<{ ok: boolean; reasons: string[] }>;
  findSessionByExternalOrderId(orderIdExternal: string): Session | undefined;
  reset(): void;
  policyCheck(orderId: string, rail: string, candidate?: CommerceEnvelope): { allow: boolean; reasonCodes: string[] };
  registry: AdapterRegistry;
  audit: ReturnType<typeof createAuditLedger>;
  razorpayKeySecret: string;
  webhookSecret: string | undefined;
  isMock: boolean;
  razorpayMode: "mock" | "test" | "live";
  llm: LlmProvider;
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

export function getServices(env: NodeJS.ProcessEnv = process.env, options?: { forceMock?: boolean; llm?: LlmProvider; skipCache?: boolean }): AppServices {
  const globalServices = globalThis as unknown as { __agentreadyServices?: AppServices };
  if (!options?.skipCache && globalServices.__agentreadyServices) {
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
  const isMock = registry.isMock("razorpay_checkout");
  const razorpayMode: "mock" | "test" | "live" = isMock
    ? "mock"
    : (env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_test_")
      ? "test"
      : "live";
  const store = new MemoryAuditStore();
  const audit = createAuditLedger(store);
  const sessions = new Map<string, Session>();
  const envelopes = new Map<string, EnvelopeRecord>();
  const mandates = new Map<string, PurchaseMandate>();
  const webhookDedup = new Map<string, string>();
  const signingSecret = env.ENVELOPE_SIGNING_SECRET ?? "dev-secret-change-me";
  const machineResource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
  const llm = options?.llm ?? createLlmProvider(env);

  const services: AppServices = {
    registry,
    audit,
    razorpayKeySecret,
    webhookSecret,
    isMock,
    razorpayMode,
    llm,

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
        dialogue: createDialogueMemory(),
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

      session.message = message;

      // ── AI-1 structured interpretation (deterministic code authoritative) ──
      const deterministic = deterministicInterpretation(message, session.intent);
      const outcome = await interpretUserMessage(message, session.intent, llm);
      const merged = mergeInterpretation(deterministic, outcome);
      const hadQuoteBefore = session.dialogue.quoteValid;
      applyInterpretation(session, merged);

      // Legacy soft-preference enrichment only when AI-1 fell back to
      // deterministic parsing (avoid double LLM calls when the proposal was
      // accepted).
      if (llm.enabled && outcome.source !== "llm") {
        const soft = await llm.extractSoftPreferences(message);
        if (soft) {
          const applied: string[] = [];
          if (soft.fit && !session.intent.fit) { session.intent.fit = soft.fit; applied.push("fit"); }
          if (soft.cushioning && !session.intent.cushioning) { session.intent.cushioning = soft.cushioning; applied.push("cushioning"); }
          if (soft.distanceKm !== undefined && !session.intent.distanceKm) { session.intent.distanceKm = soft.distanceKm; applied.push("distanceKm"); }
          if (applied.length > 0) {
            void audit.log({ logicalOrderId: orderId, type: "llm.soft_preferences_extracted", actor: "agent",
              summary: `LLM enrichment applied to soft preferences: ${applied.join(", ")}`,
              inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["llm_advisory_only"] });
          }
        }
      }

      // ── Audit interpretation ──
      void audit.log({
        logicalOrderId: orderId, type: "interpreter.interpreted", actor: "agent",
        summary: `Interpreted action=${merged.action} source=${outcome.source} applied=${countApplied(merged)} rejected=${outcome.rejectedReasons.length}`,
        inputDigest: intentDigest(session.intent), decision: "allow",
        reasonCodes: outcome.rejectedReasons.length > 0 ? outcome.rejectedReasons.slice(0, 5) : ["schema_validated"],
      });

      // ── Material change invalidation (pre-approval only) ──
      const materialChange = merged.corrections.length > 0 || merged.removals.length > 0 ||
        merged.proposedHardConstraints.some((c) => session.intent[c.name as keyof ParsedIntent] !== undefined);
      let quoteInvalidated = false;
      if (materialChange && hadQuoteBefore) {
        invalidateQuote(session.dialogue);
        quoteInvalidated = true;
        void audit.log({ logicalOrderId: orderId, type: "quote.invalidated", actor: "system",
          summary: `Quote invalidated due to material change: corrections=[${merged.corrections.join(",")}] removals=[${merged.removals.join(",")}]`,
          inputDigest: intentDigest(session.intent), decision: "block", reasonCodes: ["material_change_refinement"] });
      }

      // ── Acknowledge corrections naturally ──
      const acknowledgement = acknowledgeChange(merged.corrections, merged.removals, session.intent);

      // ── Route by action ──
      switch (merged.action) {
        case "restart":
          session.dialogue = createDialogueMemory();
          session.intent = {};
          return { kind: "restart", state: session.state };

        case "compare":
          return handleCompare(session, merged.requestedProductIds, audit, orderId);

        case "explain":
          return handleExplain(session, merged.requestedProductIds, audit, orderId);

        case "select":
          return handleSelect(session, merged.requestedProductIds, merged.corrections, audit, orderId);

        case "search":
        case "refine":
          break;
      }

      // ── Search / Refine: rank products or ask clarification ──
      const canRank = session.state === "DRAFT" || session.state === "CLARIFYING" || session.state === "REAPPROVAL_REQUIRED" || session.state === "QUOTED" ||
        (session.state === "AWAITING_APPROVAL" && materialChange);
      if (!canRank) {
        return { kind: "error", message: `Current state ${session.state} does not accept new product messages.`, state: session.state };
      }

      const intent: PurchaseIntent = {
        merchantId: SHOE_CATALOG.merchantId,
        category: "running_shoes",
        hardConstraints: {
          maxAmountMinor: session.intent.maxAmountMinor ?? 1_000_000,
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
        const topMissing = nextClarification(session.intent, ranking.missing.map((m) => m.name));
        const allMissingNames = ranking.missing.map((m) => m.name);
        const quickReplies = ranking.missing.flatMap((m) => m.options ?? []);
        const replyMessage = composeClarification(session, allMissingNames);
        void audit.log({ logicalOrderId: orderId, type: "intent.clarification_requested", actor: "agent",
          summary: replyMessage, inputDigest: intentDigest(session.intent) });
        syncMemory(session.dialogue, session.intent, [], allMissingNames, "clarify", message);
        return { kind: "clarify", message: replyMessage, questions: [topMissing ?? ""].filter(Boolean), quickReplies, state: session.state };
      }

      if (session.state !== "AWAITING_APPROVAL" && session.state !== "REAPPROVAL_REQUIRED") {
        setState(session, "QUOTED");
      }
      if (!quoteInvalidated) {
        session.dialogue.quoteValid = true;
      }
      const machineSpend = !session.machineSpend && session.intent.fit
        ? runFitScoreSpend(session, machineResource, audit, orderId) : undefined;
      const replyMessage = await composeShortlistMessage(session, ranking, machineSpend, llm);
      void audit.log({ logicalOrderId: orderId, type: "intent.shortlist_ranked", actor: "agent",
        summary: `Ranked ${ranking.matches.length} products for ${intentDigest(session.intent)}`,
        inputDigest: intentDigest(session.intent) });

      syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), [], merged.action, message);

      return {
        kind: "shortlist",
        message: (acknowledgement ? acknowledgement + " " : "") + replyMessage,
        matches: ranking.matches,
        fitScores: session.machineSpend?.fitScores,
        machineSpend: machineSpend ? { mock: machineSpend.mock, paymentIdentifier: machineSpend.paymentIdentifier, txHash: machineSpend.txHash, network: machineSpend.network, amount: machineSpend.amount } : undefined,
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

      session.dialogue.quoteProductId = productId;
      session.dialogue.quoteValid = true;
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

      if (record.envelope.totalMinor < 100) {
        return {
          ok: false,
          state: session.state,
          error: "Order amount is below Razorpay's 100 paise minimum",
          reasonCodes: ["amount_below_minimum"],
        };
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

      if (externalOrderId !== session.externalOrderId) {
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.binding_rejected",
          actor: "policy",
          summary: `Submitted Razorpay order ${externalOrderId} does not match session order ${session.externalOrderId}`,
          decision: "block",
          reasonCodes: ["order_id_mismatch"],
        });
        setState(session, "PAYMENT_FAILED");
        return { ok: false, state: session.state, error: "Submitted Razorpay order does not match this session's order" };
      }

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

      if (!result.verified) {
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
      }

      const bindingFailures: string[] = [];
      if (result.externalOrderId !== session.externalOrderId) {
        bindingFailures.push(`fetched payment order_id ${result.externalOrderId} does not match session order`);
      }
      if (result.amountMinor !== record.envelope.totalMinor) {
        bindingFailures.push(`amount ${result.amountMinor} does not match approved envelope ${record.envelope.totalMinor}`);
      }
      if (result.currency !== record.envelope.currency) {
        bindingFailures.push(`currency ${result.currency} does not match approved envelope ${record.envelope.currency}`);
      }
      if (result.status !== "captured") {
        bindingFailures.push(`payment status is ${result.status}, not captured`);
      }

      if (bindingFailures.length > 0) {
        setState(session, "PAYMENT_FAILED");
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.binding_rejected",
          actor: "policy",
          summary: `Payment binding rejected: ${bindingFailures.join("; ")}`,
          externalReferences: { paymentId: externalPaymentId },
          decision: "block",
          reasonCodes: ["rail_binding_failed"],
        });
        return { ok: false, state: session.state, error: `Payment binding rejected: ${bindingFailures.join("; ")}` };
      }

      setState(session, "PAID_VERIFIED");
      void audit.log({
        logicalOrderId: orderId,
        type: "payment.verified",
        actor: "payment",
        summary: `Payment ${externalPaymentId} verified (${result.amountMinor} ${result.currency}, ${result.status})`,
        externalReferences: { orderId: externalOrderId, paymentId: externalPaymentId },
        decision: "allow",
        reasonCodes: ["signature_verified", "rail_binding_verified", "rail_single_success"],
      });

      if (session.heldWebhook) {
        servicesReconcileHeld(orderId, session, audit, webhookDedup);
      }

      return { ok: true, state: session.state };
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

    holdWebhook(orderId, held) {
      const session = sessions.get(orderId);
      if (!session) return;
      session.heldWebhook = held;
    },

    findSessionByExternalOrderId(orderIdExternal) {
      for (const session of sessions.values()) {
        if (session.externalOrderId === orderIdExternal) return session;
      }
      return undefined;
    },

    async markVerifiedFromWebhook(orderId, paymentId, orderIdExternal, claims) {
      const session = sessions.get(orderId);
      const record = envelopes.get(orderId);
      if (!session || !record) return { ok: false, reasons: ["no session or envelope"] };

      const failures: string[] = [];
      if (orderIdExternal !== session.externalOrderId) {
        failures.push(`webhook order_id ${orderIdExternal} does not match session order`);
      }
      if (claims?.amountMinor !== undefined && claims.amountMinor !== record.envelope.totalMinor) {
        failures.push(`webhook amount ${claims.amountMinor} does not match approved envelope ${record.envelope.totalMinor}`);
      }
      if (claims?.currency !== undefined && claims.currency !== record.envelope.currency) {
        failures.push(`webhook currency ${claims.currency} does not match approved envelope ${record.envelope.currency}`);
      }
      if (claims?.status !== undefined && claims.status !== "captured") {
        failures.push(`webhook status is ${claims.status}, not captured`);
      }

      if (failures.length > 0) {
        void audit.log({
          logicalOrderId: orderId,
          type: "webhook.binding_rejected",
          actor: "policy",
          summary: `Webhook payment rejected: ${failures.join("; ")}`,
          externalReferences: { paymentId, orderId: orderIdExternal },
          decision: "block",
          reasonCodes: ["webhook_binding_failed"],
        });
        return { ok: false, reasons: failures };
      }

      const eventId = `webhook_mark_${paymentId}`;
      if (webhookDedup.has(eventId)) return { ok: true, reasons: [] };
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
        reasonCodes: ["webhook_verified", "rail_binding_verified", "rail_single_success"],
      });
      return { ok: true, reasons: [] };
    },

    reset() {
      sessions.clear();
      envelopes.clear();
      mandates.clear();
      webhookDedup.clear();
      machineResource.reset();
      void audit.log({
        logicalOrderId: "system",
        type: "system.reset",
        actor: "system",
        summary: "Fresh-demo reset: all sessions, envelopes, webhook dedup and machine resource state cleared",
      });
    },
  };

  if (!options?.skipCache) {
    globalServices.__agentreadyServices = services;
  }
  return services;
}

function setState(session: Session, next: OrderState): void {
  if (session.state === next) return; // no-op if already in target state
  const result = transitionState(session.state, next);
  if (!result.ok) throw new Error(result.reason);
  session.state = next;
}

/* ── AI-2 grounded action handlers ── */

function handleCompare(
  session: Session,
  requestedIds: string[],
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): { kind: "compare"; productA: ProductMatch; productB: ProductMatch; facts: { strengths: string[]; differences: string[]; compromises: string[] }; state: OrderState } | { kind: "error"; message: string; state: OrderState } {
  const ranking = session.lastRanking;
  if (!ranking || ranking.matches.length === 0) {
    return { kind: "error", message: "No shortlist available to compare. Let me refine your search first.", state: session.state };
  }
  // If only one product named (no "and"), compare against the top match
  const ids = requestedIds.length >= 2
    ? requestedIds.slice(0, 2)
    : requestedIds.length === 1 && !session.message.toLowerCase().includes(" and ")
      ? [ranking.matches[0]!.product.productId, requestedIds[0]!]
      : requestedIds.length === 1
        ? [requestedIds[0]!] // single product but can't resolve pair
        : [];
  if (ids.length < 2) {
    return { kind: "error", message: "I need at least one product name to compare. Please specify which shoe.", state: session.state };
  }
  const idA = ids[0]!;
  const idB = ids[1]!;
  const matchA = ranking.matches.find((m) => m.product.productId === idA);
  const matchB = ranking.matches.find((m) => m.product.productId === idB);
  if (!matchA || !matchB) {
    return { kind: "error", message: "One or both of those products are not in your current shortlist.", state: session.state };
  }
  const strengths: string[] = [];
  const differences: string[] = [];
  const compromises: string[] = [];
  if (matchA.product.priceMinor !== matchB.product.priceMinor) {
    const cheaper = matchA.product.priceMinor < matchB.product.priceMinor ? matchA.product.name : matchB.product.name;
    const dearer = matchA.product.priceMinor > matchB.product.priceMinor ? matchA.product.name : matchB.product.name;
    differences.push(`${cheaper} is cheaper than ${dearer}`);
  }
  if (matchA.product.fit !== matchB.product.fit) {
    differences.push(`${matchA.product.name} is ${matchA.product.fit} fit; ${matchB.product.name} is ${matchB.product.fit} fit`);
  }
  if (matchA.product.cushioning !== matchB.product.cushioning) {
    differences.push(`${matchA.product.name} has ${matchA.product.cushioning} cushioning; ${matchB.product.name} has ${matchB.product.cushioning} cushioning`);
  }
  if (matchA.product.typicalDistanceKm !== matchB.product.typicalDistanceKm) {
    differences.push(`${matchA.product.name} handles up to ${matchA.product.typicalDistanceKm}K; ${matchB.product.name} up to ${matchB.product.typicalDistanceKm}K`);
  }
  for (const m of [matchA, matchB]) {
    if (m.reasons.length > 0) strengths.push(`${m.product.name}: ${m.reasons.join("; ")}`);
    if (m.compromises.length > 0) compromises.push(`${m.product.name}: ${m.compromises.join("; ")}`);
  }
  void audit.log({
    logicalOrderId: orderId, type: "action.compare", actor: "agent",
    summary: `Compared ${matchA.product.name} vs ${matchB.product.name}`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["grounded_catalog_facts"],
  });
  return { kind: "compare", productA: matchA, productB: matchB, facts: { strengths, differences, compromises }, state: session.state };
}

function handleExplain(
  session: Session,
  requestedIds: string[],
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): { kind: "explain"; match: ProductMatch; explanation: string; state: OrderState } | { kind: "error"; message: string; state: OrderState } {
  const ranking = session.lastRanking;
  if (!ranking || ranking.matches.length === 0) {
    return { kind: "error", message: "No shortlist available to explain. Let me refine your search first.", state: session.state };
  }
  let target: ProductMatch | undefined;
  const ids = requestedIds.length > 0 ? requestedIds : [];
  if (ids.length > 0) {
    target = ranking.matches.find((m) => m.product.productId === ids[0]);
  } else {
    // "why this one?" / "why not X?" → try message-based product name extraction
    const messageProductIds = extractProductIdsFromMessage(session.message);
    if (messageProductIds.length > 0) {
      target = ranking.matches.find((m) => m.product.productId === messageProductIds[0]);
    }
    if (!target) target = ranking.matches[0]; // default: explain the top match
  }
  if (!target) {
    return { kind: "error", message: "That product is not in your current shortlist.", state: session.state };
  }
  const parts: string[] = [];
  parts.push(`${target.product.name} is a ${target.product.fit}-fit, ${target.product.cushioning}-cushioned ${target.product.useCase} shoe.`);
  if (target.reasons.length > 0) parts.push(`Strengths: ${target.reasons.join("; ")}.`);
  if (target.compromises.length > 0) parts.push(`Trade-offs: ${target.compromises.join("; ")}.`);
  parts.push(`Priced at ₹${(target.product.priceMinor / 100).toFixed(0)}, rated ${target.product.rating}/5, ships in ${target.product.deliveryLeadDays} day${target.product.deliveryLeadDays === 1 ? "" : "s"}.`);
  void audit.log({
    logicalOrderId: orderId, type: "action.explain", actor: "agent",
    summary: `Explained ${target.product.name}`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["grounded_catalog_facts"],
  });
  return { kind: "explain", match: target, explanation: parts.join(" "), state: session.state };
}

function handleSelect(
  session: Session,
  requestedIds: string[],
  corrections: string[],
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): { kind: "select"; productId: string; state: OrderState } | { kind: "error"; message: string; state: OrderState } {
  const productId = requestedIds[0];
  if (!productId) {
    return { kind: "error", message: "I couldn't identify which shoe you'd like to select.", state: session.state };
  }
  const product = SHOE_CATALOG.products.find((p) => p.productId === productId);
  if (!product) {
    return { kind: "error", message: `Unknown product: ${productId}.`, state: session.state };
  }
  const size = corrections.includes("size") ? session.intent.size : session.intent.size;
  const variant = product.variants.find((v) => v.size === size);
  if (!variant) {
    return { kind: "error", message: `${product.name} is not available in ${size ?? "your selected size"}.`, state: session.state };
  }
  if (variant.inStock <= 0) {
    return { kind: "error", message: `${product.name} in ${size} is out of stock.`, state: session.state };
  }
  session.dialogue.selectedProductId = productId;
  void audit.log({
    logicalOrderId: orderId, type: "action.select", actor: "agent",
    summary: `Selected ${product.name} ${size}`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["eligible_in_stock"],
  });
  return { kind: "select", productId, state: session.state };
}

/* ── AI-1 interpretation merge + apply (deterministic code authoritative) ── */

/**
 * Precedence policy between deterministic parsing and accepted LLM proposals:
 * 1. Deterministic action detection wins for compare/select/restart/explain/refine.
 * 2. For every constraint/preference field, a deterministic value wins over an
 *    LLM proposal for the same field; LLM proposals fill fields deterministic
 *    parsing left unset (after schema validation).
 * 3. Removals and corrections are unions, restricted to fields that currently
 *    exist in session intent.
 */
function mergeInterpretation(
  deterministic: StructuredInterpretation,
  outcome: InterpretationOutcome,
): StructuredInterpretation {
  const llm = outcome.interpretation;

  const action = deterministic.action !== "search" ? deterministic.action : llm.action;

  const hardByField = new Map<string, { value: string | number | boolean; evidence: string }>();
  for (const c of deterministic.proposedHardConstraints) hardByField.set(c.name, { value: c.value, evidence: c.evidence });
  for (const c of llm.proposedHardConstraints) {
    if (!hardByField.has(c.name)) hardByField.set(c.name, { value: c.value, evidence: c.evidence });
  }

  const softByField = new Map<string, { value: string | number; evidence: string }>();
  for (const p of deterministic.proposedSoftPreferences) softByField.set(p.name, { value: p.value, evidence: p.evidence });
  for (const p of llm.proposedSoftPreferences) {
    if (!softByField.has(p.name)) softByField.set(p.name, { value: p.value, evidence: p.evidence });
  }

  return {
    schemaVersion: llm.schemaVersion,
    action,
    proposedHardConstraints: [...hardByField.entries()].map(([name, v]) => ({ name: name as StructuredInterpretation["proposedHardConstraints"][number]["name"], value: v.value, evidence: v.evidence })),
    proposedSoftPreferences: [...softByField.entries()].map(([name, v]) => ({ name: name as StructuredInterpretation["proposedSoftPreferences"][number]["name"], value: v.value, evidence: v.evidence })),
    corrections: [...new Set([...deterministic.corrections, ...llm.corrections])],
    removals: [...new Set([...deterministic.removals, ...llm.removals])],
    ambiguities: llm.ambiguities.length > 0 ? llm.ambiguities : deterministic.ambiguities,
    confidence: llm.confidence,
    requestedProductIds: llm.requestedProductIds.length > 0 ? llm.requestedProductIds : deterministic.requestedProductIds,
  };
}

function applyInterpretation(session: Session, merged: StructuredInterpretation): void {
  for (const c of merged.proposedHardConstraints) {
    (session.intent as Record<string, unknown>)[c.name] = c.value;
  }
  for (const p of merged.proposedSoftPreferences) {
    (session.intent as Record<string, unknown>)[p.name] = p.value;
  }
  for (const removal of merged.removals) {
    if (removal in session.intent) delete (session.intent as Record<string, unknown>)[removal];
  }
}

function countApplied(merged: StructuredInterpretation): number {
  return merged.proposedHardConstraints.length + merged.proposedSoftPreferences.length + merged.removals.length;
}

const PRODUCT_NAME_ALIASES: Record<string, string[]> = {
  p_streak_4: ["streak 4", "streak4", "streak"],
  p_vista_max: ["max cushion", "vista max", "maxcushion"],
  p_stride_lite: ["stride lite", "stride"],
  p_trail_rock: ["trail rock"],
  p_gym_pace: ["gym pace"],
  p_casual_day: ["everyday", "casual day"],
};

function extractProductIdsFromMessage(message: string): string[] {
  const lower = message.toLowerCase();
  const found: string[] = [];
  for (const product of SHOE_CATALOG.products) {
    const aliases = PRODUCT_NAME_ALIASES[product.productId] ?? [product.name.toLowerCase()];
    for (const alias of aliases) {
      if (lower.includes(alias)) { found.push(product.productId); break; }
    }
  }
  return found.slice(0, 5);
}

function servicesReconcileHeld(
  orderId: string,
  session: Session,
  audit: ReturnType<typeof createAuditLedger>,
  webhookDedup: Map<string, string>,
): void {
  if (!session.heldWebhook) return;
  const held = session.heldWebhook;
  session.heldWebhook = undefined;
  webhookDedup.set(held.eventId, new Date().toISOString());
  void audit.log({
    logicalOrderId: orderId,
    type: "webhook.reconciled_after_client_verification",
    actor: "payment",
    summary: `Held webhook ${held.eventId} reconciled; order already verified on the Razorpay rail`,
    externalReferences: { eventId: held.eventId, paymentId: held.paymentId },
    decision: "allow",
    reasonCodes: ["out_of_order_webhook_reconciled", "rail_single_success"],
  });
}

function runFitScoreSpend(
  session: Session,
  resource: DemoMachineResource,
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): { mock: boolean; paymentIdentifier: string; txHash: string; network: string; amount: string } | undefined {
  const envelopeHash = intentDigest(session.intent);
  const paymentIdentifier = newId("pid");
  const outcome = runMachineSpend(resource, envelopeHash, paymentIdentifier);
  if (!outcome.ok || !outcome.settlement || !outcome.resource) {
    void audit.log({
      logicalOrderId: orderId,
      type: "machine.spend_failed",
      actor: "agent",
      summary: `Premium fit-score resource rejected payment: ${outcome.error ?? "unknown"}`,
      decision: "review",
      reasonCodes: ["x402_payment_rejected"],
    });
    return undefined;
  }
  session.machineSpend = {
    paymentIdentifier,
    settlementHash: outcome.settlement.transactionHash ?? "",
    fitScores: outcome.resource.scores,
  };
  void audit.log({
    logicalOrderId: orderId,
    type: "machine.paid_resource",
    actor: "agent",
    summary: `Paid ${outcome.resource.resourceName} (${outcome.settlement.amount} USDC) via x402 v2 on Solana Devnet — MOCK demo settlement`,
    externalReferences: {
      network: outcome.settlement.network,
      paymentIdentifier,
      txHash: outcome.settlement.transactionHash ?? "",
      payee: DEFAULT_MACHINE_SPEND.payeeWallet,
      mock: "true",
    },
    decision: "allow",
    reasonCodes: ["x402_mock_settlement_verified", "machine_tool_spend"],
  });
  return {
    mock: true,
    paymentIdentifier,
    txHash: outcome.settlement.transactionHash ?? "",
    network: outcome.settlement.network,
    amount: outcome.settlement.amount,
  };
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

async function composeShortlistMessage(
  session: Session,
  ranking: RankingResult,
  machineSpend: { mock: boolean; paymentIdentifier: string; txHash: string; network: string; amount: string } | undefined,
  llm: LlmProvider,
): Promise<string> {
  const best = ranking.matches[0];
  if (!best) return "No products satisfy your constraints with current stock.";
  const spendNote = machineSpend
    ? ` I spent ${machineSpend.amount} USDC via x402 v2 on Solana Devnet (${machineSpend.mock ? "MOCK demo settlement" : "live settlement"}, tx ${machineSpend.txHash.slice(0, 16)}…) on a premium wide-fit scoring pass — the fit scores below are grounded in that paid resource.`
    : "";
  if (llm.enabled) {
    const explanation = await llm.explainRecommendation({
      message: session.message,
      matches: ranking.matches.map(productMatchToExplainInput),
    });
    if (explanation) {
      return `${explanation}${spendNote}`;
    }
  }
  return `Here are your top ${ranking.matches.length} matches. Best under the stated evidence: ${best.product.name} (₹${(best.product.priceMinor / 100).toFixed(2)}, score ${best.score}).${spendNote}`;
}