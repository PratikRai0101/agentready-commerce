import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; digest: string; sessionToken?: string };
  const { orderId, digest } = body;
  if (!orderId || !digest) {
    return NextResponse.json({ error: "orderId and digest are required" }, { status: 400 });
  }
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  const result = await services.approve(orderId, digest);
  return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: result.ok ? 200 : 409 });
}