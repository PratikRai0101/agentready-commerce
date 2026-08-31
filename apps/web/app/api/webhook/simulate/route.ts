import { NextResponse } from "next/server";
import { razorpaySignature } from "@agentready/payments";
import { getServices } from "@/lib/services";
import { processRazorpayWebhook } from "@/lib/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, replay } = (await request.json()) as { orderId: string; replay?: boolean };
  const services = getServices();
  if (!services.registry.isMock("razorpay_checkout")) {
    return NextResponse.json({ error: "Webhook simulation requires mock mode" }, { status: 409 });
  }

  const session = services.getSession(orderId);
  if (!session) {
    return NextResponse.json({ error: "Unknown session" }, { status: 400 });
  }
  if (!session.externalOrderId) {
    return NextResponse.json({ error: "No Razorpay order initiated for this session" }, { status: 400 });
  }

  const paymentId = session.externalPaymentId ?? `pay_MOCK_${session.externalOrderId}`;
  const payload = {
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: session.externalOrderId,
          amount: session.verification?.amountMinor ?? 0,
          currency: "INR",
          status: "captured",
          notes: { logicalOrderId: orderId },
        },
      },
    },
  };
  const signature = razorpaySignature("mock_secret", JSON.stringify(payload));
  const outcome = processRazorpayWebhook(services, payload, signature, "mock_secret");
  return NextResponse.json({ ...outcome, simulated: true, replay });
}