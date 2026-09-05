import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

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
  const body = (await request.json()) as { orderId: string; sessionToken?: string };
  const { orderId } = body;
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  try {
    const prepared = await services.prepareX402OrderPayment(orderId);
    if (!prepared.ok || !prepared.payment) {
      return NextResponse.json({ ...prepared, sessionToken: await tokenFor(services, orderId) }, { status: 409 });
    }
    const confirmed = await services.confirmX402OrderPayment(orderId, prepared.payment.paymentIdentifier);
    if (!confirmed.ok || !confirmed.payment) {
      return NextResponse.json({ ...confirmed, payment: prepared.payment, sessionToken: await tokenFor(services, orderId) }, { status: 409 });
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
      sessionToken: await tokenFor(services, orderId),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
