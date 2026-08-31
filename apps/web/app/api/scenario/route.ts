import { NextResponse } from "next/server";
import { formatX402Amount } from "@agentready/payments";
import { getServices } from "@/lib/services";
import { DEFAULT_MACHINE_SPEND } from "@/lib/machine";

export const runtime = "nodejs";

const DEMO_MESSAGE = "I need black shoes under ₹5,000.";
const CLARIFICATIONS = ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"];

export async function GET() {
  const services = getServices();
  const session = services.createSession();
  const orderId = session.logicalOrderId;
  let last: { kind: string; message?: string; matches?: unknown[]; fitScores?: unknown[]; machineSpend?: unknown; state: string } | null = null;

  try {
    const first = await services.respond(orderId, DEMO_MESSAGE);
    last = first;
    for (const clarification of CLARIFICATIONS) {
      const result = await services.respond(orderId, clarification);
      last = result;
    }
    const events = await services.timeline(orderId);
    return NextResponse.json({
      orderId,
      state: session.state,
      final: last,
      machineSpend: session.machineSpend
        ? {
            mock: true,
            paymentIdentifier: session.machineSpend.paymentIdentifier,
            txHash: session.machineSpend.settlementHash,
            network: DEFAULT_MACHINE_SPEND.network,
            amount: formatX402Amount(DEFAULT_MACHINE_SPEND.amountMinor),
          }
        : undefined,
      fitScores: session.machineSpend?.fitScores,
      events,
      scenario: "prepared-demo",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}