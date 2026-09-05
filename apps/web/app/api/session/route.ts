import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getMachineResourceMode } from "@/lib/machine";

export const runtime = "nodejs";

export async function POST() {
  const services = getServices();
  const session = services.createSession();
  return NextResponse.json({
    orderId: session.logicalOrderId,
    state: session.state,
    customerId: session.customerId,
    rails: services.registry.all().map((adapter) => ({ rail: adapter.rail, isMock: adapter.isMock })),
    indicators: {
      razorpay: services.razorpayMode,
      x402: getMachineResourceMode(),
      llm: services.llm.enabled ? services.llm.name : "disabled",
    },
  });
}