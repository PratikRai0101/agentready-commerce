import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    orderId: string;
    intentPatch: Record<string, unknown>;
    expectedIntentVersion: number;
  };
  const { orderId, intentPatch, expectedIntentVersion } = body;
  if (!orderId || !intentPatch || typeof expectedIntentVersion !== "number") {
    return NextResponse.json({ error: "orderId, intentPatch, and expectedIntentVersion are required" }, { status: 400 });
  }
  const services = getServices();
  try {
    const result = await services.intentPatch(orderId, intentPatch as Parameters<typeof services.intentPatch>[1], expectedIntentVersion);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
