import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; rail?: string; sessionToken?: string };
  const { orderId, rail } = body;
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  const result = await services.initiatePayment(orderId, rail ?? "razorpay_checkout");
  if (!result.ok) {
    const errorMessage = result.error ?? "";
    if (errorMessage.includes("authentication failed")) {
      return NextResponse.json(result, { status: 401 });
    }
    if (errorMessage.includes("Razorpay API") || errorMessage.includes("unreachable")) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: 409 });
  }
  return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) });
}