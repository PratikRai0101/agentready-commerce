import { NextResponse } from "next/server";
import { razorpaySignature } from "@agentready/payments";
import { getServices } from "@/lib/services";
import { processRazorpayWebhookRaw } from "@/lib/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, replay } = (await request.json()) as { orderId: string; replay?: boolean };
  const services = getServices();
  if (!services.isMock) {
    return NextResponse.json({ error: "Webhook simulation requires mock mode" }, { status: 409 });
  }

  const session = services.getSession(orderId);
  if (!session) {
    return NextResponse.json({ error: "Unknown session" }, { status: 400 });
  }
  if (!session.externalOrderId) {
    return NextResponse.json({ error: "No Razorpay order initiated for this session" }, { status: 400 });
  }

  const record = services.getEnvelope(orderId);
  const paymentId = session.externalPaymentId ?? `pay_MOCK_${session.externalOrderId}`;

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

  const signature = razorpaySignature(services.webhookSecret ?? "mock_secret", rawBody);
  const eventId = `evt_sim_${session.externalOrderId}_${paymentId}`;

  const outcome = await processRazorpayWebhookRaw(
    services,
    rawBody,
    signature,
    eventId,
    services.webhookSecret ?? "mock_secret",
  );

  return NextResponse.json({ ...outcome, simulated: true, replay, eventId });
}