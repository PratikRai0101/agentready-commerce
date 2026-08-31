import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, productId } = (await request.json()) as { orderId: string; productId: string };
  if (!orderId || !productId) {
    return NextResponse.json({ error: "orderId and productId are required" }, { status: 400 });
  }
  const services = getServices();
  try {
    const quote = await services.buildQuote(orderId, productId);
    return NextResponse.json(quote);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}