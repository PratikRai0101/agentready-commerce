import { NextResponse } from "next/server";
import { runCriticalInvariants, type PlaneHooks, type ClientVerifyClaims, type WebhookClaims } from "@agentready/conformance";
import { envelopeDigest } from "@agentready/domain";
import { MockRazorpayAdapter, parsePaymentResponse, razorpaySignature } from "@agentready/payments";
import { getServices } from "@/lib/services";
import { DEFAULT_MACHINE_SPEND, DemoMachineResource } from "@/lib/machine";
import { processRazorpayWebhookRaw } from "@/lib/webhook";

export const runtime = "nodejs";

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];
const BINDING_ORDER_SENTINEL = "order_binding";

async function setupBindingSession(services: ReturnType<typeof getServices>) {
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  await services.respond(orderId, DEMO_MESSAGE);
  for (const clarification of CLARIFICATIONS) {
    await services.respond(orderId, clarification);
  }
  const quote = await services.buildQuote(orderId, "p_streak_4");
  await services.approve(orderId, quote.digest);
  await services.initiatePayment(orderId, "razorpay_checkout");
  return { orderId, quote, session };
}

export async function GET() {
  const services = getServices();
  services.reset();
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
    const machine = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const razorpayAdapter = services.registry.get("razorpay_checkout")!;
    let bindingState = "DRAFT";

    const attemptClientVerify = async (claims: ClientVerifyClaims) => {
      const fresh = await setupBindingSession(services);
      bindingState = fresh.session.state;
      const actualOrderId = claims.orderId === BINDING_ORDER_SENTINEL ? fresh.session.externalOrderId! : claims.orderId;
      if (razorpayAdapter.isMock) {
        (razorpayAdapter as MockRazorpayAdapter).setSimulation(
          claims.simulate as ConstructorParameters<typeof MockRazorpayAdapter>[0]["simulatePayment"],
        );
      }
      try {
        const signature = razorpaySignature(services.razorpayKeySecret, `${actualOrderId}|${claims.paymentId}`);
        const result = await services.verifyPayment(fresh.orderId, actualOrderId, claims.paymentId, signature);
        bindingState = result.state;
        return result.ok ? { ok: true, reasons: [], state: result.state } : { ok: false, reasons: [result.error ?? "rejected"], state: result.state };
      } finally {
        if (razorpayAdapter.isMock) {
          (razorpayAdapter as MockRazorpayAdapter).setSimulation(undefined);
        }
      }
    };

    const applyWebhook = async (claims: WebhookClaims) => {
      const fresh = await setupBindingSession(services);
      bindingState = fresh.session.state;
      const actualOrderId = claims.orderId === BINDING_ORDER_SENTINEL ? fresh.session.externalOrderId! : claims.orderId;
      const rawBody = JSON.stringify({
        event: claims.status === "captured" ? "payment.captured" : "payment.authorized",
        contains: ["payment"],
        payload: {
          payment: {
            entity: {
              id: claims.paymentId,
              order_id: actualOrderId,
              amount: claims.amountMinor,
              currency: claims.currency,
              status: claims.status,
              notes: { logicalOrderId: fresh.orderId },
            },
          },
        },
      });
      const signature = razorpaySignature(services.webhookSecret ?? "mock_secret", rawBody);
      const outcome = await processRazorpayWebhookRaw(
        services,
        rawBody,
        signature,
        claims.eventId,
        services.webhookSecret ?? "mock_secret",
      );
      const current = services.getSession(fresh.orderId);
      bindingState = current?.state ?? bindingState;
      if (!outcome.ok) {
        return { ok: false, reasons: [outcome.error], state: bindingState };
      }
      return {
        ok: true,
        reasons: [],
        state: bindingState,
        deduplicated: outcome.deduplicated,
        held: outcome.held,
      };
    };

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
        const current = services.getSession(orderId);
        if (current?.state === "PAYMENT_FAILED") {
          await services.initiatePayment(orderId, "razorpay_checkout");
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
      replayWebhook: async (eventId) => {
        if (services.isWebhookProcessed(eventId)) {
          return { processed: false, deduplicated: true };
        }
        services.markWebhookProcessed(eventId);
        return { processed: true, deduplicated: false };
      },
      machine: {
        quote: (hash) => machine.quote(hash),
        accept: (header, hash) => {
          const response = machine.accept(header, hash);
          if (response.status !== 200) {
            return { ok: false, error: JSON.stringify(response.body) };
          }
          return { ok: true, settlement: parsePaymentResponse(response.headers["PAYMENT-RESPONSE"]!) };
        },
        hasProcessed: (pid) => machine.hasProcessed(pid),
      },
      railBinding: {
        attemptClientVerify,
        applyWebhook,
        currentState: async () => bindingState,
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