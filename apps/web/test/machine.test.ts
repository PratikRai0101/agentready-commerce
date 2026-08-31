import { describe, expect, it } from "vitest";
import {
  buildPaymentRequired,
  memoForEnvelope,
  parsePaymentRequired,
  parsePaymentResponse,
  type PaymentSignaturePayload,
} from "@agentready/payments";
import { DEFAULT_MACHINE_SPEND, DemoMachineResource, runMachineSpend, signAsAgent } from "../lib/machine";

const HASH = "a".repeat(64);

function signFor(payload: Partial<PaymentSignaturePayload> = {}): string {
  return signAsAgent({
    scheme: "exact",
    network: DEFAULT_MACHINE_SPEND.network,
    paymentIdentifier: "pid_test_1",
    paymentPayload: {
      transaction: "tx_signed_mock_pid_test_1",
      payer: DEFAULT_MACHINE_SPEND.agentWallet,
      amount: "0.010000",
      memo: memoForEnvelope(HASH),
    },
    ...payload,
  });
}

describe("DemoMachineResource 402 flow", () => {
  it("advertises exact USDC devnet payment in PAYMENT-REQUIRED", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const header = resource.quote(HASH);
    const required = parsePaymentRequired(header);
    expect(required.resource).toBe("RunVista Premium Fit-Scoring API");
    const option = required.options[0]!;
    expect(option.scheme).toBe("exact");
    expect(option.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(option.asset).toBe("USDC");
    expect(option.amount).toBe("0.010000");
    expect(option.extra?.memo).toBe(`agentcart:v1:${HASH}`);
    expect(option.paymentIdentifier?.required).toBe(true);
  });

  it("rejects a request without payment and issues 402", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept("", HASH);
    expect(response.status).toBe(402);
    expect(response.headers["PAYMENT-REQUIRED"]).toBeDefined();
  });

  it("accepts a correctly signed payment and returns the resource", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor(), HASH);
    expect(response.status).toBe(200);
    const settlement = parsePaymentResponse(response.headers["PAYMENT-RESPONSE"]!);
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe(DEFAULT_MACHINE_SPEND.network);
    expect(settlement.paymentIdentifier).toBe("pid_test_1");
    expect(settlement.transactionHash).toContain("tx_mock_");
    const body = response.body as { scores: Array<{ productId: string; fitScore: number }> };
    expect(body.scores).toHaveLength(6);
    expect(body.scores.find((s) => s.productId === "p_vista_max")!.fitScore).toBe(95);
  });

  it("rejects underpayment", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.001000", memo: memoForEnvelope(HASH) } }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("underpayment");
  });

  it("rejects a memo that does not anchor the request digest", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ paymentPayload: { transaction: "tx", payer: DEFAULT_MACHINE_SPEND.agentWallet, amount: "0.010000", memo: memoForEnvelope("b".repeat(64)) } }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("memo mismatch");
  });

  it("rejects the wrong network", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const response = resource.accept(signFor({ network: "solana:mainnet-other" }), HASH);
    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).toContain("wrong network");
  });

  it("replays the same payment identifier without a second charge", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const first = resource.accept(signFor(), HASH);
    expect(first.status).toBe(200);
    const second = resource.accept(signFor(), HASH);
    expect(second.status).toBe(200);
    const secondBody = second.body as { note: string };
    expect(secondBody.note).toContain("no second charge");
    expect(resource.hasProcessed("pid_test_1")).toBe(true);
  });
});

describe("runMachineSpend", () => {
  it("completes the full 402 handshake and returns settlement + resource", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const outcome = runMachineSpend(resource, HASH, "pid_flow_1");
    expect(outcome.ok).toBe(true);
    expect(outcome.settlement?.success).toBe(true);
    expect(outcome.settlement?.transactionHash).toBe("tx_mock_pid_flow_1");
    expect(outcome.resource?.scores[0]).toBeDefined();
    expect(outcome.mock).toBe(true);
  });

  it("uses the intent digest as the memo anchor", () => {
    const resource = new DemoMachineResource(DEFAULT_MACHINE_SPEND);
    const required = parsePaymentRequired(resource.quote(HASH));
    expect(required.options[0]!.extra?.memo).toBe(memoForEnvelope(HASH));
    expect(required.options[0]!.extra?.memo).toContain("agentcart:v1:");
  });

  it("builds a well-formed PAYMENT-REQUIRED from the protocol helper", () => {
    const header = buildPaymentRequired("res", [
      {
        scheme: "exact",
        network: DEFAULT_MACHINE_SPEND.network,
        asset: "USDC",
        amount: "0.010000",
        payee: DEFAULT_MACHINE_SPEND.payeeWallet,
        timeout: new Date().toISOString(),
      },
    ]);
    const parsed = parsePaymentRequired(header);
    expect(parsed.resource).toBe("res");
  });
});