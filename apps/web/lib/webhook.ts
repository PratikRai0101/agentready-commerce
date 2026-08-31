import { razorpaySignature, verifyRazorpayWebhookSignature } from "@agentready/payments";
import type { AppServices } from "./services";

export type WebhookOutcome =
  | { ok: true; deduplicated: boolean; processed: boolean; summary: string }
  | { ok: false; error: string };

export type RazorpayWebhookPayload = {
  event: string;
  account_id?: string;
  contains: string[];
  payload: {
    payment: {
      entity: {
        id: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        notes?: Record<string, string>;
      };
    };
  };
};

export function processRazorpayWebhook(
  services: AppServices,
  payload: unknown,
  signature: string | null,
  webhookSecret: string,
): WebhookOutcome {
  if (!signature) {
    return { ok: false, error: "Missing x-razorpay-signature header" };
  }

  const rawBody = JSON.stringify(payload);
  if (!verifyRazorpayWebhookSignature(webhookSecret, rawBody, signature)) {
    void services.audit.log({
      logicalOrderId: "unknown",
      type: "webhook.signature_invalid",
      actor: "payment",
      summary: "Webhook rejected: invalid signature",
      decision: "block",
      reasonCodes: ["webhook_signature_invalid"],
    });
    return { ok: false, error: "Invalid webhook signature" };
  }

  const body = payload as RazorpayWebhookPayload;
  const entity = body.payload?.payment?.entity;
  if (!entity?.id) {
    return { ok: false, error: "Malformed webhook payload: no payment entity" };
  }

  const eventId = `${body.event}_${entity.id}`;
  if (services.isWebhookProcessed(eventId)) {
    return { ok: true, deduplicated: true, processed: false, summary: `Deduplicated event ${eventId}` };
  }

  const logicalOrderId = entity.notes?.logicalOrderId;
  const session = logicalOrderId ? services.getSession(logicalOrderId) : undefined;
  if (!session) {
    return { ok: false, error: `Webhook for unknown order ${logicalOrderId ?? "none"}` };
  }

  void services.audit.log({
    logicalOrderId: session.logicalOrderId,
    type: "webhook.received",
    actor: "payment",
    summary: `Webhook ${body.event} for payment ${entity.id}`,
    externalReferences: { eventId, paymentId: entity.id, orderId: entity.order_id ?? "" },
  });

  if (body.event === "payment.captured" && entity.status === "captured" && session.state === "PAYMENT_PENDING") {
    void services.markVerifiedFromWebhook(session.logicalOrderId, entity.id, entity.order_id ?? "");
  }

  return { ok: true, deduplicated: false, processed: true, summary: `Processed ${eventId}` };
}