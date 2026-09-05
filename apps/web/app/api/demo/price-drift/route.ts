import { NextResponse } from "next/server";
import { getServices, type RecommendationBinding } from "@/lib/services";

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
 * Self-contained price-drift demonstration.
 *
 * Drives one fresh session from ambiguous request through approval, then
 * applies a material tool-retry change and proves the stale approval and
 * payment are blocked — all inside this single request, so the result does
 * not depend on in-memory state shared across serverless instances.
 * Mock theatre only: no funds move.
 */
export async function POST(request: Request) {
  const { field } = (await request.json().catch(() => ({}))) as { field?: string };
  const tamperField = field === "variant" ? "variant" : "price";
  const services = getServices();
  if (!services.isMock) {
    return NextResponse.json({ error: "Price-drift demo requires mock mode" }, { status: 409 });
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
    const approvedDigest = quote.digest;
    const approved = await services.approve(orderId, approvedDigest);
    if (!approved.ok) throw new Error(`demo setup could not approve: ${approved.error ?? "unknown"}`);

    const tampered = await services.tamper(orderId, tamperField);
    if (!tampered.ok) throw new Error(`tamper did not invalidate: ${tampered.error ?? "unknown"}`);

    const staleApproval = await services.approve(orderId, approvedDigest);
    const stalePayment = await services.initiatePayment(orderId, "razorpay_checkout");
    const events = await services.timeline(orderId);

    return NextResponse.json({
      ok: true,
      orderId,
      state: session.state,
      field: tamperField,
      approvedDigest,
      invalidatedDigest: services.getEnvelope(orderId)?.digest ?? null,
      changes: tampered.changes,
      approvalBlocked: !staleApproval.ok,
      approvalError: staleApproval.error ?? null,
      paymentBlocked: !stalePayment.ok,
      paymentError: stalePayment.error ?? null,
      events,
      sessionToken: await services.exportSession(orderId),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
