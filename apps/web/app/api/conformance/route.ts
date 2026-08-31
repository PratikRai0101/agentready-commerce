import { NextResponse } from "next/server";
import { runCriticalInvariants, type PlaneHooks } from "@agentready/conformance";
import { envelopeDigest } from "@agentready/domain";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

export async function GET() {
  const services = getServices();
  const session = services.createSession();
  const orderId = session.logicalOrderId;

  try {
    await services.respond(orderId, DEMO_MESSAGE);
    for (const clarification of CLARIFICATIONS) {
      await services.respond(orderId, clarification);
    }
    const quote = await services.buildQuote(orderId, "p_streak_4");
    await services.approve(orderId, quote.digest);
    await services.initiatePayment(orderId, "razorpay_checkout");

    const plane: PlaneHooks = {
      findMandate: async () => services.getMandate(session.customerId),
      checkPaymentPolicy: async (envelope, rail) => services.policyCheck(orderId, rail, envelope),
      attemptPayment: async (envelope, rail) => {
        const result = await services.initiatePayment(orderId, rail);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      approveEnvelope: async (envelope) => {
        const result = await services.approve(orderId, envelopeDigest(envelope));
        return result.ok ? { ok: true, approvalEventId: result.approvalEventId } : { ok: false, error: result.error };
      },
      verifyPayment: async (_envelope, signature) => {
        if (signature === "forged_signature") {
          const result = await services.verifyPayment(orderId, session.externalOrderId ?? "order_X", "pay_forged", "deadbeef");
          return { verified: result.ok, reason: result.error };
        }
        const capture = await services.mockCapture(orderId);
        const result = await services.verifyPayment(orderId, capture.orderId, capture.paymentId, capture.signature);
        return { verified: result.ok, reason: result.error };
      },
      fulfil: async () => {
        const result = await services.fulfil(orderId, true);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      compensate: async () => {
        const result = await services.compensate(orderId);
        return result.ok ? { ok: true, refundId: result.refundId } : { ok: false, error: result.error };
      },
      isAlreadyPaid: async () => {
        const current = services.getSession(orderId);
        return Boolean(current && ["PAID_VERIFIED", "FULFILMENT_PENDING", "FULFILLED", "REFUNDED"].includes(current.state));
      },
      countSuccessRail: async () => {
        const current = services.getSession(orderId);
        return current && ["PAID_VERIFIED", "FULFILMENT_PENDING", "FULFILLED", "REFUNDED"].includes(current.state) ? 1 : 0;
      },
    };

    const report = await runCriticalInvariants(plane, quote.envelope, services.getMandate(session.customerId)!);
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { suite: "critical-invariants", ranAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}