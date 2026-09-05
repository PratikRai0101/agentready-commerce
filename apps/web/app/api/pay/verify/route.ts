import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    orderId: string;
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  };
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return NextResponse.json({ error: "orderId and payment response fields are required" }, { status: 400 });
  }
  const services = getServices();
  await restoreSession(services, orderId, readSessionToken(request, body));
  const result = await services.verifyPayment(orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature);
  return NextResponse.json({ ...result, sessionToken: await tokenFor(services, orderId) }, { status: result.ok ? 200 : 409 });
}