import { NextResponse } from "next/server";
import { formatMinor, type ProductMatch } from "@agentready/catalog";
import { getServices, type RecommendationBinding, type RespondResult } from "../../../lib/services";

export const runtime = "nodejs";

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];
const STREAK_ID = "p_streak_4";

type TranscriptEntry = {
  role: "user" | "agent";
  text: string;
  kind: string;
  state: string;
};

function bindingFrom(result: { intentVersion?: number; recommendationVersion?: number; recommendationActionToken?: string }): RecommendationBinding | undefined {
  if (typeof result.intentVersion !== "number" || typeof result.recommendationVersion !== "number" || typeof result.recommendationActionToken !== "string") {
    return undefined;
  }
  return {
    intentVersion: result.intentVersion,
    recommendationVersion: result.recommendationVersion,
    recommendationActionToken: result.recommendationActionToken,
  };
}

function responseText(result: RespondResult): string {
  if ("message" in result && result.message) return result.message;
  if (result.kind === "compare") return `Compared ${result.productA.product.name} and ${result.productB.product.name}.`;
  if (result.kind === "explain") return result.explanation;
  return `Action ${result.kind} completed.`;
}

function addResponse(transcript: TranscriptEntry[], message: string, result: RespondResult): void {
  transcript.push({ role: "user", text: message, kind: "user.message", state: result.state });
  transcript.push({ role: "agent", text: responseText(result), kind: result.kind, state: result.state });
}

function productIds(matches: ProductMatch[] | undefined): string[] {
  return matches?.map((match) => match.product.productId) ?? [];
}

export async function GET() {
  const services = getServices();
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  const transcript: TranscriptEntry[] = [];
  let currentShortlist: RespondResult | undefined;
  let initialShortlist: Extract<RespondResult, { kind: "shortlist" }> | undefined;
  let firstQuote: Awaited<ReturnType<typeof services.buildQuote>> | undefined;
  let replacementQuote: Awaited<ReturnType<typeof services.buildQuote>> | undefined;
  let staleSelection: RespondResult | undefined;
  let invalidatedQuoteDigest: string | undefined;
  let invalidationState: string | undefined;
  let activeEnvelopeAfterInvalidation = false;
  let approvalAfterInvalidation: Awaited<ReturnType<typeof services.approve>> | undefined;
  let paymentAfterInvalidation: Awaited<ReturnType<typeof services.initiatePayment>> | undefined;

  try {
    const first = await services.respond(orderId, DEMO_MESSAGE);
    addResponse(transcript, DEMO_MESSAGE, first);
    for (const clarification of CLARIFICATIONS) {
      const result = await services.respond(orderId, clarification);
      addResponse(transcript, clarification, result);
      if (result.kind === "shortlist") currentShortlist = result;
    }
    if (currentShortlist?.kind !== "shortlist") {
      throw new Error("Prepared scenario did not produce an initial shortlist");
    }
    initialShortlist = currentShortlist;

    const initialBinding = bindingFrom(initialShortlist);
    const selected = await services.respond(orderId, "Select Streak 4.", initialBinding);
    addResponse(transcript, "Select Streak 4.", selected);
    if (selected.kind !== "select") throw new Error("Prepared scenario could not select Streak 4");

    firstQuote = await services.buildQuote(orderId, STREAK_ID, bindingFrom(selected));
    transcript.push({
      role: "agent",
      text: `Prepared ${firstQuote.envelope.items[0]?.productId} at ${formatMinor(firstQuote.envelope.items[0]?.unitAmountMinor ?? 0)}; state ${firstQuote.state}.`,
      kind: "quote.created",
      state: firstQuote.state,
    });

    invalidatedQuoteDigest = firstQuote.digest;
    const budgetEdit = await services.respond(orderId, "Change budget to ₹3,000.");
    addResponse(transcript, "Change budget to ₹3,000.", budgetEdit);
    if (budgetEdit.kind === "shortlist") currentShortlist = budgetEdit;
    invalidationState = session.state;
    activeEnvelopeAfterInvalidation = services.getEnvelope(orderId) !== undefined;

    approvalAfterInvalidation = await services.approve(orderId, invalidatedQuoteDigest);
    transcript.push({
      role: "agent",
      text: `Approval attempt for invalidated envelope: ${approvalAfterInvalidation.ok ? "accepted" : `rejected — ${approvalAfterInvalidation.error ?? "no active quote"}`}.`,
      kind: "approval.attempt",
      state: approvalAfterInvalidation.state,
    });
    paymentAfterInvalidation = await services.initiatePayment(orderId, "razorpay_checkout");
    transcript.push({
      role: "agent",
      text: `Payment attempt for invalidated envelope: ${paymentAfterInvalidation.ok ? "accepted" : `rejected — ${paymentAfterInvalidation.error ?? "no active quote"}`}.`,
      kind: "payment.attempt",
      state: paymentAfterInvalidation.state,
    });

    staleSelection = await services.respond(orderId, "Select Streak 4.", initialBinding);
    addResponse(transcript, "Select Streak 4.", staleSelection);
    if (staleSelection.kind === "shortlist") currentShortlist = staleSelection;

    const refreshed = staleSelection.kind === "error" && staleSelection.matches
      ? staleSelection.matches
      : currentShortlist?.kind === "shortlist"
        ? currentShortlist.matches
        : [];
    const replacement = refreshed[0];
    if (replacement && currentShortlist?.kind === "shortlist") {
      const replacementMessage = `Select ${replacement.product.name}.`;
      const replacementSelection = await services.respond(orderId, replacementMessage, bindingFrom(currentShortlist));
      addResponse(transcript, replacementMessage, replacementSelection);
      if (replacementSelection.kind === "select") {
        replacementQuote = await services.buildQuote(orderId, replacement.product.productId, bindingFrom(replacementSelection));
        transcript.push({
          role: "agent",
          text: `Prepared ${replacementQuote.envelope.items[0]?.productId} at ${formatMinor(replacementQuote.envelope.items[0]?.unitAmountMinor ?? 0)}; state ${replacementQuote.state}.`,
          kind: "quote.created",
          state: replacementQuote.state,
        });
      }
    }

    const fallback = getServices(process.env, {
      forceMock: true,
      skipCache: true,
      llm: {
        name: "unavailable-fallback",
        enabled: true,
        extractSoftPreferences: async () => null,
        explainRecommendation: async () => null,
        interpret: async () => ({ ok: false as const, reason: "http" as const }),
      },
    });
    const fallbackSession = fallback.createSession();
    await fallback.respond(fallbackSession.logicalOrderId, DEMO_MESSAGE);
    for (const clarification of CLARIFICATIONS) await fallback.respond(fallbackSession.logicalOrderId, clarification);
    await fallback.respond(fallbackSession.logicalOrderId, "Change budget to ₹3,000.");
    const fallbackResult = fallbackSession.lastRanking?.matches ?? [];
    const currentResult = session.lastRanking?.matches ?? [];
    const fallbackPreserved = productIds(fallbackResult).join(",") === productIds(currentResult).join(",") &&
      fallbackResult.map((match) => match.scoreNormalized).join(",") === currentResult.map((match) => match.scoreNormalized).join(",");
    transcript.push({
      role: "agent",
      text: `Provider fallback preserved current eligible results: ${fallbackPreserved ? "yes" : "no"}.`,
      kind: "provider.fallback",
      state: session.state,
    });

    const events = await services.timeline(orderId);
    const activeEnvelopeAfterReplacement = replacementQuote && services.getEnvelope(orderId)?.digest === replacementQuote.digest
      ? services.getEnvelope(orderId)
      : undefined;
    return NextResponse.json({
      orderId,
      state: session.state,
      final: currentShortlist,
      currentRecommendations: session.lastRanking?.matches ?? [],
      currentRecommendationBinding: bindingFrom({
        intentVersion: session.dialogue.intentVersion,
        recommendationVersion: session.dialogue.recommendationVersion,
        recommendationActionToken: session.dialogue.recommendationActionToken,
      }),
      quote: replacementQuote ?? null,
      initialQuote: firstQuote
        ? { digest: firstQuote.digest, productId: STREAK_ID, totalMinor: firstQuote.envelope.totalMinor, state: firstQuote.state }
        : null,
      invalidation: {
        oldQuoteDigest: invalidatedQuoteDigest,
        state: invalidationState,
        activeEnvelopeBeforeReplacement: activeEnvelopeAfterInvalidation,
        activeEnvelopeAfterReplacement: Boolean(activeEnvelopeAfterReplacement),
        approvalAttempt: approvalAfterInvalidation,
        paymentAttempt: paymentAfterInvalidation,
      },
      staleSelection: staleSelection?.kind === "error"
        ? { message: staleSelection.message, rejectedProductId: staleSelection.rejectedProductId, matches: staleSelection.matches ?? [] }
        : null,
      providerFallback: {
        preservedCurrentEligibleResults: fallbackPreserved,
        matches: fallbackResult,
      },
      transcript,
      machineSpend: session.machineSpend
        ? {
            mock: session.machineSpend.settlementMode === "mock",
            paymentIdentifier: session.machineSpend.paymentIdentifier,
            txHash: session.machineSpend.settlementHash,
            network: session.machineSpend.network,
            amount: session.machineSpend.amount,
            requestDigest: session.machineSpend.requestDigest,
            payer: session.machineSpend.payer,
            payee: session.machineSpend.payee,
            feePayer: session.machineSpend.feePayer,
            memoVerification: session.machineSpend.memoVerification,
            transferVerification: session.machineSpend.transferVerification,
            transfer: session.machineSpend.transfer,
            explorerUrl: session.machineSpend.explorerUrl,
          }
        : undefined,
      fitScores: session.machineSpend?.fitScores,
      events,
      scenario: "corrected-stale-selection",
      sessionToken: await services.exportSession(orderId),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), orderId, transcript }, { status: 500 });
  }
}
