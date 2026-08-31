import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { processRazorpayWebhookRaw } from "@/lib/webhook";

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
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(outcome);
}