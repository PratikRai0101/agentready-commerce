import { NextResponse } from "next/server";
import { getServices, type RecommendationBinding } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    orderId: string;
    message: string;
    intentVersion?: number;
    recommendationVersion?: number;
    recommendationActionToken?: string;
  };
  const { orderId, message } = body;
  if (!orderId || !message?.trim()) {
    return NextResponse.json({ error: "orderId and message are required" }, { status: 400 });
  }
  const services = getServices();
  try {
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
    const result = await services.respond(orderId, message.trim(), binding);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
