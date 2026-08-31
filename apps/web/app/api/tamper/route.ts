import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, field } = (await request.json()) as { orderId: string; field: "price" | "variant" };
  if (!orderId || (field !== "price" && field !== "variant")) {
    return NextResponse.json({ error: "orderId and field (price|variant) are required" }, { status: 400 });
  }
  const services = getServices();
  const result = await services.tamper(orderId, field);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}