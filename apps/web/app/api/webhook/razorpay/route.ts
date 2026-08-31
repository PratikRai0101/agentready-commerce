import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { processRazorpayWebhook } from "@/lib/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const services = getServices();
  const signature = request.headers.get("x-razorpay-signature");
  const payload = await request.json();
  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET ?? (services.registry.isMock("razorpay_checkout") ? "mock_secret" : undefined);

  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const outcome = processRazorpayWebhook(services, payload, signature, webhookSecret);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(outcome);
}