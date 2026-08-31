import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, fail } = (await request.json()) as { orderId: string; fail?: boolean };
  const services = getServices();
  const result = await services.fulfil(orderId, fail === true);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}