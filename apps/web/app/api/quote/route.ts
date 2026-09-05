import { NextResponse } from "next/server";
import { getServices, QuoteValidationError, type RecommendationBinding } from "@/lib/services";
import { readSessionToken, restoreSession, tokenFor } from "@/lib/session-token";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    orderId: string;
    productId: string;
    intentVersion?: number;
    recommendationVersion?: number;
    recommendationActionToken?: string;
  };
  const { orderId, productId } = body;
  if (!orderId || !productId) {
    return NextResponse.json({ error: "orderId and productId are required" }, { status: 400 });
  }
  const services = getServices();
  try {
    await restoreSession(services, orderId, readSessionToken(request, body));
    const binding: RecommendationBinding | undefined =
      typeof body.intentVersion === "number" &&
      typeof body.recommendationVersion === "number" &&
      typeof body.recommendationActionToken === "string"
        ? {
            intentVersion: body.intentVersion,
            recommendationVersion: body.recommendationVersion,
            recommendationActionToken: body.recommendationActionToken,
          }
        : undefined;
    const quote = await services.buildQuote(orderId, productId, binding);
    return NextResponse.json({ ...quote, sessionToken: await tokenFor(services, orderId) });
  } catch (error) {
    if (error instanceof QuoteValidationError) {
      return NextResponse.json(
        {
          kind: "error",
          error: error.message,
          state: services.getSession(orderId)?.state,
          matches: error.matches,
          ...error.binding,
          selectionRejected: true,
          rejectedProductId: error.rejectedProductId,
          sessionToken: await tokenFor(services, orderId),
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
