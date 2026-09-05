import { NextRequest, NextResponse } from "next/server";
import { buildDevnetToolSpendRequest, loadX402Config, SOLANA_DEVNET_CAIP2 } from "@agentready/payments";
import { DevnetMachineResource } from "@agentready/payments/devnet-machine";
import { DemoMachineResource, DEFAULT_MACHINE_SPEND, getDevnetMachineResource, runMachineSpend } from "@/lib/machine";
import { getServices } from "@/lib/services";
import { SettlementDisabledError } from "@agentready/payments/x402-settlement-store";
import type { X402DevnetConfig } from "@agentready/payments/x402-config";
import type { ToolSpendRequest } from "@agentready/payments";

function getDevnetResource(): DevnetMachineResource {
  // No local cache: the shared factory owns the singleton (test-override
  // aware), so test doubles never leak across requests.
  return getDevnetMachineResource();
}

const RESOURCE_URL = "/api/resources/premium-fit-score";

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function addReference(references: Record<string, string>, key: string, value: unknown): void {
  if ((typeof value === "string" && value.length > 0) || typeof value === "number" || typeof value === "boolean") {
    references[key] = String(value);
  }
}

async function auditResourceOutcome(
  orderId: string,
  requestDigest: string,
  response: { status: number; body: unknown },
  paymentPresented: boolean,
): Promise<void> {
  // A quote is not a payment attempt. Once a signature is presented, every
  // outcome needs a timeline entry, including an ambiguous post-submit result.
  if (response.status !== 200 && !paymentPresented) return;

  const body = recordFrom(response.body);
  const evidence = recordFrom(body.settlementEvidence);
  const reconciliationState = typeof body.reconciliationState === "string"
    ? body.reconciliationState
    : response.status === 200 ? "settled" : "rejected";
  const type = response.status === 200
    ? "machine.paid_resource"
    : reconciliationState === "pending"
      ? "machine.spend_pending"
      : reconciliationState === "manual_reconciliation_required"
        ? "machine.spend_manual_reconciliation"
        : "machine.spend_failed";
  const references: Record<string, string> = {};
  addReference(references, "resource", RESOURCE_URL);
  addReference(references, "responseStatus", response.status);
  addReference(references, "requestDigest", requestDigest);
  addReference(references, "paymentIdentifier", body.paymentIdentifier ?? evidence.paymentIdentifier);
  addReference(references, "txHash", body.transactionHash ?? evidence.transactionHash);
  addReference(references, "network", evidence.network);
  addReference(references, "asset", evidence.asset);
  addReference(references, "amount", evidence.amount);
  addReference(references, "payer", evidence.payer);
  addReference(references, "payee", evidence.payee);
  addReference(references, "feePayer", evidence.feePayer);
  addReference(references, "explorerUrl", evidence.explorerUrl);
  addReference(references, "reconciliationState", reconciliationState);
  addReference(references, "retryable", body.retryable);

  try {
    const services = getServices();
    const paymentIdentifier = references.paymentIdentifier;
    if (paymentIdentifier) {
      const existing = await services.audit.timeline(orderId);
      if (existing.some((event) => event.type === type
        && event.externalReferences?.paymentIdentifier === paymentIdentifier
        && (event.externalReferences?.requestDigest ?? event.inputDigest) === requestDigest)) {
        return;
      }
    }
    await services.audit.log({
      logicalOrderId: orderId,
      type,
      actor: "payment",
      summary: type === "machine.paid_resource"
        ? "Premium fit-score resource served after x402 SOLANA DEVNET settlement — test tokens, no real money."
        : type === "machine.spend_pending"
          ? "Premium fit-score settlement is pending; the original signed attempt is retained for reconciliation without a replacement payment."
          : type === "machine.spend_manual_reconciliation"
            ? "Premium fit-score settlement requires manual reconciliation; no replacement payment will be submitted."
            : "Premium fit-score payment was rejected before the resource was served.",
      inputDigest: requestDigest,
      externalReferences: references,
      decision: type === "machine.paid_resource" ? "allow" : "review",
      reasonCodes: type === "machine.paid_resource"
        ? ["x402_devnet_settlement_verified", "machine_tool_spend"]
        : type === "machine.spend_pending"
          ? ["x402_settlement_pending", "x402_original_attempt_retained"]
          : type === "machine.spend_manual_reconciliation"
            ? ["x402_manual_reconciliation_required", "x402_original_attempt_retained"]
            : ["x402_payment_rejected"],
    });
  } catch {
    // Audit failure must not turn a verified payment into another ambiguous
    // HTTP result. The durable settlement record remains the payment recovery
    // source of truth.
    console.error("premium-fit-score audit append failed");
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requestDigest: callerDigest, paymentIdentifier, spendingRequest: callerSpendingRequest, approvalEventId: callerApprovalEventId } = body as {
      requestDigest?: string;
      paymentIdentifier?: string;
      spendingRequest?: ToolSpendRequest;
      approvalEventId?: string;
    };

    const config = loadX402Config();

    if (config.mode === "mock") {
      const requestDigest = callerDigest ?? "";
      if (!requestDigest) {
        return NextResponse.json(
          { error: "requestDigest is required" },
          { status: 400 },
        );
      }
      const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
      const pid = paymentIdentifier || `pid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const outcome = runMachineSpend(resource, requestDigest, pid);

      if (!outcome.ok || !outcome.settlement || !outcome.resource) {
        return NextResponse.json(
          { error: "mock_payment_failed", detail: "Mock payment did not complete successfully." },
          { status: 402 },
        );
      }

      return NextResponse.json({
        mode: "mock",
        resource: outcome.resource,
        settlement: {
          network: outcome.settlement.network,
          transactionHash: outcome.settlement.transactionHash,
          amount: outcome.settlement.amount,
          payer: outcome.settlement.payer,
          mock: true,
          label: "x402 MOCK — no funds moved",
        },
      });
    }

    const devnetConfig = config as X402DevnetConfig;
    if (!callerDigest || !callerSpendingRequest ||
      typeof callerSpendingRequest.orderId !== "string" ||
      !Number.isInteger(callerSpendingRequest.intentVersion)) {
      return NextResponse.json(
        { error: "spending_request_required", detail: "A complete trusted spendingRequest and requestDigest are required." },
        { status: 400 },
      );
    }

    const canonicalSpendingRequest: ToolSpendRequest = buildDevnetToolSpendRequest(
      devnetConfig,
      callerSpendingRequest.orderId,
      callerSpendingRequest.intentVersion,
    );

    // A presented approval id is verified against the server-held session —
    // never trusted from the caller alone. It binds post-release attempts to
    // the fresh authorization (see x402-settlement-store identity rules).
    if (callerApprovalEventId) {
      const session = getServices().getSession(callerSpendingRequest.orderId);
      if (session?.approvalEventId && session.approvalEventId !== callerApprovalEventId) {
        return NextResponse.json(
          { error: "approval_mismatch", detail: "Presented approval does not match this order's current approval." },
          { status: 409 },
        );
      }
    }

    let resource: DevnetMachineResource;
    try {
      resource = getDevnetResource();
    } catch (error) {
      if (error instanceof SettlementDisabledError) {
        return NextResponse.json(
          { error: "settlement_unavailable", detail: "x402 settlement is disabled by operator kill-switch." },
          { status: 503 },
        );
      }
      throw error;
    }
    const requestDigest = resource.buildRequestDigest(canonicalSpendingRequest);

    if (callerDigest && callerDigest !== requestDigest) {
      return NextResponse.json(
        { error: "digest_mismatch", detail: "Caller-supplied requestDigest does not match server-computed canonical terms." },
        { status: 400 },
      );
    }

    const paymentSignature = request.headers.get("PAYMENT-SIGNATURE");

    if (!paymentSignature) {
      const requiredHeader = await resource.quote(requestDigest);
      return NextResponse.json(
        {
          error: "payment_required",
          detail: "This resource requires x402 payment. See PAYMENT-REQUIRED header.",
        },
        {
          status: 402,
          headers: { "PAYMENT-REQUIRED": requiredHeader },
        },
      );
    }

    const response = await resource.accept(paymentSignature, requestDigest, canonicalSpendingRequest, {
      approvalEventId: callerApprovalEventId,
    });
    await auditResourceOutcome(
      canonicalSpendingRequest.orderId,
      requestDigest,
      response,
      Boolean(paymentSignature),
    );

    if (response.status !== 200) {
      return NextResponse.json(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }

    return NextResponse.json(response.body, {
      status: 200,
      headers: {
        ...response.headers,
        "X-X402-MODE": "devnet",
        "X-X402-LABEL": "x402 SOLANA DEVNET - test tokens, no real money",
      },
    });
  } catch (err) {
    // Server-side signal only: error message, never the signed payload,
    // keypair material, credentials, or request bodies.
    console.error(
      `premium-fit-score route failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json(
      { error: "internal_error", detail: "An unexpected error occurred processing the x402 request." },
      { status: 500 },
    );
  }
}
