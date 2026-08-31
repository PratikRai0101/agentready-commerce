"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductMatch } from "@agentready/catalog";
import type { AuditEvent } from "@agentready/audit";
import type { ConformanceReport } from "@agentready/conformance";
import type { CommerceEnvelope } from "@agentready/domain";

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

const SUGGESTED = "I need black shoes under ₹5,000.";

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
  const [conformance, setConformance] = useState<ConformanceReport | null>(null);
  const [paymentIds, setPaymentIds] = useState<{ orderId?: string; paymentId?: string; signature?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, questions]);

  const pushAgent = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "agent", text }]);
  }, []);

  const refreshTimeline = useCallback(
    async (order: string) => {
      const response = await fetch(`/api/audit?orderId=${order}`);
      const data = await response.json();
      setTimeline(data.events ?? []);
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
    setConformance(null);
    setPaymentIds(null);
    const response = await fetch("/api/session", { method: "POST" });
    const data = await response.json();
    setOrderId(data.orderId);
    setOrderState(data.state);
    setRails(data.rails ?? []);
    setIndicators(data.indicators ?? { razorpay: "mock", x402: "mock", llm: "disabled" });
    pushAgent("Hi, I'm the RunVista assistant. Tell me what you're looking for — e.g. \u201cblack running shoes under ₹5,000\u201d.");
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
      pushAgent(`Approval bound to envelope hash ${quote.digest.slice(0, 16)}…`);
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
        pushAgent("Opening Razorpay Checkout…");
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
        pushAgent(`Payment verified. Order is now PAID_VERIFIED — fulfilment may begin.`);
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

  const tamper = useCallback(
    async (field: "price" | "variant") => {
      if (!orderId) return;
      setBusy(true);
      const response = await fetch("/api/tamper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, field }),
      });
      const data = await response.json();
      setOrderState(data.state);
      if (data.ok) {
        setQuote(null);
        pushAgent(`Material change detected: ${data.changes.join("; ")}. Approval invalidated — REAPPROVAL_REQUIRED.`);
        setNotice("Approval invalidated. A new envelope with the changed terms must be approved before payment.");
      } else {
        pushAgent(`Tamper simulation failed: ${data.error}`);
      }
      void refreshTimeline(orderId);
      setBusy(false);
    },
    [orderId, pushAgent, refreshTimeline],
  );

  const replayWebhook = useCallback(async () => {
    if (!orderId) return;
    setBusy(true);
    const first = await fetch("/api/webhook/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, replay: false }),
    });
    const firstData = await first.json();
    const second = await fetch("/api/webhook/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, replay: true }),
    });
    const secondData = await second.json();
    pushAgent(
      `Webhook replay: first delivery ${firstData.processed ? "processed" : "failed"} (${firstData.deduplicated ? "dedup" : "fresh"}), ` +
        `second delivery ${secondData.deduplicated ? "deduplicated — no second state transition" : "processed"}.`,
    );
    setOrderState((await fetch(`/api/audit?orderId=${orderId}`)).ok ? orderState : orderState);
    void refreshTimeline(orderId);
    setBusy(false);
  }, [orderId, pushAgent, refreshTimeline, orderState]);

  const runConformance = useCallback(async () => {
    if (!orderId) return;
    setBusy(true);
    const response = await fetch("/api/conformance");
    const data = await response.json();
    setConformance(data);
    setBusy(false);
  }, [orderId]);

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
    setConformance(null);
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
    setTimeline(data.events ?? []);
    pushAgent("Hi, I'm the RunVista assistant. Tell me what you're looking for.");
    pushAgent("I need black shoes under ₹5,000.");
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

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>AgentReady Commerce</h1>
          <div className="sub">RunVista Sports — merchant-specific agentic storefront</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`badge ${razorpayBadgeTone(indicators.razorpay)}`}>
            Razorpay {razorpayBadgeLabel(indicators.razorpay)}
          </span>
          <span className={`badge ${indicators.x402 === "live" ? "live" : "mock"}`}>
            x402 {indicators.x402 === "live" ? "live" : "MOCK"}
          </span>
          <span className={`badge ${indicators.llm === "disabled" ? "mock" : "live"}`}>
            LLM {indicators.llm === "disabled" ? "disabled" : indicators.llm}
          </span>
          <span className={`state ${stateTone(orderState)}`}>{orderState}</span>
          <button className="btn" onClick={runScenario} disabled={busy}>
            Run prepared scenario
          </button>
          <button className="btn" onClick={startSession} disabled={busy}>
            New conversation
          </button>
          <button className="btn" onClick={resetDemo} disabled={busy}>
            Reset server state
          </button>
        </div>
      </header>

      <section>
        <div className="panel">
          <h2>Conversation</h2>
          <div className="chat" ref={chatRef}>
            {messages.map((message, index) => (
              <div key={index} className={`msg ${message.role}`}>
                {message.text}
              </div>
            ))}
            {questions.length > 0 && (
              <div className="msg agent">
                {questions.length === 1 ? (
                  <span>Required: {questions[0]}</span>
                ) : (
                  <span>Required details: {questions.join(" · ")}</span>
                )}
                {quickReplies.length > 0 && (
                  <div className="quick">
                    {quickReplies.map((reply) => (
                      <button key={reply} onClick={() => send(reply)} disabled={busy}>
                        {reply}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="input-row">
            <input
              type="text"
              value={input}
              placeholder={messages.length === 0 ? SUGGESTED : "Reply to the assistant…"}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void send(input || SUGGESTED);
              }}
            />
            <button className="btn primary" onClick={() => send(input || SUGGESTED)} disabled={busy}>
              Send
            </button>
          </div>
          {messages.length === 0 && (
            <div className="quick">
              <button onClick={() => send(SUGGESTED)} disabled={busy}>
                {SUGGESTED}
              </button>
            </div>
          )}
        </div>

        {notice && (
          <div className="panel" style={{ borderColor: "var(--warn)" }}>
            <h3 style={{ color: "var(--warn)" }}>Failure theatre</h3>
            <div>{notice}</div>
          </div>
        )}

        {matches && (
          <div className="panel">
            <h2>Ranked shortlist</h2>
            {machineSpend && (
              <div className="hint" style={{ color: "var(--warn)", marginBottom: 8 }}>
                Machine tool spend: {machineSpend.amount} USDC via x402 v2 · {machineSpend.network} ·{" "}
                <span className="mono">{machineSpend.txHash.slice(0, 16)}…</span> · {machineSpend.mock ? "MOCK demo settlement" : "live"} — this is agent spend for the fit-scoring API, separate from your shoe purchase.
              </div>
            )}
            <div className="cards">
              {matches.map((match) => {
                const fitScore = fitScores?.[match.product.productId];
                return (
                  <div key={match.product.productId} className="card" onClick={() => chooseProduct(match.product.productId)}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span className="score">score {match.score}</span>
                      <span className="tag">{match.product.brand}</span>
                    </div>
                    <h3>{match.product.name}</h3>
                    <div className="price">₹{(match.product.priceMinor / 100).toFixed(2)}</div>
                    <div className="tag">
                      {match.product.useCase} · {match.product.fit} fit · {match.product.cushioning} cushioning · up to{" "}
                      {match.product.typicalDistanceKm}K
                    </div>
                    {fitScore && (
                      <div className="score">
                        fit-score {fitScore.fitScore}/100 — {fitScore.note}
                      </div>
                    )}
                    {match.reasons.map((reason) => (
                      <div key={reason} className="good">
                        + {reason}
                      </div>
                    ))}
                    {match.compromises.map((compromise) => (
                      <div key={compromise} className="comp">
                        − {compromise}
                      </div>
                    ))}
                    <div className="hint">Click to quote</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {quote && <ApprovalPanel quote={quote} onApprove={approve} busy={busy} />}

        {quote && quote.approvalEventId && (
          <div className="panel">
            <h2>Payment</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {!paymentIds?.orderId && (
                <button className="btn primary" onClick={initiate} disabled={busy}>
                  Pay with Razorpay (UPI · Card · Netbanking)
                </button>
              )}
              {paymentIds?.orderId && isMock && !paymentIds.paymentId && (
                <button className="btn primary" onClick={mockCapture} disabled={busy}>
                  Complete test payment
                </button>
              )}
              {paymentIds?.orderId && !isMock && !paymentIds.paymentId && (
                <button className="btn primary" onClick={initiate} disabled={busy}>
                  Reopen Razorpay Checkout
                </button>
              )}
            </div>
            {paymentIds?.orderId && (
              <div className="hint">
                Razorpay order: <span className="mono">{paymentIds.orderId}</span>
                {paymentIds.paymentId && (
                  <>
                    {" "}· payment: <span className="mono">{paymentIds.paymentId}</span>
                  </>
                )}
                {paymentIds.signature && <> · signature verified</>}
              </div>
            )}
            {(orderState === "PAID_VERIFIED" || orderState === "FULFILMENT_PENDING" || orderState === "FULFILLED") && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn primary" onClick={() => fulfil(false)} disabled={busy}>
                  Fulfil order
                </button>
              </div>
            )}
            {(orderState === "FULFILMENT_FAILED" || orderState === "COMPENSATION_PENDING") && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn primary" onClick={compensate} disabled={busy}>
                  Start refund
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <aside>
        <div className="panel">
          <h2>Audit timeline</h2>
          <div className="timeline">
            {timeline.length === 0 && <div className="hint">No events yet.</div>}
            {timeline.map((event) => (
              <div key={event.eventId} className="tl-event">
                <div className="tl-head">
                  <span className="tl-type">{event.type}</span>
                  <span className="tl-time">{new Date(event.occurredAt).toLocaleTimeString()}</span>
                  {event.decision && <span className={event.decision}>{event.decision}</span>}
                </div>
                <div className="tl-summary">{event.summary}</div>
                {event.externalReferences && (
                  <div className="mono">
                    {Object.entries(event.externalReferences)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Failure theatre</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button className="btn" onClick={() => tamper("price")} disabled={busy || !quote?.approvalEventId}>
              Simulate price change after approval
            </button>
            <button className="btn" onClick={() => tamper("variant")} disabled={busy || !quote?.approvalEventId}>
              Simulate variant change after approval
            </button>
            <button className="btn" onClick={() => send("I need black shoes under ₹5,000.")} disabled={busy}>
              Duplicate agent request
            </button>
            <button className="btn" onClick={replayWebhook} disabled={busy || !paymentIds?.orderId}>
              Replay payment webhook
            </button>
            <button className="btn danger" onClick={() => fulfil(true)} disabled={busy || orderState !== "PAID_VERIFIED"}>
              Simulate fulfilment failure
            </button>
          </div>
          <div className="hint">Each scenario produces visible audit events and a state transition — no code edits.</div>
        </div>

        <div className="panel">
          <h2>Conformance — critical invariants</h2>
          <button className="btn primary" onClick={runConformance} disabled={busy}>
            Run conformance suite
          </button>
          {conformance && (
            <table className="conformance" style={{ marginTop: 10, width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {conformance.checks.map((check) => (
                  <tr key={check.id}>
                    <td className={check.pass ? "pass" : "fail"}>{check.pass ? "PASS" : "FAIL"}</td>
                    <td>
                      <div>{check.name}</div>
                      <div className="hint">{check.detail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {conformance && (
            <div className="hint">
              {conformance.passCount}/{conformance.checks.length} gates passing. This verifies our declared invariants; it does
              not certify external infrastructure.
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

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
    <div className="panel" style={{ borderColor: quote.approvalEventId ? "var(--good)" : "var(--accent)" }}>
      <h2>Commerce Envelope {quote.approvalEventId ? "— APPROVED" : "— awaiting approval"}</h2>
      <h3>{envelope.items[0]?.variant?.size} {envelope.items.map((item) => item.sku).join(", ")}</h3>
      <div className="kv">
        <span className="k">Item</span>
        <span>{envelope.items[0]?.sku}</span>
        <span className="k">Variant</span>
        <span>{JSON.stringify(envelope.items[0]?.variant)}</span>
        <span className="k">Quantity</span>
        <span>{envelope.items[0]?.quantity}</span>
        <span className="k">Subtotal</span>
        <span>₹{(envelope.subtotalMinor / 100).toFixed(2)}</span>
        <span className="k">Shipping</span>
        <span>₹{(envelope.shippingMinor / 100).toFixed(2)}</span>
        <span className="k">Total</span>
        <span>₹{(envelope.totalMinor / 100).toFixed(2)}</span>
        <span className="k">Return policy</span>
        <span>Returnable within 14 days, unworn</span>
        <span className="k">Quote expiry</span>
        <span>{new Date(envelope.expiresAt).toLocaleString()}</span>
        <span className="k">Currency</span>
        <span>{envelope.currency}</span>
        <span className="k">Merchant</span>
        <span>{envelope.merchantId}</span>
        <span className="k">Logical order</span>
        <span className="mono">{envelope.logicalOrderId}</span>
      </div>
      <div className="digest-box">SHA-256: {quote.digest}</div>
      {!quote.approvalEventId && (
        <button className="btn primary" onClick={onApprove} disabled={busy}>
          Approve exact envelope hash
        </button>
      )}
      <div className="hint">Approval binds to this exact hash. Any material change invalidates it and requires reapproval.</div>
    </div>
  );
}

function stateTone(state: string): string {
  if (["APPROVED", "PAID_VERIFIED", "FULFILLED", "REFUNDED"].includes(state)) return "good";
  if (["EXPIRED", "PAYMENT_FAILED", "FULFILMENT_FAILED", "REAPPROVAL_REQUIRED", "MANUAL_REVIEW"].includes(state)) return "bad";
  if (["COMPENSATION_PENDING", "PAYMENT_PENDING", "AWAITING_APPROVAL"].includes(state)) return "warn";
  return "";
}

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

function razorpayBadgeLabel(mode: string): string {
  if (mode === "test") return "TEST MODE";
  if (mode === "live") return "live";
  return "MOCK";
}

function razorpayBadgeTone(mode: string): string {
  if (mode === "test") return "test";
  if (mode === "live") return "live";
  return "mock";
}