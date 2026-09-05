import { NextResponse } from "next/server";
import { razorpaySignature } from "@agentready/payments";
import { getServices, type RecommendationBinding } from "@/lib/services";
import { processRazorpayWebhookRaw } from "@/lib/webhook";

export const runtime = "nodejs";

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];
const PRODUCT_ID = "p_streak_4";
const SELECT_MESSAGE = "Select Streak 4.";

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

/**
 * Self-contained webhook-replay demonstration.
 *
 * Drives one fresh session to PAYMENT_PENDING on the mock rail, then delivers
 * the same `payment.captured` webhook twice under one event ID — all inside
 * this single request, so the result does not depend on in-memory state
 * shared across serverless instances. Mock theatre only: no funds move.
 */
export async function POST() {
  const services = getServices();
  if (!services.isMock) {
    return NextResponse.json({ error: "Webhook replay demo requires mock mode" }, { status: 409 });
  }

  try {
    const session = services.createSession();
    const orderId = session.logicalOrderId;

    await services.respond(orderId, DEMO_MESSAGE);
    let shortlist: Extract<Awaited<ReturnType<typeof services.respond>>, { kind: "shortlist" }> | undefined;
    for (const clarification of CLARIFICATIONS) {
      const result = await services.respond(orderId, clarification);
      if (result.kind === "shortlist") shortlist = result;
    }
    if (!shortlist) throw new Error("demo setup did not reach a shortlist");

    const selected = await services.respond(orderId, SELECT_MESSAGE, bindingFrom(shortlist));
    if (selected.kind !== "select") throw new Error("demo setup could not select a product");

    const quote = await services.buildQuote(orderId, PRODUCT_ID, bindingFrom(selected));
    const approved = await services.approve(orderId, quote.digest);
    if (!approved.ok) throw new Error(`demo setup could not approve: ${approved.error ?? "unknown"}`);

    const initiated = await services.initiatePayment(orderId, "razorpay_checkout");
    if (!initiated.ok || !session.externalOrderId) {
      throw new Error(`demo setup could not initiate mock payment: ${initiated.error ?? "unknown"}`);
    }

    const record = services.getEnvelope(orderId);
    const paymentId = `pay_MOCK_demo_${session.externalOrderId}`;
    const rawBody = JSON.stringify({
      event: "payment.captured",
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: session.externalOrderId,
            amount: record?.envelope.totalMinor ?? 0,
            currency: record?.envelope.currency ?? "INR",
            status: "captured",
            notes: { logicalOrderId: orderId },
          },
        },
      },
    });

    const secret = services.webhookSecret ?? "mock_secret";
    const signature = razorpaySignature(secret, rawBody);
    const eventId = `evt_demo_${session.externalOrderId}_${paymentId}`;

    const first = await processRazorpayWebhookRaw(services, rawBody, signature, eventId, secret);
    const second = await processRazorpayWebhookRaw(services, rawBody, signature, eventId, secret);
    const events = await services.timeline(orderId);

    return NextResponse.json({
      ok: true,
      orderId,
      state: session.state,
      eventId,
      first: { processed: "processed" in first ? first.processed : false, deduplicated: "deduplicated" in first ? first.deduplicated : false },
      second: { processed: "processed" in second ? second.processed : false, deduplicated: "deduplicated" in second ? second.deduplicated : false },
      events,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
