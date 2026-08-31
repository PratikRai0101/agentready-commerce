import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, message } = (await request.json()) as { orderId: string; message: string };
  if (!orderId || !message?.trim()) {
    return NextResponse.json({ error: "orderId and message are required" }, { status: 400 });
  }
  const services = getServices();
  try {
    const result = await services.respond(orderId, message.trim());
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}