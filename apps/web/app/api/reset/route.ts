import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST() {
  const services = getServices();
  services.reset();
  const session = services.createSession();
  return NextResponse.json({
    ok: true,
    orderId: session.logicalOrderId,
    state: session.state,
    message: "Fresh-demo reset complete: sessions, envelopes, webhook dedup and machine resource state cleared.",
  });
}