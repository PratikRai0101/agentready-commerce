import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  if (!orderId) {
    return NextResponse.json({ error: "orderId query param required" }, { status: 400 });
  }
  const services = getServices();
  const events = await services.timeline(orderId);
  return NextResponse.json({ events });
}