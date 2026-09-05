import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; fail?: boolean; sessionToken?: string };
  const { orderId, fail } = body;
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  const result = await services.fulfil(orderId, fail === true);
  return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: result.ok ? 200 : 409 });
}