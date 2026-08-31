import { verifyRazorpayWebhookSignature } from "@agentready/payments";
import type { AppServices } from "./services";

export type WebhookOutcome =
  | { ok: true; deduplicated: boolean; processed: boolean; held: boolean; summary: string }
  | { ok: false; error: string };

export type RazorpayWebhookPayload = {
  event: string;
  contains?: string[];
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

export async function processRazorpayWebhookRaw(
  services: AppServices,
  rawBody: string,
  signature: string | null,
  eventIdHeader: string | null,
  webhookSecret: string,
): Promise<WebhookOutcome> {
  if (!signature) {
    return { ok: false, error: "Missing x-razorpay-signature header" };
  }

  if (!verifyRazorpayWebhookSignature(webhookSecret, rawBody, signature)) {
    void services.audit.log({
      logicalOrderId: "unknown",
      type: "webhook.signature_invalid",
      actor: "payment",
      summary: "Webhook rejected: signature does not match the raw body bytes",
      decision: "block",
      reasonCodes: ["webhook_signature_invalid"],
    });
    return { ok: false, error: "Invalid webhook signature" };
  }

  let body: RazorpayWebhookPayload;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return { ok: false, error: "Malformed JSON webhook body" };
  }

  const entity = body.payload?.payment?.entity;
  if (!entity?.id) {
    return { ok: false, error: "Malformed webhook payload: no payment entity" };
  }

  const eventId = eventIdHeader ?? `${body.event}_${entity.id}`;
  if (services.isWebhookProcessed(eventId)) {
    return { ok: true, deduplicated: true, processed: false, held: false, summary: `Deduplicated event ${eventId}` };
  }

  if (!entity.order_id) {
    return { ok: false, error: "Webhook has no payment order_id; cannot bind to a session" };
  }

  const session = services.findSessionByExternalOrderId(entity.order_id);
  if (!session) {
    return { ok: false, error: `Webhook for unknown Razorpay order ${entity.order_id}` };
  }

  void services.audit.log({
    logicalOrderId: session.logicalOrderId,
    type: "webhook.received",
    actor: "payment",
    summary: `Webhook ${body.event} for payment ${entity.id} (event ${eventId})`,
    externalReferences: { eventId, paymentId: entity.id, orderId: entity.order_id },
  });

  const notesOrderId = entity.notes?.logicalOrderId;
  if (notesOrderId && notesOrderId !== session.logicalOrderId) {
    void services.audit.log({
      logicalOrderId: session.logicalOrderId,
      type: "webhook.notes_mismatch",
      actor: "payment",
      summary: `notes.logicalOrderId (${notesOrderId}) disagrees with the bound order; order_id is authoritative`,
      decision: "review",
      reasonCodes: ["webhook_notes_untrusted"],
    });
  }

  const record = services.getEnvelope(session.logicalOrderId);
  const bindingFailures: string[] = [];
  if (record) {
    if (entity.amount !== undefined && entity.amount !== record.envelope.totalMinor) {
      bindingFailures.push(`amount ${entity.amount} does not match approved envelope ${record.envelope.totalMinor}`);
    }
    if (entity.currency !== undefined && entity.currency !== record.envelope.currency) {
      bindingFailures.push(`currency ${entity.currency} does not match approved envelope ${record.envelope.currency}`);
    }
    if (entity.status !== "captured") {
      bindingFailures.push(`payment status is ${entity.status ?? "unknown"}, not captured`);
    }
  } else {
    bindingFailures.push("no envelope record for this order");
  }

  if (bindingFailures.length > 0) {
    void services.audit.log({
      logicalOrderId: session.logicalOrderId,
      type: "webhook.binding_rejected",
      actor: "policy",
      summary: `Webhook binding rejected: ${bindingFailures.join("; ")}`,
      externalReferences: { eventId, paymentId: entity.id },
      decision: "block",
      reasonCodes: ["webhook_binding_failed"],
    });
    return { ok: false, error: `Webhook binding rejected: ${bindingFailures.join("; ")}` };
  }

  const isCapture = body.event === "payment.captured" || body.event === "payment.authorized";

  if (session.state === "PAYMENT_PENDING") {
    services.markWebhookProcessed(eventId);
    const result = await services.markVerifiedFromWebhook(session.logicalOrderId, entity.id, entity.order_id, {
      amountMinor: entity.amount,
      currency: entity.currency,
      status: entity.status,
    });
    return {
      ok: true,
      deduplicated: false,
      processed: result.ok,
      held: false,
      summary: result.ok ? `Processed ${eventId}` : `Verified event held for review: ${result.reasons.join("; ")}`,
    };
  }

  if (session.state === "PAYMENT_FAILED") {
    services.holdWebhook(session.logicalOrderId, { eventId, paymentId: entity.id, orderId: entity.order_id });
    void services.audit.log({
      logicalOrderId: session.logicalOrderId,
      type: "webhook.held_for_reconciliation",
      actor: "payment",
      summary: `Valid ${isCapture ? "capture" : "event"} webhook held; client verification previously failed`,
      externalReferences: { eventId, paymentId: entity.id },
      decision: "review",
      reasonCodes: ["out_of_order_webhook_held"],
    });
    return { ok: true, deduplicated: false, processed: false, held: true, summary: `Held for reconciliation: ${eventId}` };
  }

  if (session.state === "PAID_VERIFIED" || session.state === "FULFILMENT_PENDING" || session.state === "FULFILLED") {
    services.markWebhookProcessed(eventId);
    void services.audit.log({
      logicalOrderId: session.logicalOrderId,
      type: "webhook.duplicate_rail_note",
      actor: "payment",
      summary: `Order already paid on one rail; webhook noted, no state change`,
      externalReferences: { eventId, paymentId: entity.id },
      decision: "review",
      reasonCodes: ["rail_single_success"],
    });
    return { ok: true, deduplicated: false, processed: true, held: false, summary: `Order already paid; noted ${eventId}` };
  }

  return { ok: false, error: `Webhook cannot be applied in state ${session.state}` };
}