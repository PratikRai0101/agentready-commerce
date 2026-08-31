import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { processRazorpayWebhookRaw, type WebhookOutcome } from "@/lib/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const services = getServices();
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");
  const rawBody = await request.text();

  if (!services.webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const outcome = await processRazorpayWebhookRaw(services, rawBody, signature, eventId, services.webhookSecret);
  const status = outcome.ok ? 200 : 400;
  logOutcome(outcome, status);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status });
  }
  return NextResponse.json(outcome, { status });
}

function logOutcome(outcome: WebhookOutcome, status: number): void {
  const safe = {
    ts: new Date().toISOString(),
    type: "webhook.outcome",
    event: outcome.event ?? "unknown",
    eventId: outcome.eventId ?? null,
    paymentId: outcome.paymentId ?? null,
    orderId: outcome.orderId ?? null,
    httpStatus: status,
    reason: outcome.reasonCode,
    deduplicated: outcome.ok ? outcome.deduplicated : false,
    processed: outcome.ok ? outcome.processed : false,
    held: outcome.ok ? outcome.held : false,
    ignored: outcome.ok ? outcome.ignored ?? false : false,
  };
  console.log(JSON.stringify(safe));
}