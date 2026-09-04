import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getMachineResourceMode } from "@/lib/machine";
import { getLlmUsageSnapshot } from "@/lib/llm";

export const runtime = "nodejs";

export async function GET() {
  const services = getServices();
  const session = services.createSession();
  return NextResponse.json({
    orderId: session.logicalOrderId,
    // Echoes the harness-provided run nonce so a test runner can prove it is
    // talking to the server process it launched (stale-server rejection).
    // Null unless the launcher sets AGENTREADY_RUN_NONCE.
    runNonce: process.env.AGENTREADY_RUN_NONCE ?? null,
    rails: services.registry.all().map((adapter) => ({ rail: adapter.rail, isMock: adapter.isMock })),
    indicators: {
      razorpay: services.razorpayMode,
      x402: getMachineResourceMode(),
      llm: services.llm.enabled ? services.llm.name : "disabled",
    },
    // Token counts only — never prompts, keys, or message content.
    llmUsage: getLlmUsageSnapshot(),
    envelopeSigning: services.registry.isMock("razorpay_checkout") ? "mock" : "configured",
  });
}