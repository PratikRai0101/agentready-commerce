import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId } = (await request.json()) as { orderId: string };
  const services = getServices();
  try {
    const result = await services.prepareX402OrderPayment(orderId);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
