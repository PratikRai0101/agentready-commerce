import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getMachineResourceMode } from "@/lib/machine";
import { buildDiscoveryDoc } from "@/lib/discovery";

export const runtime = "nodejs";

export async function GET() {
  const services = getServices();
  return NextResponse.json(
    buildDiscoveryDoc({
      razorpay: services.razorpayMode,
      x402: getMachineResourceMode(),
      llm: services.llm.enabled ? services.llm.name : "disabled",
      envelopeSigning: services.registry.isMock("razorpay_checkout") ? "mock" : "configured",
    }),
  );
}
