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
import {
  buildDevnetToolSpendRequest,
  canonicalToolSpendRequestDigest,
  createAdapterRegistry,
  formatX402Amount,
  loadX402Config,
  razorpaySignature,
  type AdapterRegistry,
  type PaymentAttempt,
  type ToolSpendRequest,
  type VerificationResult,
  type X402DevnetConfig,
  type DevnetTransferEvidence,
  type TransferVerificationState,
} from "@agentready/payments";
import {
  createOperationCoordinator,
  MemoryOperationStore,
  type OperationCoordinator,
} from "@agentready/core";
import { intentDigest, SIZES, type ParsedIntent } from "./intent";
import { DEFAULT_MACHINE_SPEND, DemoMachineResource, runMachineSpend, type FitScore } from "./machine";
import type { DevnetMachineResource } from "@agentready/payments/devnet-machine";
import { createLlmProvider, productMatchToExplainInput, type LlmProvider } from "./llm";
import { deterministicInterpretation, interpretUserMessage, type InterpretationOutcome, type StructuredInterpretation } from "./interpreter";
import { createDialogueMemory, syncMemory, invalidateQuote, invalidateRecommendations, acknowledgeChange, nextClarification, type DialogueMemory } from "./dialogue";
import { renderWhyThisOne, renderComparison, renderCompromises, renderCheaper } from "./explain";

export type RecommendationBinding = {
  intentVersion: number;
  recommendationVersion: number;
  recommendationActionToken: string;
};

export type MachineSpendAttemptStatus =
  | "pending"
  | "settled"
  | "manual_reconciliation_required"
  | "rejected";

export type MachineSpendAttempt = {
  paymentIdentifier: string;
  requestDigest: string;
  spendingRequest: ToolSpendRequest;
  signedAttempt: string;
  status: MachineSpendAttemptStatus;
  retryable: boolean;
  lastError?: string;
};

export type MachineSpendAttemptSummary = Pick<
  MachineSpendAttempt,
  "paymentIdentifier" | "requestDigest" | "status" | "retryable"
>;

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
  machineSpendAttempt?: MachineSpendAttempt;
  machineSpend?: {
    paymentIdentifier: string;
    settlementHash: string;
    fitScores: FitScore[];
    requestDigest: string;
    network: string;
    asset: string;
    amount: string;
    payer: string;
    payee: string;
    feePayer: string;
    memoVerification: string;
    transferVerification: TransferVerificationState;
    transfer?: DevnetTransferEvidence;
    explorerUrl: string;
    settlementMode: "mock" | "devnet";
  };
  heldWebhook?: { eventId: string; paymentId: string; orderId: string };
  dialogue: DialogueMemory;
};

export type EnvelopeRecord = {
  envelope: CommerceEnvelope;
  digest: string;
  signature: string;
  issuedAt: string;
  recommendation: RecommendationBinding;
  intentDigest: string;
};

export type RespondResult =
  | { kind: "clarify"; message: string; questions: string[]; quickReplies: string[]; state: OrderState; parsedIntent?: ParsedIntent }
  | ({ kind: "shortlist"; message: string; matches: ProductMatch[]; fitScores?: FitScore[]; machineSpend?: { mock: boolean; paymentIdentifier: string; txHash: string; network: string; amount: string }; machineSpendAttempt?: MachineSpendAttemptSummary; state: OrderState; parsedIntent?: { size?: string; colour?: string; useCase?: string; maxAmountMinor?: number; mustBeReturnable?: boolean; distanceKm?: number; fit?: string; cushioning?: string } } & RecommendationBinding & { selectionRejected?: boolean; rejectedProductId?: string })
  | { kind: "error"; message: string; state: OrderState; matches?: ProductMatch[]; intentVersion?: number; recommendationVersion?: number; recommendationActionToken?: string; selectionRejected?: boolean; rejectedProductId?: string; parsedIntent?: { size?: string; colour?: string; useCase?: string; maxAmountMinor?: number; mustBeReturnable?: boolean; distanceKm?: number; fit?: string; cushioning?: string } }
  | { kind: "compare"; productA: ProductMatch; productB: ProductMatch; facts: { strengths: string[]; differences: string[]; compromises: string[] }; state: OrderState }
  | { kind: "explain"; match: ProductMatch; explanation: string; state: OrderState }
  | { kind: "cheaper"; currentBest: ProductMatch; cheaperOption: ProductMatch | null; message: string; state: OrderState }
  | ({ kind: "select"; productId: string; message: string; state: OrderState } & RecommendationBinding)
  | { kind: "restart"; state: OrderState };

export type AppServices = {
  createSession(operationId?: string): Session;
  respond(orderId: string, message: string, binding?: RecommendationBinding, operationId?: string): Promise<RespondResult>;
  buildQuote(orderId: string, productId: string, binding?: RecommendationBinding, operationId?: string): Promise<{ envelope: CommerceEnvelope; digest: string; signature: string; approvalEventId?: string; state: OrderState } & RecommendationBinding>;
  approve(orderId: string, digest: string, operationId?: string): Promise<{ ok: boolean; approvalEventId?: string; state: OrderState; error?: string }>;
  initiatePayment(orderId: string, rail: string, operationId?: string): Promise<{ ok: boolean; attempt?: PaymentAttempt; state: OrderState; error?: string; reasonCodes?: string[] }>;
  mockCapture(orderId: string): Promise<{ paymentId: string; signature: string; orderId: string }>;
  verifyPayment(orderId: string, externalOrderId: string, externalPaymentId: string, signature: string, operationId?: string): Promise<{ ok: boolean; state: OrderState; error?: string }>;
  fulfil(orderId: string, fail: boolean, operationId?: string): Promise<{ ok: boolean; state: OrderState; error?: string }>;
  compensate(orderId: string, operationId?: string): Promise<{ ok: boolean; state: OrderState; error?: string; refundId?: string }>;
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
  intentPatch(orderId: string, patch: { maxAmountMinor?: number; size?: string; colour?: string; useCase?: string; fit?: string; cushioning?: string; distanceKm?: number; mustBeReturnable?: boolean }, expectedIntentVersion: number): Promise<{ ok: boolean; state: OrderState; parsedIntent?: ParsedIntent; intentVersion?: number; matches?: ProductMatch[]; recommendationBinding?: RecommendationBinding; fitScores?: Record<string, { fitScore: number; note: string }>; error?: string; reasonCodes?: string[] }>;
  registry: AdapterRegistry;
  audit: ReturnType<typeof createAuditLedger>;
  coordinator: OperationCoordinator;
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
  const sessionOperations = new Map<string, Promise<unknown>>();
  const operationStore = new MemoryOperationStore();
  const coordinator = createOperationCoordinator(operationStore);

  function withSessionLock<T>(orderId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperations.get(orderId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    sessionOperations.set(orderId, current);
    return current.finally(() => {
      if (sessionOperations.get(orderId) === current) sessionOperations.delete(orderId);
    });
  }

  const services: AppServices = {
    registry,
    audit,
    coordinator,
    razorpayKeySecret,
    webhookSecret,
    isMock,
    razorpayMode,
    llm,

    createSession(operationId) {
      const logicalOrderId = newId("ord");
      const customerId = DEMO_CUSTOMER;

      if (operationId) {
        const idempotency = coordinator.begin(operationId, "session.create", { customerId }, logicalOrderId);
        if (idempotency.kind === "conflict") {
          throw new Error(`Operation ID conflict: ${operationId} was already used with a different request`);
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if (phase === "completed" && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as Session;
          }
          if (phase === "failed" || phase === "rejected") {
            throw new Error(idempotency.record.errorRef ?? `Operation ${phase}`);
          }
          throw new Error("Operation in progress");
        }
      }

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
      if (operationId) {
        coordinator.complete(operationId, "success", logicalOrderId, undefined, session);
      }
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

    async respond(orderId, message, selectionBinding, operationId) {
      return withSessionLock(orderId, async () => {
      const binding = selectionBinding ?? { intentVersion: 0, recommendationVersion: 0, recommendationActionToken: "" };
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "conversation.respond", {
          orderId,
          message,
          intentVersion: binding.intentVersion,
          recommendationVersion: binding.recommendationVersion,
          recommendationActionToken: binding.recommendationActionToken,
        }, orderId);
        if (idempotency.kind === "conflict") {
          return { kind: "error", message: `Operation ID conflict: ${operationId} was already used with a different request`, state: "DRAFT" } as RespondResult;
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if (phase === "completed" && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as RespondResult;
          }
          if (phase === "failed" || phase === "rejected") {
            return (idempotency.record.resultPayload as RespondResult) ?? { kind: "error", message: idempotency.record.errorRef ?? `Operation ${phase}`, state: "DRAFT" } as RespondResult;
          }
          return { kind: "error", message: "Operation in progress", state: "DRAFT" } as RespondResult;
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const errorResult: RespondResult = { kind: "error", message: "Unknown session. Start a new conversation.", state: "DRAFT" };
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, "Unknown session", errorResult);
        }
        return errorResult;
      }

      session.message = message;

      // ── AI-1 structured interpretation (deterministic code authoritative) ──
      const deterministic = deterministicInterpretation(message, session.intent);
      const outcome = await interpretUserMessage(message, session.intent, llm);
      const merged = mergeInterpretation(deterministic, outcome);
      const previousIntent = { ...session.intent };
      const previousEnvelope = envelopes.get(orderId);
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

      const materialChange = hasIntentChanged(previousIntent, session.intent);
      let quoteInvalidated = false;
      if (materialChange) {
        session.dialogue.intentVersion += 1;
        session.lastRanking = undefined;
        invalidateRecommendations(session.dialogue);
        invalidateQuote(session.dialogue);
        session.approvalEventId = undefined;
        session.approvedDigest = undefined;
        if (previousEnvelope) {
          envelopes.delete(orderId);
          quoteInvalidated = true;
          void audit.log({ logicalOrderId: orderId, type: "quote.invalidated", actor: "system",
            summary: `Quote ${previousEnvelope.digest.slice(0, 16)}… invalidated due to material intent change`,
            inputDigest: previousEnvelope.digest, outputDigest: intentDigest(session.intent), decision: "block",
            reasonCodes: ["material_change_refinement", "recommendation_result_invalidated"] });
        }
      }

      // ── Acknowledge corrections naturally ──
      const acknowledgement = materialChange ? acknowledgeChange(merged.corrections, merged.removals, session.intent) : null;

      // ── Route by action ──
      switch (merged.action) {
        case "restart":
          envelopes.delete(orderId);
          session.dialogue = createDialogueMemory();
          session.intent = {};
          session.lastRanking = undefined;
          session.approvalEventId = undefined;
          session.approvedDigest = undefined;
          return { kind: "restart", state: session.state };

        case "compare":
          return handleCompare(session, merged.requestedProductIds, audit, orderId);

        case "explain":
          return handleExplain(session, merged.requestedProductIds, audit, orderId);

        case "select":
          return handleSelect(session, merged.requestedProductIds, selectionBinding, audit, orderId);

        case "search":
        case "refine":
          break;
      }

      // ── Cheaper request: grounded response with actual product and savings ──
      if (/\bcheaper\b|\bcheapest\b|\blower\s+price\b|\bless\s+expensive\b/.test(message.toLowerCase())) {
        if (quoteInvalidated && session.state === "AWAITING_APPROVAL") setState(session, "QUOTED");
        return handleCheaper(session, audit, orderId, llm);
      }

      // A repeated constraint message is a no-op. Keep the server-issued
      // result binding stable instead of manufacturing a new ranking.
      const hasPendingMachineSpend = session.machineSpendAttempt?.status === "pending" && session.machineSpendAttempt.retryable;
      if (!materialChange && (merged.action === "search" || merged.action === "refine") && isCurrentRecommendation(session) && session.lastRanking?.ranked && !hasPendingMachineSpend) {
        const ranking = session.lastRanking!;
        const replyMessage = await composeShortlistMessage(session, ranking, undefined, llm, machineSpendAttemptSummary(session));
        syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), [], merged.action, message);
        const repeatResult: RespondResult = {
          kind: "shortlist",
          message: replyMessage,
          matches: ranking.matches,
          fitScores: session.machineSpend?.fitScores,
          machineSpendAttempt: machineSpendAttemptSummary(session),
          state: session.state,
          parsedIntent: { ...session.intent },
          ...recommendationBinding(session),
        };
        if (operationId) {
          coordinator.complete(operationId, "success", session.state, undefined, repeatResult);
        }
        return repeatResult;
      }

      // ── Search / Refine: rank products or ask clarification ──
      const canRank = session.state === "DRAFT" || session.state === "CLARIFYING" || session.state === "REAPPROVAL_REQUIRED" || session.state === "QUOTED" ||
        (session.state === "AWAITING_APPROVAL" && materialChange);
      if (!canRank) {
        const stateError: RespondResult = { kind: "error", message: `Current state ${session.state} does not accept new product messages.`, state: session.state };
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, `Current state ${session.state} does not accept new product messages.`, stateError);
        }
        return stateError;
      }

      const intent = buildPurchaseIntent(session);
      const ranking = rankProducts(intent, SHOE_CATALOG);
      recordRecommendation(session, ranking);

      if (!ranking.ranked) {
        setState(session, "CLARIFYING");
        const topMissing = nextClarification(session.intent, ranking.missing.map((m) => m.name));
        const allMissingNames = ranking.missing.map((m) => m.name);
        const quickReplies = ranking.missing.flatMap((m) => m.options ?? []);
        const replyMessage = composeClarification(session, allMissingNames);
        void audit.log({ logicalOrderId: orderId, type: "intent.clarification_requested", actor: "agent",
          summary: replyMessage, inputDigest: intentDigest(session.intent) });
        syncMemory(session.dialogue, session.intent, [], allMissingNames, "clarify", message);
        const clarifyResult: RespondResult = { kind: "clarify", message: replyMessage, questions: [topMissing ?? ""].filter(Boolean), quickReplies, state: session.state, parsedIntent: { ...session.intent } };
        if (operationId) {
          coordinator.complete(operationId, "success", session.state, undefined, clarifyResult);
        }
        return clarifyResult;
      }

      if (session.state === "AWAITING_APPROVAL" && quoteInvalidated) {
        setState(session, "QUOTED");
      } else if (session.state !== "AWAITING_APPROVAL" && session.state !== "REAPPROVAL_REQUIRED") {
        setState(session, "QUOTED");
      }

      // ── x402 fit-scoring spend policy ──
      // Only invoke when: (1) fit preference exists and could materially
      // distinguish candidates; (2) at least 2 eligible candidates remain;
      // (3) no duplicate spend on the same intent digest.
      const envelopeHash = intentDigest(session.intent);
      const hasExistingMachineSpendAttempt = Boolean(
        session.machineSpendAttempt && session.machineSpendAttempt.status !== "rejected",
      );
      const shouldSpend = session.intent.fit
        && !session.machineSpend
        && (
          session.machineSpendAttempt?.status === "pending"
          || (!hasExistingMachineSpendAttempt && ranking.matches.length >= 2 && !machineResource.hasProcessed(envelopeHash))
        );
      const machineSpend = shouldSpend
        ? await runFitScoreSpend(session, machineResource, audit, orderId) : undefined;
      const replyMessage = await composeShortlistMessage(session, ranking, machineSpend, llm, machineSpendAttemptSummary(session));
      void audit.log({ logicalOrderId: orderId, type: "intent.shortlist_ranked", actor: "agent",
        summary: `Ranked ${ranking.matches.length} products for ${intentDigest(session.intent)}`,
        inputDigest: intentDigest(session.intent) });

      syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), [], merged.action, message);

      const respondResult: RespondResult = {
        kind: "shortlist",
        message: (acknowledgement ? acknowledgement + " " : "") + replyMessage,
        matches: ranking.matches,
        fitScores: session.machineSpend?.fitScores,
        machineSpend: machineSpend ? { mock: machineSpend.mock, paymentIdentifier: machineSpend.paymentIdentifier, txHash: machineSpend.txHash, network: machineSpend.network, amount: machineSpend.amount } : undefined,
        machineSpendAttempt: machineSpendAttemptSummary(session),
        state: session.state,
        parsedIntent: { ...session.intent },
        ...recommendationBinding(session),
      };
      if (operationId) {
        coordinator.complete(operationId, "success", session.state, undefined, respondResult);
      }
      return respondResult;
      });
    },

    async buildQuote(orderId, productId, selectionBinding, operationId) {
      return withSessionLock(orderId, async () => {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "quote.build", { orderId, productId }, orderId);
        if (idempotency.kind === "conflict") {
          throw new Error(`Operation ID conflict: ${operationId} was already used with a different request`);
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if (phase === "completed" && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { envelope: CommerceEnvelope; digest: string; signature: string; approvalEventId?: string; state: OrderState } & RecommendationBinding;
          }
          if (phase === "failed" || phase === "rejected") {
            throw new Error(idempotency.record.errorRef ?? `Operation ${phase}`);
          }
          throw new Error("Operation in progress");
        }
      }
      const session = sessions.get(orderId);
      if (!session) throw new Error("Unknown session");

      const selection = validateCurrentSelection(session, productId, selectionBinding);
      if (!selection.ok) {
        throw new QuoteValidationError(selection.message, selection.ranking.matches, selection.binding, productId, selection.reasonCodes);
      }
      const { product, variant } = selection;
      const binding = selection.binding;
      const size = session.intent.size!;

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
      envelopes.set(orderId, {
        envelope,
        digest,
        signature,
        issuedAt: now.toISOString(),
        recommendation: binding,
        intentDigest: intentDigest(session.intent),
      });

      session.dialogue.quoteProductId = productId;
      session.dialogue.quoteValid = true;
      session.dialogue.quoteIntentVersion = binding.intentVersion;
      session.dialogue.quoteRecommendationVersion = binding.recommendationVersion;
      session.dialogue.quoteActionToken = binding.recommendationActionToken;
      setState(session, "AWAITING_APPROVAL");
      void audit.log({
        logicalOrderId: orderId,
        type: "quote.envelope_created",
        actor: "system",
        summary: `Envelope ${digest.slice(0, 16)}… for ${product.name} ${size} — ${formatMinor(total)}`,
        inputDigest: digest,
      });
      const quoteResult = {
        envelope,
        digest,
        signature,
        state: session.state,
        approvalEventId: session.approvalEventId,
        ...binding,
      };
      if (operationId) {
        coordinator.complete(operationId, "success", digest, undefined, quoteResult);
      }
      return quoteResult;
      });
    },

    async approve(orderId, digest, operationId) {
      return withSessionLock(orderId, async () => {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "approval.grant", { orderId, digest }, orderId);
        if (idempotency.kind === "conflict") {
          return { ok: false, state: "DRAFT", error: `Operation ID conflict: ${operationId} was already used with a different request` };
        }
        if (idempotency.kind === "replay" && idempotency.record.phase === "completed" && idempotency.record.resultPayload !== undefined) {
          return idempotency.record.resultPayload as { ok: boolean; approvalEventId?: string; state: OrderState; error?: string };
        }
        if (idempotency.kind === "replay" && idempotency.record.phase !== "completed") {
          if ((idempotency.record.phase === "failed" || idempotency.record.phase === "rejected") && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; approvalEventId?: string; state: OrderState; error?: string };
          }
          const session = sessions.get(orderId);
          return { ok: false, state: session?.state ?? "DRAFT", error: "Operation in progress" };
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const r = { ok: false, state: "DRAFT" as OrderState, error: "Unknown session" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "Unknown session", r);
        return r;
      }
      const record = envelopes.get(orderId);
      if (!record) {
        const r = { ok: false, state: session.state, error: "No envelope to approve" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "No envelope to approve", r);
        return r;
      }

      if (!session.dialogue.quoteValid || !isCurrentRecommendation(session) ||
        !sameRecommendationBinding(record.recommendation, recommendationBinding(session)) ||
        record.intentDigest !== intentDigest(session.intent)) {
        const r = { ok: false, state: session.state, error: "This quote is no longer active for the current intent" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }

      if (session.approvalEventId && session.approvedDigest === digest) {
        const r = { ok: true, approvalEventId: session.approvalEventId, state: session.state };
        if (operationId) coordinator.complete(operationId, "success", session.approvalEventId, undefined, r);
        return r;
      }

      if (record.digest !== digest) {
        const r = { ok: false, state: session.state, error: "Digest mismatch: approval must bind to the exact envelope hash" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }
      if (record.envelope.expiresAt < new Date().toISOString()) {
        setState(session, "EXPIRED");
        const r = { ok: false, state: session.state, error: "Quote expired" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
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
      const approveResult = { ok: true, approvalEventId, state: session.state } as const;
      if (operationId) {
        coordinator.complete(operationId, "success", approvalEventId, undefined, approveResult);
      }
      return approveResult;
      });
    },

    async initiatePayment(orderId, rail, operationId) {
      return withSessionLock(orderId, async () => {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "payment.initiate", { orderId, rail }, orderId);
        if (idempotency.kind === "conflict") {
          return { ok: false, state: "DRAFT", error: `Operation ID conflict: ${operationId} was already used with a different request`, reasonCodes: ["operation_conflict"] };
        }
        if (idempotency.kind === "replay" && idempotency.record.phase === "completed" && idempotency.record.resultPayload !== undefined) {
          return idempotency.record.resultPayload as { ok: boolean; attempt?: PaymentAttempt; state: OrderState; error?: string; reasonCodes?: string[] };
        }
        if (idempotency.kind === "replay" && idempotency.record.phase !== "completed") {
          if ((idempotency.record.phase === "failed" || idempotency.record.phase === "rejected") && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; attempt?: PaymentAttempt; state: OrderState; error?: string; reasonCodes?: string[] };
          }
          const session = sessions.get(orderId);
          return { ok: false, state: session?.state ?? "DRAFT", error: "Operation in progress", reasonCodes: ["operation_pending"] };
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const r = { ok: false, state: "DRAFT" as OrderState, error: "Unknown session" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "Unknown session", r);
        return r;
      }
      const record = envelopes.get(orderId);
      if (!record) {
        const r = { ok: false, state: session.state, error: "No envelope" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "No envelope", r);
        return r;
      }

      if (!session.dialogue.quoteValid || !isCurrentRecommendation(session) ||
        !sameRecommendationBinding(record.recommendation, recommendationBinding(session)) ||
        record.intentDigest !== intentDigest(session.intent)) {
        const r = {
          ok: false,
          state: session.state,
          error: "Payment blocked: this quote is no longer active for the current intent",
          reasonCodes: ["quote_invalidated"],
        };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }

      if (session.state === "PAID_VERIFIED" || session.state === "FULFILMENT_PENDING" || session.state === "FULFILLED") {
        const r = { ok: false, state: session.state, error: "This order already has a successful payment; new rail initiation is rejected." };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
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
        const r = { ok: false, state: session.state, error: `Policy blocked payment: ${verdict.reasonCodes.join(", ")}`, reasonCodes: verdict.reasonCodes };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }

      if (record.envelope.totalMinor < 100) {
        const r = {
          ok: false,
          state: session.state,
          error: "Order amount is below Razorpay's 100 paise minimum",
          reasonCodes: ["amount_below_minimum"],
        };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
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
        const r = { ok: true, attempt, state: session.state };
        if (operationId) coordinator.complete(operationId, "success", attempt.externalOrderId ?? undefined, undefined, r);
        return r;
      }

      const adapter = registry.get(rail as "razorpay_checkout");
      if (!adapter) {
        const r = { ok: false, state: session.state, error: `No adapter for rail ${rail}` };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }

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
        const payResult = { ok: true, attempt, state: session.state } as const;
        if (operationId) {
          coordinator.complete(operationId, "success", attempt.externalOrderId ?? undefined, undefined, payResult);
        }
        return payResult;
      } catch (error) {
        setState(session, "PAYMENT_FAILED");
        void audit.log({
          logicalOrderId: orderId,
          type: "payment.initiate_failed",
          actor: "payment",
          summary: `Order creation failed: ${error instanceof Error ? error.message : String(error)}`,
          decision: "review",
        });
        const failResult = { ok: false, state: session.state, error: error instanceof Error ? error.message : String(error) } as const;
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, error instanceof Error ? error.message : String(error), failResult);
        }
        return failResult;
      }
      });
    },

    async mockCapture(orderId) {
      const session = sessions.get(orderId);
      if (!session || !session.externalOrderId) throw new Error("No initiated order");
      const paymentId = `pay_MOCK_${session.externalOrderId}_${Date.now()}`;
      const signature = razorpaySignature(razorpayKeySecret, `${session.externalOrderId}|${paymentId}`);
      return { paymentId, signature, orderId: session.externalOrderId };
    },

    async verifyPayment(orderId, externalOrderId, externalPaymentId, signature, operationId) {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "payment.verify", { orderId, externalOrderId, externalPaymentId }, orderId);
        if (idempotency.kind === "conflict") {
          return { ok: false, state: "DRAFT", error: `Operation ID conflict: ${operationId} was already used with a different request` };
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if ((phase === "completed" || phase === "failed" || phase === "rejected") && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; state: OrderState; error?: string };
          }
          return { ok: false, state: "DRAFT", error: "Operation in progress" };
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const r = { ok: false, state: "DRAFT" as OrderState, error: "Unknown session" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "Unknown session", r);
        return r;
      }
      const record = envelopes.get(orderId);
      if (!record) {
        const r = { ok: false, state: session.state, error: "No envelope" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "No envelope", r);
        return r;
      }

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
        const r = { ok: false, state: session.state, error: "Submitted Razorpay order does not match this session's order" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }

      if (session.verification?.verified) {
        const r = { ok: true, state: session.state };
        if (operationId) coordinator.complete(operationId, "success", externalPaymentId, undefined, r);
        return r;
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
        const failResult = { ok: false, state: session.state, error: result.reason ?? "Verification failed" } as const;
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, result.reason ?? "Verification failed", failResult);
        }
        return failResult;
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
        const bindFailResult = { ok: false, state: session.state, error: `Payment binding rejected: ${bindingFailures.join("; ")}` } as const;
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, `Payment binding rejected: ${bindingFailures.join("; ")}`, bindFailResult);
        }
        return bindFailResult;
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

      const verifyResult = { ok: true, state: session.state } as const;
      if (operationId) {
        coordinator.complete(operationId, "success", externalPaymentId, undefined, verifyResult);
      }
      return verifyResult;
    },

    async fulfil(orderId, fail, operationId) {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "fulfilment.complete", { orderId, fail }, orderId);
        if (idempotency.kind === "conflict") {
          return { ok: false, state: "DRAFT", error: `Operation ID conflict: ${operationId} was already used with a different request` };
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if (phase === "completed" && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; state: OrderState; error?: string };
          }
          if ((phase === "failed" || phase === "rejected") && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; state: OrderState; error?: string };
          }
          const session = sessions.get(orderId);
          return { ok: false, state: session?.state ?? "DRAFT", error: "Operation in progress" };
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const r = { ok: false, state: "DRAFT" as OrderState, error: "Unknown session" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "Unknown session", r);
        return r;
      }
      if (session.state !== "PAID_VERIFIED") {
        const r = { ok: false, state: session.state, error: `Fulfilment requires PAID_VERIFIED, current state ${session.state}` };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
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
        const fulfilFailResult = { ok: false, state: session.state, error: "Simulated fulfilment failure: inventory unavailable" } as const;
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, "Simulated fulfilment failure: inventory unavailable", fulfilFailResult);
        }
        return fulfilFailResult;
      }
      setState(session, "FULFILLED");
      void audit.log({
        logicalOrderId: orderId,
        type: "fulfilment.completed",
        actor: "merchant",
        summary: "Order shipped",
        decision: "allow",
      });
      const fulfilSuccessResult = { ok: true, state: session.state } as const;
      if (operationId) {
        coordinator.complete(operationId, "success", orderId, undefined, fulfilSuccessResult);
      }
      return fulfilSuccessResult;
    },

    async compensate(orderId, operationId) {
      if (operationId) {
        const idempotency = coordinator.begin(operationId, "compensation.refund", { orderId }, orderId);
        if (idempotency.kind === "conflict") {
          return { ok: false, state: "DRAFT", error: `Operation ID conflict: ${operationId} was already used with a different request` };
        }
        if (idempotency.kind === "replay") {
          const phase = idempotency.record.phase;
          if (phase === "completed" && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; state: OrderState; error?: string; refundId?: string };
          }
          if ((phase === "failed" || phase === "rejected") && idempotency.record.resultPayload !== undefined) {
            return idempotency.record.resultPayload as { ok: boolean; state: OrderState; error?: string; refundId?: string };
          }
          const session = sessions.get(orderId);
          return { ok: false, state: session?.state ?? "DRAFT", error: "Operation in progress" };
        }
      }
      const session = sessions.get(orderId);
      if (!session) {
        const r = { ok: false, state: "DRAFT" as OrderState, error: "Unknown session" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "Unknown session", r);
        return r;
      }
      if (session.state !== "FULFILMENT_FAILED" && session.state !== "COMPENSATION_PENDING") {
        const r = { ok: false, state: session.state, error: `Compensation requires FULFILMENT_FAILED, current state ${session.state}` };
        if (operationId) coordinator.complete(operationId, "failure", undefined, r.error, r);
        return r;
      }
      const record = envelopes.get(orderId);
      if (!record) {
        const r = { ok: false, state: session.state, error: "No envelope" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "No envelope", r);
        return r;
      }
      if (!session.externalPaymentId) {
        const r = { ok: false, state: session.state, error: "No external payment id" };
        if (operationId) coordinator.complete(operationId, "failure", undefined, "No external payment id", r);
        return r;
      }

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
        const refundResult = { ok: true, state: session.state, refundId: result.refundId } as const;
        if (operationId) {
          coordinator.complete(operationId, "success", result.refundId ?? undefined, undefined, refundResult);
        }
        return refundResult;
      } catch (error) {
        setState(session, "MANUAL_REVIEW");
        void audit.log({
          logicalOrderId: orderId,
          type: "compensation.manual_review",
          actor: "merchant",
          summary: `Refund failed; routed to manual review: ${error instanceof Error ? error.message : String(error)}`,
          decision: "review",
        });
        const refundFailResult = { ok: false, state: session.state, error: error instanceof Error ? error.message : String(error) } as const;
        if (operationId) {
          coordinator.complete(operationId, "failure", undefined, error instanceof Error ? error.message : String(error), refundFailResult);
        }
        return refundFailResult;
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
       envelopes.set(orderId, {
         envelope: candidate,
         digest: newDigest,
         signature: newSignature,
         issuedAt: new Date().toISOString(),
         recommendation: record.recommendation,
         intentDigest: record.intentDigest,
       });
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
      coordinator.clear();
      machineResource.reset();
      void audit.log({
        logicalOrderId: "system",
        type: "system.reset",
        actor: "system",
        summary: "Fresh-demo reset: all sessions, envelopes, webhook dedup and machine resource state cleared",
      });
    },

    async intentPatch(orderId, patch, expectedIntentVersion) {
      return withSessionLock(orderId, async () => {
        const session = sessions.get(orderId);
        if (!session) return { ok: false, state: "DRAFT", error: "Unknown session" };

        // Validate intent version
        if (session.dialogue.intentVersion !== expectedIntentVersion) {
          return { ok: false, state: session.state, error: "Intent version mismatch. Please refresh.", reasonCodes: ["version_mismatch"] };
        }

        // Validate allowed fields and types
        const allowedFields: Record<string, string> = {
          maxAmountMinor: "number",
          size: "string",
          colour: "string",
          useCase: "string",
          fit: "string",
          cushioning: "string",
          distanceKm: "number",
          mustBeReturnable: "boolean",
        };
        for (const [key, expectedType] of Object.entries(patch)) {
          if (!(key in allowedFields)) {
            return { ok: false, state: session.state, error: `Unknown intent field: ${key}`, reasonCodes: ["invalid_field"] };
          }
          if (typeof patch[key as keyof typeof patch] !== allowedFields[key]) {
            return { ok: false, state: session.state, error: `Invalid type for ${key}: expected ${allowedFields[key]}`, reasonCodes: ["invalid_type"] };
          }
        }

        // Validate ranges
        if (patch.maxAmountMinor !== undefined) {
          if (patch.maxAmountMinor < 10_00 || patch.maxAmountMinor > 10_000_00) {
            return { ok: false, state: session.state, error: "Budget must be between ₹100 and ₹1,00,000", reasonCodes: ["out_of_range"] };
          }
        }
        if (patch.size !== undefined) {
          if (patch.size !== "" && patch.size !== null && !SIZES.includes(patch.size)) {
            return { ok: false, state: session.state, error: `Invalid size: ${patch.size}`, reasonCodes: ["invalid_size"] };
          }
        }
        if (patch.colour !== undefined) {
          const validColours = ["black", "white", "grey", "navy", "blue", "red"];
          if (!validColours.includes(patch.colour)) {
            return { ok: false, state: session.state, error: `Invalid colour: ${patch.colour}`, reasonCodes: ["invalid_colour"] };
          }
        }
        if (patch.useCase !== undefined) {
          const validUseCases = ["road", "trail", "gym", "casual"];
          if (!validUseCases.includes(patch.useCase)) {
            return { ok: false, state: session.state, error: `Invalid use case: ${patch.useCase}`, reasonCodes: ["invalid_use_case"] };
          }
        }

        // Capture previous state for invalidation logic
        const previousIntent = { ...session.intent };
        const previousEnvelope = envelopes.get(orderId);

        // Apply the patch to session intent (empty/null clears the field)
        if (patch.maxAmountMinor !== undefined) session.intent.maxAmountMinor = patch.maxAmountMinor;
        if (patch.size !== undefined) {
          if (patch.size === "" || patch.size === null) {
            delete (session.intent as Record<string, unknown>).size;
          } else {
            session.intent.size = patch.size;
          }
        }
        if (patch.colour !== undefined) {
          if (patch.colour === "" || patch.colour === null) {
            delete (session.intent as Record<string, unknown>).colour;
          } else {
            session.intent.colour = patch.colour;
          }
        }
        if (patch.useCase !== undefined) {
          if (patch.useCase === "" || patch.useCase === null) {
            delete (session.intent as Record<string, unknown>).useCase;
          } else {
            session.intent.useCase = patch.useCase;
          }
        }
        if (patch.fit !== undefined) {
          if (patch.fit === "" || patch.fit === null) {
            delete (session.intent as Record<string, unknown>).fit;
          } else {
            session.intent.fit = patch.fit;
          }
        }
        if (patch.cushioning !== undefined) {
          if (patch.cushioning === "" || patch.cushioning === null) {
            delete (session.intent as Record<string, unknown>).cushioning;
          } else {
            session.intent.cushioning = patch.cushioning;
          }
        }
        if (patch.distanceKm !== undefined) {
          if (patch.distanceKm === 0 || patch.distanceKm === null) {
            delete (session.intent as Record<string, unknown>).distanceKm;
          } else {
            session.intent.distanceKm = patch.distanceKm;
          }
        }
        if (patch.mustBeReturnable !== undefined) {
          if (!patch.mustBeReturnable) {
            delete (session.intent as Record<string, unknown>).mustBeReturnable;
          } else {
            session.intent.mustBeReturnable = patch.mustBeReturnable;
          }
        }

        // Detect material change and invalidate
        const materialChange = hasIntentChanged(previousIntent, session.intent);
        if (materialChange) {
          session.dialogue.intentVersion += 1;
          session.lastRanking = undefined;
          invalidateRecommendations(session.dialogue);
          invalidateQuote(session.dialogue);
          session.approvalEventId = undefined;
          session.approvedDigest = undefined;
          if (previousEnvelope) {
            envelopes.delete(orderId);
            void audit.log({
              logicalOrderId: orderId,
              type: "quote.invalidated",
              actor: "system",
              summary: `Quote ${previousEnvelope.digest.slice(0, 16)}… invalidated due to intent patch`,
              inputDigest: previousEnvelope.digest,
              outputDigest: intentDigest(session.intent),
              decision: "block",
              reasonCodes: ["intent_patch", "material_change_refinement"],
            });
          }
        }

        // Re-rank products with the new intent
        if (session.state === "AWAITING_APPROVAL" && materialChange) {
          setState(session, "QUOTED");
        } else if (session.state === "APPROVED" && materialChange) {
          setState(session, "REAPPROVAL_REQUIRED");
        } else if (session.state !== "AWAITING_APPROVAL" && session.state !== "REAPPROVAL_REQUIRED" && session.state !== "DRAFT" && session.state !== "CLARIFYING" && session.state !== "APPROVED") {
          setState(session, "QUOTED");
        }

        const intent = buildPurchaseIntent(session);
        const ranking = rankProducts(intent, SHOE_CATALOG);
        recordRecommendation(session, ranking);
        syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), ranking.missing.map((m) => m.name), "intent_patch", Object.keys(patch).join(","));

        if (!ranking.ranked) {
          // State may not allow CLARIFYING transition; set directly
          session.state = "CLARIFYING";
        } else if (session.state === "CLARIFYING") {
          setState(session, "QUOTED");
        }

        void audit.log({
          logicalOrderId: orderId,
          type: "intent.patched",
          actor: "customer",
          summary: `Intent patched: ${Object.keys(patch).join(", ")}`,
          inputDigest: intentDigest(session.intent),
          decision: "allow",
          reasonCodes: ["intent_patch_applied"],
        });

        const freshBinding = recommendationBinding(session);
        const fitScoreMap = session.machineSpend?.fitScores
          ? Object.fromEntries(session.machineSpend.fitScores.map((f) => [f.productId, { fitScore: f.fitScore, note: f.note }]))
          : undefined;

        return {
          ok: true,
          state: session.state,
          parsedIntent: { ...session.intent },
          intentVersion: session.dialogue.intentVersion,
          matches: ranking.ranked ? ranking.matches : [],
          recommendationBinding: freshBinding,
          fitScores: fitScoreMap,
        };
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

export class QuoteValidationError extends Error {
  constructor(
    message: string,
    readonly matches: ProductMatch[],
    readonly binding: RecommendationBinding,
    readonly rejectedProductId: string,
    readonly reasonCodes: string[],
  ) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

type CurrentRecommendation = {
  ranking: RankingResult;
  binding: RecommendationBinding;
};

type SelectionValidation =
  | {
      ok: true;
      product: (typeof SHOE_CATALOG.products)[number];
      variant: (typeof SHOE_CATALOG.products)[number]["variants"][number];
      binding: RecommendationBinding;
    }
  | {
      ok: false;
      message: string;
      ranking: RankingResult;
      binding: RecommendationBinding;
      reasonCodes: string[];
    };

function hasIntentChanged(before: ParsedIntent, after: ParsedIntent): boolean {
  const fields: (keyof ParsedIntent)[] = [
    "size",
    "colour",
    "useCase",
    "maxAmountMinor",
    "mustBeReturnable",
    "deliverBy",
    "distanceKm",
    "fit",
    "cushioning",
  ];
  return fields.some((field) => before[field] !== after[field]);
}

function buildPurchaseIntent(session: Session): PurchaseIntent {
  return {
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
}

function recordRecommendation(session: Session, ranking: RankingResult): void {
  session.lastRanking = ranking;
  session.dialogue.recommendationVersion += 1;
  session.dialogue.recommendationIntentVersion = session.dialogue.intentVersion;
  session.dialogue.recommendationActionToken = newId("rec");
}

function recommendationBinding(session: Session): RecommendationBinding {
  if (!isCurrentRecommendation(session)) {
    throw new Error("No current recommendation result");
  }
  return {
    intentVersion: session.dialogue.intentVersion,
    recommendationVersion: session.dialogue.recommendationVersion,
    recommendationActionToken: session.dialogue.recommendationActionToken!,
  };
}

function isCurrentRecommendation(session: Session): boolean {
  return Boolean(
    session.lastRanking &&
    session.dialogue.recommendationVersion > 0 &&
    session.dialogue.recommendationIntentVersion === session.dialogue.intentVersion &&
    session.dialogue.recommendationActionToken,
  );
}

function sameRecommendationBinding(a: RecommendationBinding, b: RecommendationBinding): boolean {
  return a.intentVersion === b.intentVersion &&
    a.recommendationVersion === b.recommendationVersion &&
    a.recommendationActionToken === b.recommendationActionToken;
}

function currentRecommendation(session: Session): CurrentRecommendation {
  if (!isCurrentRecommendation(session)) {
    const ranking = rankProducts(buildPurchaseIntent(session), SHOE_CATALOG);
    recordRecommendation(session, ranking);
    syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), ranking.missing.map((m) => m.name), "refresh", "");
  }
  return { ranking: session.lastRanking!, binding: recommendationBinding(session) };
}

function budgetLabel(maxAmountMinor: number): string {
  return `₹${(maxAmountMinor / 100).toLocaleString("en-IN")}`;
}

function validateCurrentSelection(
  session: Session,
  productId: string,
  suppliedBinding?: RecommendationBinding,
): SelectionValidation {
  const current = currentRecommendation(session);
  const product = SHOE_CATALOG.products.find((candidate) => candidate.productId === productId);
  const maxAmountMinor = session.intent.maxAmountMinor ?? 1_000_000;
  const bindingMatches = !suppliedBinding || sameRecommendationBinding(suppliedBinding, current.binding);

  if (!product) {
    return {
      ok: false,
      message: `Unknown product: ${productId}. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["unknown_product"],
    };
  }

  const variant = session.intent.size
    ? product.variants.find((candidate) => candidate.size === session.intent.size)
    : undefined;
  const exceedsBudget = product.priceMinor > maxAmountMinor;
  if (exceedsBudget) {
    return {
      ok: false,
      message: `${product.name} no longer fits your ${budgetLabel(maxAmountMinor)} budget. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["budget_exceeded", ...(bindingMatches ? [] : ["stale_recommendation"])],
    };
  }
  if (!bindingMatches) {
    return {
      ok: false,
      message: `${product.name} is from an older recommendation. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["stale_recommendation", "recommendation_version_mismatch"],
    };
  }
  if (!session.intent.size) {
    return {
      ok: false,
      message: "Choose a size before selecting a shoe. I refreshed your options.",
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["size_required"],
    };
  }
  if (!variant) {
    return {
      ok: false,
      message: `${product.name} is not available in ${session.intent.size}. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["size_unavailable"],
    };
  }
  if (variant.inStock <= 0) {
    return {
      ok: false,
      message: `${product.name} in ${session.intent.size} is out of stock. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["out_of_stock"],
    };
  }
  if (!current.ranking.matches.some((match) => match.product.productId === productId) ||
    !session.dialogue.shownProductIds.includes(productId)) {
    return {
      ok: false,
      message: `${product.name} is not in your current eligible recommendations. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["not_current_recommendation"],
    };
  }
  const match = current.ranking.matches.find((candidate) => candidate.product.productId === productId)!;
  if (match.eligibility.rejectionReasons.length > 0 ||
    !match.eligibility.withinBudget || !match.eligibility.sizeAvailable ||
    !match.eligibility.inStock || !match.eligibility.returnable || !match.eligibility.deliveryMet) {
    return {
      ok: false,
      message: `${product.name} no longer satisfies your current requirements. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["eligibility_failed"],
    };
  }
  if (session.intent.colour && !product.colour.includes(session.intent.colour)) {
    return {
      ok: false,
      message: `${product.name} does not match your requested colour. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["colour_constraint_failed"],
    };
  }
  if (session.intent.mustBeReturnable && !product.returnable) {
    return {
      ok: false,
      message: `${product.name} is not returnable as required. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["returnability_constraint_failed"],
    };
  }
  if (session.intent.deliverBy) {
    const delivery = estimateShipping(product.deliveryLeadDays, new Date().toISOString());
    if (delivery.deliverBy > session.intent.deliverBy) {
      return {
        ok: false,
        message: `${product.name} cannot meet your delivery deadline. I refreshed your options.`,
        ranking: current.ranking,
        binding: current.binding,
        reasonCodes: ["delivery_constraint_failed"],
      };
    }
  }
  if (product.category !== "running_shoes" || product.currency !== "INR") {
    return {
      ok: false,
      message: `${product.name} is not a valid RunVista product. I refreshed your options.`,
      ranking: current.ranking,
      binding: current.binding,
      reasonCodes: ["catalog_identity_failed"],
    };
  }

  return { ok: true, product, variant, binding: current.binding };
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
  const { strengths, differences, compromises } = renderComparison(matchA, matchB);
  void audit.log({
    logicalOrderId: orderId, type: "action.compare", actor: "agent",
    summary: `Compared ${matchA.product.name} (${matchA.scoreNormalized}/100) vs ${matchB.product.name} (${matchB.scoreNormalized}/100)`,
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
    const messageProductIds = extractProductIdsFromMessage(session.message);
    if (messageProductIds.length > 0) {
      target = ranking.matches.find((m) => m.product.productId === messageProductIds[0]);
    }
    if (!target) target = ranking.matches[0];
  }
  if (!target) {
    return { kind: "error", message: "That product is not in your current shortlist.", state: session.state };
  }
  const explanation = renderWhyThisOne(target, session.intent.maxAmountMinor);
  void audit.log({
    logicalOrderId: orderId, type: "action.explain", actor: "agent",
    summary: `Explained ${target.product.name} (${target.scoreNormalized}/100, ${target.role})`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["grounded_catalog_facts"],
  });
  return { kind: "explain", match: target, explanation, state: session.state };
}

function handleSelect(
  session: Session,
  requestedIds: string[],
  selectionBinding: RecommendationBinding | undefined,
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): RespondResult {
  const productId = requestedIds[0];
  if (!productId) {
    return { kind: "error", message: "I couldn't identify which shoe you'd like to select.", state: session.state };
  }

  const selection = validateCurrentSelection(session, productId, selectionBinding);
  if (!selection.ok) {
    void audit.log({
      logicalOrderId: orderId,
      type: "action.select_rejected",
      actor: "policy",
      summary: `Selection rejected for ${productId}: ${selection.message}`,
      inputDigest: intentDigest(session.intent),
      decision: "block",
      reasonCodes: selection.reasonCodes,
    });
    return {
      kind: "error",
      message: selection.message,
      state: session.state,
      matches: selection.ranking.matches,
      ...selection.binding,
      selectionRejected: true,
      rejectedProductId: productId,
      parsedIntent: { ...session.intent },
    };
  }

  const { product, variant, binding } = selection;
  session.dialogue.selectedProductId = productId;
  void audit.log({
    logicalOrderId: orderId, type: "action.select", actor: "agent",
    summary: `Selected ${product.name} ${variant.size}`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["eligible_in_stock"],
  });
  return { kind: "select", productId, message: `Selected ${product.name} ${variant.size}.`, state: session.state, ...binding };
}

function handleCheaper(
  session: Session,
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
  llm: LlmProvider,
): { kind: "cheaper"; currentBest: ProductMatch; cheaperOption: ProductMatch | null; message: string; state: OrderState } {
  let ranking = session.lastRanking;
  if (!ranking || !isCurrentRecommendation(session)) {
    ranking = rankProducts(buildPurchaseIntent(session), SHOE_CATALOG);
    recordRecommendation(session, ranking);
    syncMemory(session.dialogue, session.intent, ranking.matches.map((m) => m.product.productId), ranking.missing.map((m) => m.name), "refine", session.message);
  }
  if (!ranking || ranking.matches.length === 0) {
    return { kind: "cheaper", currentBest: { product: SHOE_CATALOG.products[0]!, score: 0, scoreNormalized: 0, role: "none", roleJustification: "", matchedRequirements: [], matchedPreferences: [], compromises: [], eligibility: { withinBudget: false, sizeAvailable: false, inStock: false, returnable: false, deliveryMet: false, rejectionReasons: [] }, colourMatched: false }, cheaperOption: null, message: "No products available to compare against.", state: session.state };
  }

  const currentBest = ranking.matches[0]!;
  const currentBudget = session.intent.maxAmountMinor ?? 500_000;
  const reducedBudget = Math.max(10_000, Math.round(currentBudget * 0.8));

  // Re-rank with reduced budget to find cheaper options
  const intent: PurchaseIntent = {
    merchantId: SHOE_CATALOG.merchantId,
    category: "running_shoes",
    hardConstraints: {
      maxAmountMinor: reducedBudget,
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

  const cheaperRanking = rankProducts(intent, SHOE_CATALOG);
  const cheaperOption = cheaperRanking.matches.find((m) => m.product.productId !== currentBest.product.productId) ?? null;

  const message = renderCheaper(currentBest, cheaperOption, reducedBudget);

  void audit.log({
    logicalOrderId: orderId, type: "action.cheaper", actor: "agent",
    summary: `Cheaper search: budget reduced from ₹${(currentBudget / 100).toLocaleString("en-IN")} to ₹${(reducedBudget / 100).toLocaleString("en-IN")}. ${cheaperOption ? `Found ${cheaperOption.product.name} at ₹${(cheaperOption.product.priceMinor / 100).toLocaleString("en-IN")}` : "No eligible cheaper option found"}.`,
    inputDigest: intentDigest(session.intent), decision: "allow", reasonCodes: ["grounded_catalog_facts"],
  });

  return { kind: "cheaper", currentBest, cheaperOption, message, state: session.state };
}

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

async function runFitScoreSpend(
  session: Session,
  resource: DemoMachineResource,
  audit: ReturnType<typeof createAuditLedger>,
  orderId: string,
): Promise<{ mock: boolean; paymentIdentifier: string; txHash: string; network: string; amount: string } | undefined> {
  const x402Config = loadX402Config();
  const mode = x402Config.mode;

  if (mode === "devnet") {
    const devnetConfig = x402Config as X402DevnetConfig;
    let devnetResource: DevnetMachineResource;
    try {
      const machine = await import("./machine");
      devnetResource = machine.getDevnetMachineResource();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      void audit.log({
        logicalOrderId: orderId,
        type: "machine.spend_failed",
        actor: "agent",
        summary: `Premium fit-score devnet resource unavailable: ${errorMsg}`,
        decision: "review",
        reasonCodes: ["x402_store_unavailable"],
      });
      return undefined;
    }
    const currentRequest = buildDevnetToolSpendRequest(devnetConfig, orderId, session.dialogue.intentVersion);
    const currentDigest = canonicalToolSpendRequestDigest(currentRequest);

    // Durable source of truth. session.machineSpendAttempt below is a UI/policy
    // cache mirror only — settlement decisions always re-read the store.
    const storedActive = await devnetResource.findActiveAttempt(orderId, session.dialogue.intentVersion);
    const existingAttempt = storedActive
      ? {
          paymentIdentifier: storedActive.callerPaymentId ?? "",
          requestDigest: storedActive.requestDigest,
          spendingRequest: { ...currentRequest },
          signedAttempt: storedActive.signedPayloadEnc
            ? await devnetResource.decryptStoredPayload(storedActive.signedPayloadEnc)
            : "",
          lastError: undefined as string | undefined,
          status:
            storedActive.status === "settled"
              ? ("settled" as const)
              : storedActive.status === "manual" || storedActive.status === "mismatch"
                ? ("manual_reconciliation_required" as const)
                : storedActive.status === "rejected" || storedActive.status === "released"
                  ? ("rejected" as const)
                  : ("pending" as const),
          retryable: storedActive.status === "pending" || storedActive.status === "settling" || storedActive.status === "awaiting_evidence",
        }
      : undefined;

    if (existingAttempt?.status === "manual_reconciliation_required") return undefined;
    if (existingAttempt?.status === "pending" && !existingAttempt.retryable) {
      existingAttempt.status = "manual_reconciliation_required";
      return undefined;
    }

    if (existingAttempt && existingAttempt.requestDigest !== currentDigest) {
      existingAttempt.status = "manual_reconciliation_required";
      existingAttempt.retryable = false;
      existingAttempt.lastError = "The intent changed while the original tool-payment attempt was unresolved. Manual reconciliation is required; no replacement payment will be submitted.";
      void audit.log({
        logicalOrderId: orderId,
        type: "machine.spend_manual_reconciliation",
        actor: "agent",
        summary: existingAttempt.lastError,
        externalReferences: {
          paymentIdentifier: existingAttempt.paymentIdentifier,
          requestDigest: existingAttempt.requestDigest,
        },
        decision: "review",
        reasonCodes: ["x402_manual_reconciliation_required", "x402_material_request_changed"],
      });
      return undefined;
    }

    const paymentIdentifier = existingAttempt?.paymentIdentifier || newId("pid");
    const requestDigest = existingAttempt?.requestDigest ?? currentDigest;
    const spendingRequest = existingAttempt?.spendingRequest ?? currentRequest;
    let outcome: Awaited<ReturnType<typeof import("./machine").runDevnetMachineSpend>>;
    let persistedAttempt = existingAttempt;
    const wasPending = existingAttempt?.status === "pending";
    try {
      const { prepareDevnetMachineSpend, runDevnetMachineSpend } = await import("./machine");
      const preparedAttempt = existingAttempt && existingAttempt.status === "pending" && existingAttempt.signedAttempt
        ? {
            paymentIdentifier: existingAttempt.paymentIdentifier,
            requestDigest: existingAttempt.requestDigest,
            spendingRequest: { ...existingAttempt.spendingRequest },
            encodedPayment: existingAttempt.signedAttempt,
          }
        : await prepareDevnetMachineSpend(spendingRequest, paymentIdentifier, session.approvalEventId);

      if (!persistedAttempt) {
        persistedAttempt = {
          paymentIdentifier: preparedAttempt.paymentIdentifier,
          requestDigest: preparedAttempt.requestDigest,
          spendingRequest: { ...preparedAttempt.spendingRequest },
          signedAttempt: preparedAttempt.encodedPayment,
          status: "pending",
          retryable: true,
          lastError: undefined,
        };
      }
      // Refresh the session cache mirror from durable truth (never the reverse).
      session.machineSpendAttempt = persistedAttempt;

      const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      outcome = await runDevnetMachineSpend(spendingRequest, appOrigin, paymentIdentifier, preparedAttempt, session.approvalEventId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (persistedAttempt) {
        persistedAttempt.status = "manual_reconciliation_required";
        persistedAttempt.retryable = false;
        persistedAttempt.lastError = `Tool-payment processing failed after the signed attempt was retained. Manual reconciliation is required; no replacement payment will be submitted. ${errorMsg}`;
        void audit.log({
          logicalOrderId: orderId,
          type: "machine.spend_manual_reconciliation",
          actor: "agent",
          summary: persistedAttempt.lastError,
          externalReferences: {
            paymentIdentifier: persistedAttempt.paymentIdentifier,
            requestDigest: persistedAttempt.requestDigest,
          },
          decision: "review",
          reasonCodes: ["x402_manual_reconciliation_required", "x402_devnet_spend_error"],
        });
      } else {
        void audit.log({
          logicalOrderId: orderId,
          type: "machine.spend_failed",
          actor: "agent",
          summary: `Premium fit-score devnet spend failed before the signed attempt was retained: ${errorMsg}`,
          decision: "review",
          reasonCodes: ["x402_devnet_spend_error"],
        });
      }
      return undefined;
    }

    if (!outcome.ok || !outcome.settlement || !outcome.resource) {
      const unresolved = outcome.pending === true
        || outcome.reconciliationState === "pending"
        || outcome.reconciliationState === "manual_reconciliation_required";
      if (persistedAttempt && unresolved) {
        const reconciliationState = outcome.reconciliationState === "pending" && outcome.retryable !== false
          ? "pending"
          : "manual_reconciliation_required";
        persistedAttempt.status = reconciliationState;
        persistedAttempt.retryable = outcome.retryable ?? reconciliationState === "pending";
        persistedAttempt.lastError = outcome.error;
        void audit.log({
          logicalOrderId: orderId,
          type: reconciliationState === "pending" ? "machine.spend_pending" : "machine.spend_manual_reconciliation",
          actor: "agent",
          summary: reconciliationState === "pending"
            ? `Premium fit-score settlement is pending. The original signed attempt ${persistedAttempt.paymentIdentifier} is retained for reconciliation; no replacement payment will be submitted.`
            : `Premium fit-score settlement is unresolved. No transaction signature or automatic discovery path is available; manual reconciliation is required and no replacement payment will be submitted.`,
          externalReferences: {
            paymentIdentifier: persistedAttempt.paymentIdentifier,
            requestDigest: persistedAttempt.requestDigest,
          },
          decision: "review",
          reasonCodes: reconciliationState === "pending"
            ? ["x402_settlement_pending", "x402_original_attempt_retained"]
            : ["x402_manual_reconciliation_required", "x402_original_attempt_retained"],
        });
      } else {
        if (persistedAttempt) {
          persistedAttempt.status = "rejected";
          persistedAttempt.retryable = false;
          persistedAttempt.lastError = outcome.error;
        }
        void audit.log({
          logicalOrderId: orderId,
          type: "machine.spend_failed",
          actor: "agent",
          summary: `Premium fit-score devnet resource rejected payment: ${outcome.error ?? "unknown"}`,
          decision: "review",
          reasonCodes: ["x402_payment_rejected"],
        });
      }
      return undefined;
    }

    if (persistedAttempt) {
      persistedAttempt.status = "settled";
      persistedAttempt.retryable = false;
      persistedAttempt.lastError = undefined;
    }
    const storedPaymentIdentifier = persistedAttempt?.paymentIdentifier ?? paymentIdentifier;
    const storedRequestDigest = persistedAttempt?.requestDigest ?? requestDigest;
    session.machineSpend = {
      paymentIdentifier: storedPaymentIdentifier,
      settlementHash: outcome.settlement.transactionHash ?? "",
      fitScores: outcome.resource.scores,
      requestDigest: storedRequestDigest,
      network: outcome.settlement.network,
      asset: outcome.settlementEvidence?.asset ?? devnetConfig.devnetUsdcMint,
      amount: outcome.settlement.amount,
      payer: outcome.settlementEvidence?.payer ?? "",
      payee: outcome.settlementEvidence?.payee ?? "",
      feePayer: outcome.settlementEvidence?.feePayer ?? "",
      memoVerification: outcome.settlementEvidence?.memoVerification ?? "unavailable",
      transferVerification: outcome.settlementEvidence?.transferVerification ?? "unavailable",
      transfer: outcome.settlementEvidence?.transfer,
      explorerUrl: outcome.settlementEvidence?.explorerUrl ?? "",
      settlementMode: "devnet",
    };

    void audit.log({
      logicalOrderId: orderId,
      type: "machine.paid_resource",
      actor: "agent",
      summary: `Fit-scoring invoked under x402 SOLANA DEVNET settlement — test tokens, no real money.`,
      externalReferences: {
        network: outcome.settlement.network,
        paymentIdentifier: storedPaymentIdentifier,
        txHash: outcome.settlement.transactionHash ?? "",
        feePayer: outcome.settlementEvidence?.feePayer ?? "",
        payee: outcome.settlementEvidence?.payee ?? "",
        asset: outcome.settlementEvidence?.asset ?? "",
        amount: outcome.settlement.amount,
        mock: "false",
        purpose: "fit_scoring",
        mandateMaximum: `${formatX402Amount(devnetConfig.amountMinor)} USDC`,
        requestedAmount: `${formatX402Amount(Number(outcome.settlement.amount))} USDC`,
        settlementMode: "devnet",
        requestDigest: storedRequestDigest,
        invocationStatus: "success",
        replayDedupStatus: wasPending ? "reconciled_original_attempt" : "first_invocation",
        explorerUrl: outcome.settlementEvidence?.explorerUrl ?? "",
        memoVerification: outcome.settlementEvidence?.memoVerification ?? "unavailable",
        transferVerification: outcome.settlementEvidence?.transferVerification ?? "unavailable",
        transferMint: outcome.settlementEvidence?.transfer?.mint ?? "",
        transferAmount: outcome.settlementEvidence?.transfer?.amount ?? "",
        transferRecipient: outcome.settlementEvidence?.transfer?.recipient ?? "",
        transferPayer: outcome.settlementEvidence?.transfer?.payer ?? "",
      },
      decision: "allow",
      reasonCodes: [
        wasPending ? "x402_devnet_settlement_reconciled" : "x402_devnet_settlement_verified",
        "machine_tool_spend",
      ],
    });

    return {
      mock: false,
      paymentIdentifier: storedPaymentIdentifier,
      txHash: outcome.settlement.transactionHash ?? "",
      network: outcome.settlement.network,
      amount: outcome.settlement.amount,
    };
  }

  // Mock mode (default)
  const envelopeHash = intentDigest(session.intent);
  const paymentIdentifier = newId("pid");
  const spendingRequest: ToolSpendRequest = {
    orderId,
    intentVersion: session.dialogue.intentVersion,
    resource: "/api/resources/premium-fit-score",
    amountMinor: DEFAULT_MACHINE_SPEND.amountMinor,
    network: DEFAULT_MACHINE_SPEND.network,
    asset: "USDC",
    payee: DEFAULT_MACHINE_SPEND.payeeWallet,
    purpose: "fit_scoring",
  };
  const requestDigest = canonicalToolSpendRequestDigest(spendingRequest);
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
    requestDigest,
    network: outcome.settlement.network,
    asset: DEFAULT_MACHINE_SPEND.usdcMint,
    amount: outcome.settlement.amount,
    payer: outcome.settlement.payer,
    payee: DEFAULT_MACHINE_SPEND.payeeWallet,
    feePayer: "unavailable (mock)",
    memoVerification: "unavailable",
    transferVerification: "unavailable",
    explorerUrl: "",
    settlementMode: "mock",
  };
  void audit.log({
    logicalOrderId: orderId,
    type: "machine.paid_resource",
    actor: "agent",
    summary: `Fit-scoring invoked under a pre-authorized ${formatX402Amount(DEFAULT_MACHINE_SPEND.amountMinor)} USDC x402 mandate — MOCK settlement; no real funds moved.`,
    externalReferences: {
      network: outcome.settlement.network,
      paymentIdentifier,
      txHash: outcome.settlement.transactionHash ?? "",
      feePayer: "unavailable (mock)",
      payee: DEFAULT_MACHINE_SPEND.payeeWallet,
      asset: DEFAULT_MACHINE_SPEND.usdcMint,
      amount: outcome.settlement.amount,
      mock: "true",
      purpose: "fit_scoring",
      mandateMaximum: `${formatX402Amount(DEFAULT_MACHINE_SPEND.amountMinor)} USDC`,
      requestedAmount: `${formatX402Amount(Number(outcome.settlement.amount))} USDC`,
      settlementMode: "mock",
      requestDigest,
      invocationStatus: "success",
      replayDedupStatus: "first_invocation",
    },
    decision: "allow",
    reasonCodes: ["x402_mock_settlement_verified", "machine_tool_spend", "demo_preauthorized"],
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

function machineSpendAttemptSummary(session: Session): MachineSpendAttemptSummary | undefined {
  const attempt = session.machineSpendAttempt;
  if (!attempt || attempt.status === "settled") return undefined;
  return {
    paymentIdentifier: attempt.paymentIdentifier,
    requestDigest: attempt.requestDigest,
    status: attempt.status,
    retryable: attempt.retryable,
  };
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
  machineSpendAttempt: MachineSpendAttemptSummary | undefined,
): Promise<string> {
  const best = ranking.matches[0];
  if (!best) {
    const budget = session.intent.maxAmountMinor;
    return budget
      ? `No products satisfy your ${budgetLabel(budget)} budget and current constraints.`
      : "No products satisfy your constraints with current stock.";
  }
  const spendNote = machineSpend
    ? machineSpend.mock
      ? ` Fit-scoring invoked under a pre-authorized ${machineSpend.amount} USDC x402 mandate — MOCK settlement; no real funds moved.`
      : ` Fit-scoring invoked under x402 SOLANA DEVNET settlement — test tokens, no real money.`
    : machineSpendAttempt?.status === "pending"
      ? " Fit-scoring settlement is pending. The original signed payment attempt is retained and will be reconciled without submitting a replacement."
      : machineSpendAttempt?.status === "manual_reconciliation_required"
        ? " Fit-scoring settlement is unresolved and requires manual reconciliation. No replacement payment will be submitted."
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
