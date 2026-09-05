import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

/**
 * Single-request mock settlement for Agent Pay with x402.
 *
 * Prepares and confirms the mock order payment inside this one request so the
 * result never depends on in-memory state shared across serverless instances.
 * The granular prepare/confirm routes remain for API use and tests.
 * Mock theatre only: no funds move.
 */
export async function POST(request: Request) {
  const { orderId } = (await request.json()) as { orderId: string };
  const services = getServices();
  try {
    const prepared = await services.prepareX402OrderPayment(orderId);
    if (!prepared.ok || !prepared.payment) {
      return NextResponse.json(prepared, { status: 409 });
    }
    const confirmed = await services.confirmX402OrderPayment(orderId, prepared.payment.paymentIdentifier);
    if (!confirmed.ok || !confirmed.payment) {
      return NextResponse.json({ ...confirmed, payment: prepared.payment }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      state: confirmed.state,
      payment: {
        paymentIdentifier: confirmed.payment.paymentIdentifier,
        requestDigest: confirmed.payment.requestDigest,
        envelopeDigest: confirmed.payment.envelopeDigest,
        network: confirmed.payment.network,
        asset: confirmed.payment.asset,
        amountMinor: confirmed.payment.amountMinor,
        currency: confirmed.payment.currency,
        recipient: confirmed.payment.recipient,
        mockTxHash: confirmed.payment.mockTxHash ?? null,
        status: confirmed.payment.status,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
