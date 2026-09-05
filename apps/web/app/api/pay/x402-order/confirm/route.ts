import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { orderId: string; paymentIdentifier: string; sessionToken?: string };
  const { orderId, paymentIdentifier } = body;
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  try {
    const result = await services.confirmX402OrderPayment(orderId, paymentIdentifier);
    if (!result.ok || !result.payment) {
      return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: 409 });
    }
    return NextResponse.json({
      ok: result.ok,
      state: result.state,
      payment: {
        paymentIdentifier: result.payment.paymentIdentifier,
        requestDigest: result.payment.requestDigest,
        envelopeDigest: result.payment.envelopeDigest,
        network: result.payment.network,
        asset: result.payment.asset,
        amountMinor: result.payment.amountMinor,
        currency: result.payment.currency,
        recipient: result.payment.recipient,
        mockTxHash: result.payment.mockTxHash ?? null,
        status: result.payment.status,
      },
      sessionToken: await tokenFor(services, orderId),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
