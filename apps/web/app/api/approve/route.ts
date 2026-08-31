import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, digest } = (await request.json()) as { orderId: string; digest: string };
  if (!orderId || !digest) {
    return NextResponse.json({ error: "orderId and digest are required" }, { status: 400 });
  }
  const services = getServices();
  const result = await services.approve(orderId, digest);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}