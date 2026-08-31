import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId } = (await request.json()) as { orderId: string };
  const services = getServices();
  if (!services.registry.isMock("razorpay_checkout")) {
    return NextResponse.json({ error: "Mock capture is only available when the Razorpay adapter is in mock mode" }, { status: 409 });
  }
  try {
    const result = await services.mockCapture(orderId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}