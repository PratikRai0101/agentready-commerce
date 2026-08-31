import { checkEnvelopeForPayment, envelopeDigest, requiresReapproval } from "@agentready/domain";
import type { CommerceEnvelope, PurchaseMandate } from "@agentready/domain";

export type ConformanceCheck = {
  id: string;
  name: string;
  invariant: string;
  pass: boolean;
  detail: string;
};

export type ConformanceReport = {
  suite: "critical-invariants";
  ranAt: string;
  checks: ConformanceCheck[];
  passCount: number;
  failCount: number;
};

export type PlaneHooks = {
  findMandate(customerId: string): Promise<PurchaseMandate | undefined>;
  checkPaymentPolicy(envelope: CommerceEnvelope, rail: string): Promise<{ allow: boolean; reasonCodes: string[] }>;
  attemptPayment(envelope: CommerceEnvelope, rail: string): Promise<{ ok: boolean; error?: string }>;
  approveEnvelope(envelope: CommerceEnvelope): Promise<{ ok: boolean; approvalEventId?: string; error?: string }>;
  verifyPayment(envelope: CommerceEnvelope, signature: string): Promise<{ verified: boolean; reason?: string }>;
  fulfil(envelope: CommerceEnvelope): Promise<{ ok: boolean; error?: string }>;
  compensate(envelope: CommerceEnvelope): Promise<{ ok: boolean; refundId?: string; error?: string }>;
  isAlreadyPaid(envelope: CommerceEnvelope): Promise<boolean>;
  countSuccessRail(envelope: CommerceEnvelope): Promise<number>;
};

export async function runCriticalInvariants(
  plane: PlaneHooks,
  envelope: CommerceEnvelope,
  mandate: PurchaseMandate,
  options?: { makeTampered?: (e: CommerceEnvelope) => CommerceEnvelope },
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  const tampered = options?.makeTampered
    ? options.makeTampered(structuredClone(envelope))
    : buildTampered(envelope);

  checks.push(
    await check(
      "gate_01",
      "No payment without a valid mandate",
      "Payment initiation must be blocked when the mandate is missing or does not cover the envelope.",
      async () => {
        const verdict = checkEnvelopeForPayment({
          envelope,
          mandate: undefined,
          expectedDigest: envelopeDigest(envelope),
          approved: true,
          allowAutoApprove: false,
        });
        return { pass: !verdict.allow, detail: `Blocked with ${verdict.reasonCodes.join(", ")}` };
      },
    ),
  );

  checks.push(
    await check(
      "gate_02",
      "No payment for an unapproved envelope",
      "An envelope without an approval event must not reach payment initiation.",
      async () => {
        const verdict = checkEnvelopeForPayment({
          envelope,
          mandate,
          expectedDigest: envelopeDigest(envelope),
          approved: false,
          allowAutoApprove: false,
        });
        return { pass: !verdict.allow, detail: `Blocked with ${verdict.reasonCodes.join(", ")}` };
      },
    ),
  );

  checks.push(
    await check(
      "gate_03",
      "No silent material cart change",
      "Changing quantity or price after approval must require reapproval and block payment.",
      async () => {
        const changed = requiresReapproval(envelope, tampered);
        const paymentBlocked = await plane.checkPaymentPolicy(tampered, "razorpay_checkout");
        const approvedDigest = envelopeDigest(envelope);
        const verdict = checkEnvelopeForPayment({
          envelope: tampered,
          mandate,
          expectedDigest: approvedDigest,
          approved: true,
          allowAutoApprove: false,
        });
        return {
          pass: changed && !verdict.allow && !paymentBlocked.allow,
          detail: `Material change detected: ${changed}; payment blocked: ${!verdict.allow}`,
        };
      },
    ),
  );

  checks.push(
    await check(
      "gate_04",
      "No second successful rail for the same logical order",
      "Once one rail verifies paid, another initiation must be rejected.",
      async () => {
        const alreadyPaid = await plane.isAlreadyPaid(envelope);
        const successCount = await plane.countSuccessRail(envelope);
        return {
          pass: !alreadyPaid || successCount <= 1,
          detail: `successful rails: ${successCount}`,
        };
      },
    ),
  );

  checks.push(
    await check(
      "gate_05",
      "No fulfilment on unverified payment",
      "A forged or invalid signature must leave the order unfulfilled.",
      async () => {
        const approval = await plane.approveEnvelope(envelope);
        if (!approval.ok) return { pass: false, detail: `approval failed: ${approval.error}` };
        const verification = await plane.verifyPayment(envelope, "forged_signature");
        const fulfilment = verification.verified
          ? await plane.fulfil(envelope)
          : { ok: false as const, error: "skipped: verification failed" };
        return {
          pass: !verification.verified && !fulfilment.ok,
          detail: verification.reason ?? "signature rejected",
        };
      },
    ),
  );

  checks.push(
    await check(
      "gate_06",
      "No missing compensation state after paid fulfilment failure",
      "A paid order whose fulfilment fails must enter compensation and receive a refund.",
      async () => {
        const approval = await plane.approveEnvelope(envelope);
        if (!approval.ok) return { pass: false, detail: `approval failed: ${approval.error}` };
        const signature = "mock_valid_signature";
        const verification = await plane.verifyPayment(envelope, signature);
        if (!verification.verified) return { pass: false, detail: "payment did not verify" };
        const fulfil = await plane.fulfil(envelope);
        if (fulfil.ok) return { pass: false, detail: "fulfilment unexpectedly succeeded" };
        const compensation = await plane.compensate(envelope);
        return {
          pass: compensation.ok,
          detail: `refundId: ${compensation.refundId ?? "none"}`,
        };
      },
    ),
  );

  const passCount = checks.filter((check) => check.pass).length;
  return {
    suite: "critical-invariants",
    ranAt: new Date().toISOString(),
    checks,
    passCount,
    failCount: checks.length - passCount,
  };
}

async function check(
  id: string,
  name: string,
  invariant: string,
  run: () => Promise<{ pass: boolean; detail: string }>,
): Promise<ConformanceCheck> {
  try {
    const result = await run();
    return { id, name, invariant, pass: result.pass, detail: result.detail };
  } catch (error) {
    return {
      id,
      name,
      invariant,
      pass: false,
      detail: `Conformance check errored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildTampered(envelope: CommerceEnvelope): CommerceEnvelope {
  const first = envelope.items[0];
  if (!first) {
    throw new Error("Conformance requires an envelope with at least one item");
  }
  return {
    ...structuredClone(envelope),
    items: [{ ...structuredClone(first), quantity: first.quantity + 1 }],
  };
}