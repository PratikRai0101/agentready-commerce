import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; sessionToken?: string };
  const { orderId } = body;
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  if (!services.registry.isMock("razorpay_checkout")) {
    return NextResponse.json({ error: "Mock capture is only available when the Razorpay adapter is in mock mode" }, { status: 409 });
  }
  try {
    const result = await services.mockCapture(orderId);
    return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}