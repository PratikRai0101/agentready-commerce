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
  } catch {
    return NextResponse.json(
      { error: "internal_error", detail: "An unexpected error occurred processing the x402 request." },
      { status: 500 },
    );
  }
}
