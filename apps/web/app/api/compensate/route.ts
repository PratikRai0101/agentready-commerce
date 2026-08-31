import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId } = (await request.json()) as { orderId: string };
  const services = getServices();
  const result = await services.compensate(orderId);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}