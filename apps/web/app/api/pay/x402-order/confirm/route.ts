import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { orderId, paymentIdentifier } = (await request.json()) as { orderId: string; paymentIdentifier: string };
  const services = getServices();
  try {
    const result = await services.confirmX402OrderPayment(orderId, paymentIdentifier);
    if (!result.ok || !result.payment) {
      return NextResponse.json(result, { status: 409 });
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
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
