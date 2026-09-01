"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductMatch } from "@agentready/catalog";
import type { AuditEvent } from "@agentready/audit";
import type { CommerceEnvelope } from "@agentready/domain";
import { RunVistaBrand } from "./components/RunVistaBrand";
import { ProductCard } from "./components/ProductCard";

type QuoteResult = {
  envelope: CommerceEnvelope;
  digest: string;
  signature: string;
  state: string;
  approvalEventId?: string;
};

type MachineSpendInfo = {
  mock: boolean;
  paymentIdentifier: string;
  txHash: string;
  network: string;
  amount: string;
};

type ChatMessage = { role: "user" | "agent"; text: string };

const SUGGESTED = "I need black shoes under \u20B95,000.";

const STEPS = ["Preferences", "Recommendations", "Review", "Approval", "Payment", "Receipt"];

const CARD_ROLES = ["Best overall match", "Cheaper alternative", "Trade-off choice"];

function currentStep(state: string): number {
  if (state === "DRAFT" || state === "CLARIFYING") return 0;
  if (state === "SHORTLISTED" || state === "QUOTED") return 1;
  if (state === "AWAITING_APPROVAL") return 2;
  if (state === "APPROVED") return 3;
  if (state === "PAYMENT_PENDING" || state === "PAID_VERIFIED") return 4;
  if (["FULFILLED", "REFUNDED", "FULFILMENT_FAILED", "COMPENSATION_PENDING"].includes(state)) return 5;
  return 0;
}

function isReceipt(state: string): boolean {
  return ["FULFILLED", "REFUNDED", "FULFILMENT_FAILED", "COMPENSATION_PENDING"].includes(state);
}

function stripScores(text: string): string {
  return text.replace(/,?\s*score\s+\d+/gi, "").replace(/\(\s*score\s+\d+\s*\)/gi, "").trim();
}

function maskId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 6) + "\u2026" + id.slice(-4);
}

function humaniseEvent(event: AuditEvent): string {
  const s = event.summary;
  if (s.includes("Ranked 3 products for")) return "Recommendations ranked";
  if (s.includes("Paid RunVista Premium Fit-Scoring API")) return "Fit-scoring API call (x402)";
  if (s.includes("Session created")) return "Session started";
  if (s.includes("Got it")) {
    const detail = s.replace(/^Got it\s*[—–-]\s*/, "").replace(/\.\s*Before I shortlist.*$/, "").replace(/\.\s*One more detail.*$/, "").trim();
    return `Clarified: ${detail}`;
  }
  if (s.includes("intent.shortlist_ranked")) return "Recommendations ranked";
  if (s.includes("payment.initiated")) return "Razorpay order created";
  if (s.includes("payment.verified")) return "Payment verified and captured";
  if (s.includes("approval.bound")) return "Approval bound to envelope";
  if (s.includes("fulfilment")) return "Fulfilment completed";
  if (s.includes("webhook")) return "Webhook received";
  return s.length > 80 ? s.slice(0, 77) + "\u2026" : s;
}

export default function HomePage() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderState, setOrderState] = useState("DRAFT");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [matches, setMatches] = useState<ProductMatch[] | null>(null);
  const [fitScores, setFitScores] = useState<Record<string, { fitScore: number; note: string }> | null>(null);
  const [machineSpend, setMachineSpend] = useState<MachineSpendInfo | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [rails, setRails] = useState<{ rail: string; isMock: boolean }[]>([]);
  const [indicators, setIndicators] = useState<{ razorpay: string; x402: string; llm: string }>({
    razorpay: "mock",
    x402: "mock",
    llm: "disabled",
  });
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [paymentIds, setPaymentIds] = useState<{ orderId?: string; paymentId?: string; signature?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [techExpanded, setTechExpanded] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, questions]);

  const pushAgent = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "agent", text: stripScores(text) }]);
  }, []);

  const refreshTimeline = useCallback(
    async (order: string) => {
      const response = await fetch(`/api/audit?orderId=${order}`);
      const data = await response.json();
      setTimeline((data.events ?? []).filter((e: AuditEvent) => e.logicalOrderId === order));
    },
    [],
  );

  const startSession = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    setMessages([]);
    setQuestions([]);
    setQuickReplies([]);
    setMatches(null);
    setFitScores(null);
    setMachineSpend(null);
    setQuote(null);
    setTimeline([]);
    setPaymentIds(null);
    const response = await fetch("/api/session", { method: "POST" });
    const data = await response.json();
    setOrderId(data.orderId);
    setOrderState(data.state);
    setRails(data.rails ?? []);
    setIndicators(data.indicators ?? { razorpay: "mock", x402: "mock", llm: "disabled" });
    pushAgent("Hi, I\u2019m the RunVista assistant. Tell me what you\u2019re looking for \u2014 e.g. \u201cblack running shoes under \u20B95,000\u201d.");
    setBusy(false);
  }, [pushAgent]);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || !orderId) return;
      setMessages((prev) => [...prev, { role: "user", text }]);
      setInput("");
      setQuestions([]);
      setQuickReplies([]);
      setBusy(true);
      try {
        const response = await fetch("/api/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, message: text }),
        });
        const data = await response.json();
        setOrderState(data.state);
        if (data.kind === "clarify") {
          pushAgent(data.message);
          setQuestions(data.questions);
          setQuickReplies(data.quickReplies);
        } else if (data.kind === "shortlist") {
          pushAgent(data.message);
          setMatches(data.matches);
          setFitScores(Object.fromEntries((data.fitScores ?? []).map((score: { productId: string; fitScore: number; note: string }) => [score.productId, score])));
          setMachineSpend(data.machineSpend ?? null);
        } else if (data.kind === "error") {
          pushAgent(data.message);
        } else if (data.kind === "pending") {
          pushAgent(data.message);
        } else if (data.kind === "select") {
          await chooseProduct(data.productId);
        } else if (data.kind === "restart") {
          await startSession();
        }
        void refreshTimeline(orderId);
      } catch {
        pushAgent("Something went wrong on our side. Please retry.");
      }
      setBusy(false);
    },
    [orderId, pushAgent, refreshTimeline],
  );

  const chooseProduct = useCallback(
    async (productId: string) => {
      if (!orderId) return;
      setBusy(true);
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, productId }),
      });
      const data = await response.json();
      if (data.error) {
        pushAgent(`Could not quote: ${data.error}`);
      } else {
        setQuote(data);
        setOrderState(data.state);
        pushAgent(`Prepared an exact quote for you. Review and approve the envelope below.`);
      }
      setBusy(false);
    },
    [orderId, pushAgent],
  );

  const approve = useCallback(async () => {
    if (!orderId || !quote) return;
    setBusy(true);
    const response = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, digest: quote.digest }),
    });
    const data = await response.json();
    setOrderState(data.state);
    if (data.ok) {
      pushAgent(`Approval bound to envelope hash ${quote.digest.slice(0, 16)}\u2026`);
      setQuote((prev) => (prev ? { ...prev, approvalEventId: data.approvalEventId } : prev));
    } else {
      pushAgent(`Approval failed: ${data.error}`);
    }
    void refreshTimeline(orderId);
    setBusy(false);
  }, [orderId, quote, pushAgent, refreshTimeline]);

  const initiate = useCallback(async () => {
    if (!orderId || !quote) return;
    setBusy(true);
    const response = await fetch("/api/pay/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, rail: "razorpay_checkout" }),
    });
    const data = await response.json();
    setOrderState(data.state);
    if (!data.ok) {
      pushAgent(`Payment blocked: ${data.error ?? "policy failure"}`);
      setNotice(`Policy blocked payment with codes: ${(data.reasonCodes ?? []).join(", ")}`);
    } else {
      const isMock = rails.find((r) => r.rail === "razorpay_checkout")?.isMock ?? true;
      setPaymentIds({ orderId: data.attempt?.externalOrderId });
      if (isMock) {
        pushAgent("Razorpay order created. Complete the test payment to capture.");
      } else {
        pushAgent("Opening Razorpay Checkout\u2026");
        openRazorpayCheckout(
          data.attempt?.checkoutPayload,
          async (response) => {
            await verifyPayment(response.razorpay_order_id, response.razorpay_payment_id, response.razorpay_signature);
          },
          (message) => pushAgent(message),
        );
      }
    }
    void refreshTimeline(orderId);
    setBusy(false);
  }, [orderId, quote, rails, pushAgent, refreshTimeline]);

  const mockCapture = useCallback(async () => {
    if (!orderId) return;
    setBusy(true);
    const response = await fetch("/api/pay/mock-capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    const data = await response.json();
    if (data.error) {
      pushAgent(`Capture failed: ${data.error}`);
    } else {
      await verifyPayment(data.orderId, data.paymentId, data.signature);
    }
    setBusy(false);
  }, [orderId, pushAgent]);

  const verifyPayment = useCallback(
    async (externalOrderId: string, externalPaymentId: string, signature: string) => {
      if (!orderId) return;
      setBusy(true);
      const response = await fetch("/api/pay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, razorpay_order_id: externalOrderId, razorpay_payment_id: externalPaymentId, razorpay_signature: signature }),
      });
      const data = await response.json();
      setOrderState(data.state);
      setPaymentIds((prev) => ({ ...prev, paymentId: externalPaymentId, signature }));
      if (data.ok) {
        pushAgent(`Payment verified. Order is now PAID_VERIFIED \u2014 fulfilment may begin.`);
      } else {
        pushAgent(`Payment verification failed: ${data.error}`);
      }
      void refreshTimeline(orderId);
      setBusy(false);
    },
    [orderId, pushAgent, refreshTimeline],
  );

  const fulfil = useCallback(
    async (fail: boolean) => {
      if (!orderId) return;
      setBusy(true);
      const response = await fetch("/api/fulfil", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, fail }),
      });
      const data = await response.json();
      setOrderState(data.state);
      pushAgent(data.ok ? "Order fulfilled and shipped." : `Fulfilment failed: ${data.error}`);
      void refreshTimeline(orderId);
      setBusy(false);
    },
    [orderId, pushAgent, refreshTimeline],
  );

  const compensate = useCallback(async () => {
    if (!orderId) return;
    setBusy(true);
    const response = await fetch("/api/compensate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    const data = await response.json();
    setOrderState(data.state);
    pushAgent(data.ok ? `Refund initiated: ${data.refundId ?? "n/a"}` : `Compensation failed: ${data.error}`);
    void refreshTimeline(orderId);
    setBusy(false);
  }, [orderId, pushAgent, refreshTimeline]);

  const resetDemo = useCallback(async () => {
    setBusy(true);
    const response = await fetch("/api/reset", { method: "POST" });
    const data = await response.json();
    setOrderId(data.orderId);
    setOrderState(data.state);
    setMessages([]);
    setQuestions([]);
    setQuickReplies([]);
    setMatches(null);
    setFitScores(null);
    setMachineSpend(null);
    setQuote(null);
    setTimeline([]);
    setPaymentIds(null);
    setNotice(null);
    pushAgent("Server state reset. Fresh conversation started.");
    setBusy(false);
  }, [pushAgent]);

  const runScenario = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    setMessages([]);
    setQuestions([]);
    setQuickReplies([]);
    setMatches(null);
    setFitScores(null);
    setMachineSpend(null);
    setQuote(null);
    setPaymentIds(null);
    const response = await fetch("/api/scenario");
    const data = await response.json();
    setOrderId(data.orderId);
    setOrderState(data.state);
    setTimeline((data.events ?? []).filter((e: AuditEvent) => e.logicalOrderId === data.orderId));
    pushAgent("Hi, I\u2019m the RunVista assistant. Tell me what you\u2019re looking for.");
    pushAgent("I need black shoes under \u20B95,000.");
    for (const clarification of ["UK 9", "Road running up to 10K", "Wide fit", "Cushioning preferred", "Must be returnable", "Delivery before Sunday"]) {
      pushAgent(clarification);
    }
    if (data.final?.message) pushAgent(data.final.message);
    if (data.final?.kind === "shortlist") {
      setMatches(data.final.matches);
      setFitScores(Object.fromEntries((data.final.fitScores ?? []).map((s: { productId: string; fitScore: number; note: string }) => [s.productId, s])));
      setMachineSpend(data.machineSpend ?? data.final.machineSpend ?? null);
    }
    setBusy(false);
  }, [pushAgent]);

  const isMock = rails.find((r) => r.rail === "razorpay_checkout")?.isMock ?? true;
  const step = currentStep(orderState);
  const hasQuickReplies = quickReplies.length > 0;
  const receipt = isReceipt(orderState);

  const heading = receipt
    ? (orderState === "FULFILLED" ? "Your order is on its way" : orderState === "REFUNDED" ? "Refund initiated" : "Order issue reported")
    : matches ? "Your shortlist is ready" : "Find your next running shoe";

  const subheading = receipt
    ? "Thank you for your purchase."
    : matches ? "Based on your requirements and preferences." : "Tell me how you run and I\u2019ll shortlist honest options.";

  /* ── Group ranking events: keep only the last one ── */
  const displayTimeline = (() => {
    const result: AuditEvent[] = [];
    let lastRankIdx = -1;
    for (const event of timeline) {
      if (event.summary.includes("Ranked 3 products for") || event.summary.includes("intent.shortlist_ranked")) {
        if (lastRankIdx >= 0) result[lastRankIdx] = event;
        else { lastRankIdx = result.length; result.push(event); }
      } else {
        result.push(event);
      }
    }
    return result;
  })();

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="topbar" role="banner">
        <RunVistaBrand />
        <nav className="topbar-nav" aria-label="Main navigation">
          <span className="active">Shop</span>
          <button type="button" onClick={() => setDrawerOpen(true)} className="trust-badge">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4L8 1z" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d="M5.5 8l2 2 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Order &amp; trust
          </button>
        </nav>
      </header>

      {/* ── Two-column layout ── */}
      <div className="page-grid">
        {/* ── Chat column ── */}
        <section className="chat-col" aria-label="Conversation">
          <div className="chat-header">
            <h1>{heading}</h1>
            <p>{subheading}</p>
          </div>
          <div className="chat-messages" ref={chatRef} role="log" aria-live="polite">
            {messages.map((message, index) => (
              <div key={index} className={`msg ${message.role}`}>
                {message.text}
              </div>
            ))}
            {questions.length > 0 && (
              <div className="msg agent">
                {questions.length === 1 ? questions[0] : questions.join(" \u00B7 ")}
              </div>
            )}
            {hasQuickReplies && (
              <div className="quick-btns" role="group" aria-label="Quick replies">
                {quickReplies.map((reply) => (
                  <button key={reply} type="button" className="quick-btn" onClick={() => send(reply)} disabled={busy}>
                    {reply}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!receipt && (
            <div className="composer" role="form" aria-label="Message input">
              <input
                className="composer-input"
                type="text"
                value={input}
                placeholder={messages.length === 0 ? SUGGESTED : "Ask about a shoe, compare, or refine\u2026"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void send(input || SUGGESTED);
                }}
                aria-label="Message the assistant"
              />
              <button
                className="composer-send"
                type="button"
                onClick={() => send(input || SUGGESTED)}
                disabled={busy}
              >
                Send
              </button>
            </div>
          )}
        </section>

        {/* ── Content column ── */}
        <section className="content-col" aria-label="Content">
          {/* Progress steps */}
          <div className="progress-steps" role="navigation" aria-label="Order progress">
            {STEPS.map((label, i) => (
              <span key={label} className={`step${i === step ? " active" : ""}`}>
                <span className="step-num">{i + 1}</span> {label}
              </span>
            ))}
          </div>

          {/* Receipt view */}
          {receipt && quote && (
            <ReceiptView
              orderState={orderState}
              quote={quote}
              paymentIds={paymentIds}
            />
          )}

          {/* Constraint chips */}
          {matches && !receipt && (
            <ConstraintChips
              requirements={[
                { label: "UK 9" },
                { label: "Max \u20B95,000" },
                { label: "Road running" },
                { label: "Returnable" },
              ]}
              preferences={[
                { label: "Black" },
                { label: "Wide fit" },
                { label: "Cushioning" },
              ]}
            />
          )}

          {/* Recommendations */}
          {matches && !receipt && (
            <>
              <div className="recs-header">
                <h2>Recommendations</h2>
              </div>
              <div className="recs-grid">
                {matches.map((match, idx) => (
                  <ProductCard
                    key={match.product.productId}
                    match={match}
                    fitScore={fitScores?.[match.product.productId]}
                    roleLabel={CARD_ROLES[idx] ?? "Option"}
                    onSelect={chooseProduct}
                    disabled={busy}
                    showSelect={!quote}
                  />
                ))}
              </div>
            </>
          )}

          {/* Empty state */}
          {!matches && !receipt && messages.length > 0 && (
            <div className="empty-state">
              <h3>Recommendations appear here</h3>
              <p>Answer the question above and I\u2019ll shortlist your best matches.</p>
            </div>
          )}

          {/* Quote / approval panel */}
          {quote && !receipt && (
            <div style={{ marginTop: 20 }}>
              <ApprovalPanel quote={quote} onApprove={approve} busy={busy} />
            </div>
          )}

          {/* Payment controls */}
          {quote && quote.approvalEventId && !receipt && (
            <div style={{ marginTop: 16 }}>
              <PaymentControls
                orderState={orderState}
                paymentIds={paymentIds}
                isMock={isMock}
                busy={busy}
                onInitiate={initiate}
                onMockCapture={mockCapture}
                onFulfil={() => fulfil(false)}
                onCompensate={compensate}
              />
            </div>
          )}

          {/* Notice */}
          {notice && (
            <div style={{ marginTop: 16, padding: 14, background: "var(--warn-soft)", borderRadius: "var(--radius)", fontSize: 13, color: "var(--warn)" }}>
              {notice}
            </div>
          )}

          {/* Builder demo link */}
          <div style={{ marginTop: "auto", paddingTop: 20 }}>
            <a href="/demo" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>
              Builder demo &rarr;
            </a>
          </div>
        </section>
      </div>

      {/* ── Trust Drawer ── */}
      <TrustDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        quote={quote}
        paymentIds={paymentIds}
        timeline={displayTimeline}
        machineSpend={machineSpend}
        orderState={orderState}
        isMock={isMock}
        indicators={indicators}
        techExpanded={techExpanded}
        onToggleTech={() => setTechExpanded(!techExpanded)}
        onRunScenario={runScenario}
        onReset={resetDemo}
        busy={busy}
      />
    </div>
  );
}

/* ─── Receipt View ─── */

function ReceiptView({
  orderState,
  quote,
  paymentIds,
}: {
  orderState: string;
  quote: QuoteResult;
  paymentIds: { orderId?: string; paymentId?: string; signature?: string } | null;
}) {
  const { envelope } = quote;
  const item = envelope.items[0];
  const statusText =
    orderState === "FULFILLED" ? "Your order is on its way" :
    orderState === "REFUNDED" ? "Refund initiated" :
    orderState === "FULFILMENT_FAILED" ? "There was an issue with fulfilment" :
    "Order confirmed";

  return (
    <div className="demo-panel" style={{ borderLeftColor: "var(--good)", borderLeftWidth: 3 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--good)", marginBottom: 8 }}>{statusText}</div>
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 10px", fontSize: 12 }}>
        <span style={{ color: "var(--text-soft)" }}>Product</span>
        <span>{item?.sku}</span>
        <span style={{ color: "var(--text-soft)" }}>Size</span>
        <span>{item?.variant?.size}</span>
        <span style={{ color: "var(--text-soft)" }}>Subtotal</span>
        <span>{"\u20B9"}{(envelope.subtotalMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Shipping</span>
        <span>{"\u20B9"}{(envelope.shippingMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Total</span>
        <span style={{ fontWeight: 600 }}>{"\u20B9"}{(envelope.totalMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Payment</span>
        <span>{paymentIds?.paymentId ? `Verified \u2014 ${maskId(paymentIds.paymentId)}` : "Verified"}</span>
        <span style={{ color: "var(--text-soft)" }}>Return</span>
        <span>Returnable within 14 days, unworn</span>
      </div>
    </div>
  );
}

/* ─── Constraint Chips ─── */

function ConstraintChips({
  requirements,
  preferences,
}: {
  requirements: { label: string }[];
  preferences: { label: string }[];
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="chip-group-label">Requirements</div>
      <div className="chip-row">
        {requirements.map((r) => (
          <span key={r.label} className="chip requirement">
            {r.label} <span className="chip-x" aria-hidden="true">&times;</span>
          </span>
        ))}
      </div>
      <div className="chip-group-label" style={{ marginTop: 8 }}>Preferences</div>
      <div className="chip-row">
        {preferences.map((p) => (
          <span key={p.label} className="chip preference">
            {p.label} <span className="chip-x" aria-hidden="true">&times;</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Approval Panel ─── */

function ApprovalPanel({
  quote,
  onApprove,
  busy,
}: {
  quote: QuoteResult;
  onApprove: () => void;
  busy: boolean;
}) {
  const { envelope } = quote;
  return (
    <div className="demo-panel" style={{ borderLeftColor: quote.approvalEventId ? "var(--good)" : "var(--accent)", borderLeftWidth: 3 }}>
      <h3>Order review {quote.approvalEventId ? "\u2014 approved" : ""}</h3>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {envelope.items[0]?.variant?.size} {envelope.items.map((item) => item.sku).join(", ")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 10px", fontSize: 12, marginBottom: 10 }}>
        <span style={{ color: "var(--text-soft)" }}>Item</span>
        <span>{envelope.items[0]?.sku}</span>
        <span style={{ color: "var(--text-soft)" }}>Quantity</span>
        <span>{envelope.items[0]?.quantity}</span>
        <span style={{ color: "var(--text-soft)" }}>Subtotal</span>
        <span>{"\u20B9"}{(envelope.subtotalMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Shipping</span>
        <span>{"\u20B9"}{(envelope.shippingMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Total</span>
        <span style={{ fontWeight: 600 }}>{"\u20B9"}{(envelope.totalMinor / 100).toFixed(2)}</span>
        <span style={{ color: "var(--text-soft)" }}>Return</span>
        <span>Returnable within 14 days, unworn</span>
      </div>
      {!quote.approvalEventId && (
        <button className="demo-btn primary" type="button" onClick={onApprove} disabled={busy}>
          Approve exact envelope hash
        </button>
      )}
    </div>
  );
}

/* ─── Payment Controls ─── */

function PaymentControls({
  orderState,
  paymentIds,
  isMock,
  busy,
  onInitiate,
  onMockCapture,
  onFulfil,
  onCompensate,
}: {
  orderState: string;
  paymentIds: { orderId?: string; paymentId?: string; signature?: string } | null;
  isMock: boolean;
  busy: boolean;
  onInitiate: () => void;
  onMockCapture: () => void;
  onFulfil: () => void;
  onCompensate: () => void;
}) {
  return (
    <div className="demo-panel">
      <h3>Payment</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {!paymentIds?.orderId && (
          <button className="demo-btn primary" type="button" onClick={onInitiate} disabled={busy}>
            Pay with Razorpay
          </button>
        )}
        {paymentIds?.orderId && isMock && !paymentIds.paymentId && (
          <button className="demo-btn primary" type="button" onClick={onMockCapture} disabled={busy}>
            Complete test payment
          </button>
        )}
        {paymentIds?.orderId && !isMock && !paymentIds.paymentId && (
          <button className="demo-btn primary" type="button" onClick={onInitiate} disabled={busy}>
            Reopen Razorpay Checkout
          </button>
        )}
      </div>
      {paymentIds?.orderId && (
        <div style={{ fontSize: 12, color: "var(--text-soft)" }}>
          Order: <span style={{ fontFamily: "var(--mono)" }}>{maskId(paymentIds.orderId)}</span>
          {paymentIds.paymentId && (
            <> &middot; payment: <span style={{ fontFamily: "var(--mono)" }}>{maskId(paymentIds.paymentId)}</span></>
          )}
          {paymentIds.signature && <> &middot; signature verified</>}
        </div>
      )}
      {(orderState === "PAID_VERIFIED" || orderState === "FULFILMENT_PENDING") && (
        <div style={{ marginTop: 8 }}>
          <button className="demo-btn primary" type="button" onClick={onFulfil} disabled={busy}>Fulfil order</button>
        </div>
      )}
      {(orderState === "FULFILMENT_FAILED" || orderState === "COMPENSATION_PENDING") && (
        <div style={{ marginTop: 8 }}>
          <button className="demo-btn primary" type="button" onClick={onCompensate} disabled={busy}>Start refund</button>
        </div>
      )}
    </div>
  );
}

/* ─── Trust Drawer ─── */

function TrustDrawer({
  open,
  onClose,
  quote,
  paymentIds,
  timeline,
  machineSpend,
  orderState,
  isMock,
  indicators,
  techExpanded,
  onToggleTech,
  onRunScenario,
  onReset,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteResult | null;
  paymentIds: { orderId?: string; paymentId?: string; signature?: string } | null;
  timeline: AuditEvent[];
  machineSpend: MachineSpendInfo | null;
  orderState: string;
  isMock: boolean;
  indicators: { razorpay: string; x402: string; llm: string };
  techExpanded: boolean;
  onToggleTech: () => void;
  onRunScenario: () => void;
  onReset: () => void;
  busy: boolean;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const hasCaptured = quote?.approvalEventId && ["PAID_VERIFIED", "FULFILMENT_PENDING", "FULFILLED"].includes(orderState);

  return (
    <>
      <div className={`drawer-scrim${open ? " open" : ""}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className={`drawer${open ? " open" : ""}`}
        role="dialog"
        aria-label="Order and trust"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="drawer-head">
          <h2>Order &amp; trust</h2>
          <button className="drawer-close" type="button" onClick={onClose} aria-label="Close drawer">&times;</button>
        </div>
        <div className="drawer-body">
          {/* 1. Payment verification */}
          <div className="drawer-section">
            <h3>1 &middot; Payment verification</h3>
            <div className="drawer-box">
              {hasCaptured ? (
                <div className="drawer-status">
                  {"\u2713"} Captured &mdash; {"\u20B9"}{(quote!.envelope.totalMinor / 100).toFixed(2)} {quote!.envelope.currency}
                </div>
              ) : quote?.approvalEventId ? (
                <div style={{ fontSize: 13, color: "var(--good)" }}>Approved &mdash; awaiting capture</div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Awaiting payment</div>
              )}
              {paymentIds?.orderId && (
                <div className="drawer-kv">
                  <span className="label">Order</span>
                  <span className="mono">{maskId(paymentIds.orderId)}</span>
                </div>
              )}
              {paymentIds?.paymentId && (
                <div className="drawer-kv">
                  <span className="label">Payment</span>
                  <span className="mono">{maskId(paymentIds.paymentId)}</span>
                </div>
              )}
              {paymentIds?.signature && (
                <div style={{ fontSize: 12, color: "var(--good)" }}>Signature verified</div>
              )}
            </div>
          </div>

          {/* 2. Approved order */}
          <div className="drawer-section">
            <h3>2 &middot; Approved order</h3>
            <div className="drawer-box">
              {quote ? (
                <>
                  <div className="drawer-kv">
                    <span className="label">Item</span>
                    <span className="value">{quote.envelope.items[0]?.sku}</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Size</span>
                    <span className="value">{quote.envelope.items[0]?.variant?.size}</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Subtotal</span>
                    <span className="value">{"\u20B9"}{(quote.envelope.subtotalMinor / 100).toFixed(2)}</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Shipping</span>
                    <span className="value">{"\u20B9"}{(quote.envelope.shippingMinor / 100).toFixed(2)}</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Total</span>
                    <span className="value" style={{ fontWeight: 600 }}>{"\u20B9"}{(quote.envelope.totalMinor / 100).toFixed(2)}</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Return</span>
                    <span className="value">Returnable within 14 days, unworn</span>
                  </div>
                  <div className="drawer-kv">
                    <span className="label">Envelope</span>
                    <span className="mono">{maskId(quote.digest)}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No order yet</div>
              )}
            </div>
          </div>

          {/* 3. Audit history */}
          <div className="drawer-section">
            <h3>3 &middot; Audit history</h3>
            <div className="drawer-box">
              {timeline.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No events yet.</div>
              ) : (
                <div className="drawer-timeline">
                  {timeline.map((event) => (
                    <div key={event.eventId} className="timeline-row">
                      <span className="event">{humaniseEvent(event)}</span>
                      <span className="time">{new Date(event.occurredAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 4. Technical details (expandable) */}
          <div className="drawer-section">
            <button className="drawer-tech-toggle" type="button" onClick={onToggleTech}>
              4 &middot; Technical details <span style={{ marginLeft: 4 }}>{techExpanded ? "\u25B2" : "\u25BC"}</span>
            </button>
            {techExpanded && (
              <div className="drawer-box" style={{ marginTop: 8 }}>
                {/* x402 machine spend */}
                {machineSpend && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-soft)", marginBottom: 4 }}>x402 Machine spend</div>
                    <div style={{ fontSize: 12 }}>
                      {machineSpend.amount} USDC via x402 v2 &middot; {machineSpend.network} &middot;{" "}
                      <span className="mono">{maskId(machineSpend.txHash)}</span> &middot; {machineSpend.mock ? "MOCK" : "live"}
                    </div>
                  </div>
                )}

                {/* Full audit with raw data */}
                {timeline.map((event) => (
                  <div key={event.eventId} className="tech-event">
                    <div className="tech-event-head">
                      <span className="mono" style={{ fontSize: 11 }}>{event.type}</span>
                      <span className="time">{new Date(event.occurredAt).toLocaleTimeString()}</span>
                    </div>
                    <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>{event.summary}</div>
                    {event.externalReferences && (
                      <div className="mono" style={{ fontSize: 10, marginTop: 2, overflowWrap: "anywhere" }}>
                        {Object.entries(event.externalReferences).map(([k, v]) => `${k}: ${maskId(String(v))}`).join(" \u00B7 ")}
                      </div>
                    )}
                  </div>
                ))}

                {/* Providers */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-soft)", marginBottom: 4 }}>Providers</div>
                  <div className="provider-row">
                    <span className="prov-name">Razorpay</span>
                    <span className="prov-detail">rzp_test_ keys &middot; capture verified</span>
                    <span className={`prov-mode ${indicators.razorpay}`}>{indicators.razorpay === "test" ? "TEST MODE" : indicators.razorpay === "live" ? "live" : "MOCK"}</span>
                  </div>
                  <div className="provider-row">
                    <span className="prov-name">x402 / Solana</span>
                    <span className="prov-detail">demo settlement</span>
                    <span className="prov-mode mock">MOCK</span>
                  </div>
                  <div className="provider-row">
                    <span className="prov-name">LLM</span>
                    <span className="prov-detail">deterministic fallback active</span>
                    <span className="prov-mode disabled">disabled</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Demo quick actions */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="demo-btn" type="button" onClick={onRunScenario} disabled={busy}>Run scenario</button>
            <button className="demo-btn" type="button" onClick={onReset} disabled={busy}>Reset</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── Helpers ─── */

function openRazorpayCheckout(
  payload: Record<string, unknown> | undefined,
  onSuccess: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void,
  onCancel: (message: string) => void,
) {
  if (!payload) {
    onCancel("Checkout could not be opened: no payment payload from the server.");
    return;
  }
  const script = document.createElement("script");
  script.src = "https://checkout.razorpay.com/v1/checkout.js";
  script.onload = () => {
    const razorpay = (window as unknown as {
      Razorpay: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (response: { error?: { description?: string }; code?: string }) => void) => void };
    }).Razorpay;
    const instance = new razorpay({
      ...payload,
      handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        onSuccess(response);
      },
      modal: {
        ondismiss: () => {
          onCancel("Checkout closed without completing payment. The order remains PAYMENT_PENDING.");
        },
      },
    });
    instance.on("payment.failed", (response) => {
      onCancel(`Payment failed: ${response.error?.description ?? response.code ?? "unknown reason"}. No charge was captured.`);
    });
    instance.open();
  };
  script.onerror = () => {
    onCancel("Could not load the Razorpay Checkout script. Check your network connection.");
  };
  document.body.appendChild(script);
}
