/**
 * Project-specific machine discovery descriptor. This is NOT a UCP, AP2, MCP,
 * or any other protocol-conformance claim — it documents this merchant's own
 * endpoints, authorization rule, live modes, and disclosures so an independent
 * HTTP client can discover and drive the gated purchase flow.
 */
export type DiscoveryModes = {
  razorpay: string;
  x402: string;
  llm: string;
  envelopeSigning: string;
};

export function buildDiscoveryDoc(modes: DiscoveryModes) {
  return {
    name: "agentready-discovery/1",
    protocolConformance: "None claimed. Project-specific descriptor, not UCP, AP2, or MCP.",
    merchant: "RunVista Sports",
    catalog: "/api/catalog",
    conversation: {
      createSession: "POST /api/session",
      respond: "POST /api/respond {orderId, message}",
      quote: "POST /api/quote {orderId, productId, intentVersion, recommendationVersion, recommendationActionToken}",
    },
    authorization: {
      rule: "Human approval is bound to the SHA-256 hash of the exact Commerce Envelope; any material change (SKU, variant, quantity, amounts, currency, delivery, returns, mandate, expiry) invalidates approval and requires re-approval before payment.",
      approve: "POST /api/approve {orderId, digest}",
    },
    payment: {
      initiate: "POST /api/pay/initiate {orderId, rail}",
      mockCapture: "POST /api/pay/mock-capture {orderId} (mock rail only)",
      verify: "POST /api/pay/verify {orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature}",
      rails: ["razorpay_checkout"],
      lifecycle: "POST /api/fulfil {orderId, fail?}, POST /api/compensate {orderId}",
      audit: "GET /api/audit?orderId={orderId}",
      status: "GET /api/status",
    },
    modes: {
      razorpay: modes.razorpay,
      x402: modes.x402,
      llm: modes.llm,
      envelopeSigning: modes.envelopeSigning,
    },
    disclosures: {
      catalog: "Synthetic demo catalog for RunVista Sports (fictional merchant).",
      conformance: "The Agent Commerce Conformance Suite verifies this integration's declared invariants only; it is not a security certification of any third party.",
      reservePay: "UPI Reserve Pay is out of scope without official access.",
      vulcan: "No Vulcan usage is claimed; no mock output is labelled as Vulcan.",
    },
  };
}
