import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; field: "price" | "variant"; sessionToken?: string };
  const { orderId, field } = body;
  if (!orderId || (field !== "price" && field !== "variant")) {
    return NextResponse.json({ error: "orderId and field (price|variant) are required" }, { status: 400 });
  }
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  const result = await services.tamper(orderId, field);
  return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: result.ok ? 200 : 409 });
}