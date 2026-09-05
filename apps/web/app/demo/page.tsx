"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent } from "@agentready/audit";
import type { ConformanceReport } from "@agentready/conformance";
import { RunVistaBrand } from "../components/RunVistaBrand";

type SessionInfo = {
  orderId: string;
  state: string;
  rails: { rail: string; isMock: boolean }[];
  indicators: { razorpay: string; x402: string; llm: string };
};

export default function DemoLabPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [conformance, setConformance] = useState<ConformanceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Sealed session token: harvested from every response, presented back on
  // every request, so consecutive requests keep working across serverless
  // instances. Stored in a ref; the state mirror only re-renders on change.
  const tokenRef = useRef<string | null>(null);
  const [, setSessionToken] = useState<string | null>(null);
  const apiPost = useCallback(async (path: string, body: Record<string, unknown>) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tokenRef.current) headers["x-session-token"] = tokenRef.current;
    const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (typeof data?.sessionToken === "string" && data.sessionToken) {
      tokenRef.current = data.sessionToken;
      setSessionToken(data.sessionToken);
    }
    return data;
  }, []);
  const harvestToken = useCallback((data: { sessionToken?: unknown }) => {
    if (typeof data?.sessionToken === "string" && data.sessionToken) {
      tokenRef.current = data.sessionToken;
      setSessionToken(data.sessionToken);
    }
  }, []);
  const tokenHeaders = useCallback((): Record<string, string> => {
    return tokenRef.current ? { "x-session-token": tokenRef.current } : {};
  }, []);

  const refreshTimeline = useCallback(async (orderId: string) => {
    const res = await fetch(`/api/audit?orderId=${orderId}`, { headers: tokenRef.current ? { "x-session-token": tokenRef.current } : {} });
    const data = await res.json();
    harvestToken(data);
    setTimeline(data.events ?? []);
  }, [harvestToken]);

  const startSession = useCallback(async () => {
    setBusy(true);
    const data = await apiPost("/api/session", {});
    setSession({ orderId: data.orderId, state: data.state, rails: data.rails ?? [], indicators: data.indicators ?? { razorpay: "mock", x402: "mock", llm: "disabled" } });
    setTimeline([]);
    setConformance(null);
    setBusy(false);
  }, [apiPost]);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  const runScenario = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/scenario", { headers: tokenHeaders() });
    const data = await res.json();
    harvestToken(data);
    setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
    setTimeline(data.events ?? []);
    setBusy(false);
  }, [harvestToken, tokenHeaders]);

  const resetServer = useCallback(async () => {
    setBusy(true);
    const data = await apiPost("/api/reset", {});
    setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
    setTimeline([]);
    setConformance(null);
    setNotice(null);
    setBusy(false);
  }, [apiPost]);

  const runConformance = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/conformance");
    const data = await res.json();
    setConformance(data);
    setBusy(false);
  }, []);

  const tamper = useCallback(
    async (field: "price" | "variant") => {
      setBusy(true);
      // Self-contained: the endpoint drives approve → tamper → stale
      // approval/payment attempts inside one request, so the result never
      // depends on in-memory state shared across serverless instances.
      const data = await apiPost("/api/demo/price-drift", { field });
      if (data.ok) {
        setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
        setTimeline(data.events ?? []);
        setNotice(
          `Price drift: approval ${String(data.approvedDigest).slice(0, 12)}… invalidated → ${data.state}; ${data.changes.join("; ")}; stale approval blocked; stale payment blocked.`,
        );
      } else {
        setNotice(`Price drift failed: ${data.error}`);
      }
      setBusy(false);
    },
    [],
  );

  const replayWebhook = useCallback(async () => {
    setBusy(true);
    // Self-contained: the endpoint drives one session to PAYMENT_PENDING and
    // delivers the same webhook twice under one event ID inside one request.
    const data = await apiPost("/api/demo/webhook-replay", {});
    if (data.ok) {
      setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
      setTimeline(data.events ?? []);
      const first = data.first.processed && !data.first.deduplicated ? "processed (fresh)" : "unexpected";
      const second = data.second.deduplicated ? "deduplicated" : "unexpected";
      setNotice(`Webhook replay: first ${first}, second ${second}.`);
    } else {
      setNotice(`Webhook replay failed: ${data.error}`);
    }
    setBusy(false);
  }, []);

  const duplicateRequest = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const data = await apiPost("/api/respond", { orderId: session.orderId, message: "I need black shoes under ₹5,000." });
    setNotice(`Duplicate request: state ${data.state}, kind ${data.kind}`);
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const fulfilFail = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const data = await apiPost("/api/fulfil", { orderId: session.orderId, fail: true });
    setNotice(`Fulfilment: ${data.ok ? "ok" : data.error}`);
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const startRefund = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const data = await apiPost("/api/compensate", { orderId: session.orderId });
    setNotice(data.ok ? `Refund initiated: ${data.refundId ?? "n/a"}` : `Compensation failed: ${data.error}`);
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const indicators = session?.indicators ?? { razorpay: "mock", x402: "mock", llm: "disabled" };

  return (
    <div className="app-shell">
      <header className="topbar" role="banner">
        <nav className="topbar-nav" aria-label="Demo navigation">
          <a href="/">Shop</a>
          <a href="/#trust">Order &amp; trust</a>
          <span className="active">Demo Lab</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{indicators.razorpay === "test" ? "TEST MODE" : "MOCK"}</span>
        </nav>
        <RunVistaBrand />
      </header>

      <div style={{ padding: "16px 36px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h1 style={{ fontFamily: "var(--font-head)", fontSize: 24, fontWeight: 600 }}>Demo Lab</h1>
          <span style={{ fontSize: 13, color: "var(--text-soft)" }}>
            Engineering controls &middot; not part of the customer journey &middot; direct link at <code>/demo</code>
          </span>
        </div>
      </div>

      {notice && (
        <div style={{ margin: "0 36px 16px", padding: 14, background: "var(--accent-soft)", borderRadius: "var(--radius)", fontSize: 13, color: "var(--accent-deep)" }}>
          {notice}
          <button className="demo-btn" type="button" style={{ marginLeft: 10 }} onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="demo-grid">
        {/* Column A */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Prepared scenarios */}
          <div className="demo-panel">
            <h3>Prepared scenarios</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="demo-btn" type="button" onClick={runScenario} disabled={busy}>Run prepared scenario</button>
              <button className="demo-btn" type="button" onClick={startSession} disabled={busy}>New conversation</button>
              <button className="demo-btn" type="button" onClick={resetServer} disabled={busy}>Reset server state</button>
            </div>
          </div>

          {/* Failure theatre */}
          <div className="demo-panel">
            <h3>Failure theatre</h3>
            <p>Simulate tampering, replays and failures. Each produces visible audit events and state transitions.</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="demo-btn" type="button" onClick={() => tamper("price")} disabled={busy}>Price change after approval</button>
              <button className="demo-btn" type="button" onClick={() => tamper("variant")} disabled={busy}>Variant change</button>
              <button className="demo-btn" type="button" onClick={duplicateRequest} disabled={busy}>Duplicate request</button>
              <button className="demo-btn" type="button" onClick={replayWebhook} disabled={busy}>Replay webhook</button>
              <button className="demo-btn" type="button" onClick={fulfilFail} disabled={busy}>Fulfilment failure</button>
              <button className="demo-btn" type="button" onClick={startRefund} disabled={busy}>Start refund</button>
            </div>
          </div>

          {/* Conformance */}
          <div className="demo-panel">
            <h3>Conformance &mdash; critical invariants</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <button className="demo-btn primary" type="button" onClick={runConformance} disabled={busy}>Run conformance suite</button>
              {conformance && (
                <span style={{ fontSize: 13, color: "var(--good)" }}>
                  {conformance.passCount}/{conformance.checks.length} gates passing
                </span>
              )}
            </div>
            {conformance && (
              <div className="conformance-list">
                {conformance.checks.map((check) => (
                  <div key={check.id} className="gate-row">
                    <span className="gate-id">{check.id}</span>
                    <span className="gate-name">{check.name}</span>
                    <span className={check.pass ? "gate-pass" : "gate-fail"}>{check.pass ? "PASS" : "FAIL"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Column B */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Raw protocol evidence */}
          <div className="demo-panel">
            <h3>Raw protocol evidence</h3>
            <p>Audit timeline, envelope digests and verification IDs for engineering review.</p>
            {timeline.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No events yet. Run a scenario or start a conversation.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {timeline.map((event) => (
                  <div key={event.eventId} className="evidence-row">
                    <div className="ev-type">
                      {event.type} &middot; {event.decision ?? "allow"}
                    </div>
                    <div className="ev-detail">{event.summary}</div>
                    {event.externalReferences && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                        {Object.entries(event.externalReferences).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Providers & modes */}
          <div className="demo-panel">
            <h3>Providers &amp; modes</h3>
            <div className="provider-row">
              <span className="prov-name">Razorpay</span>
              <span className="prov-detail">{indicators.razorpay === "test" ? "rzp_test_ keys · capture verified" : indicators.razorpay === "live" ? "live keys · capture verified" : "Mock adapter · no keys · no funds moved"}</span>
              <span className={`prov-mode ${indicators.razorpay}`}>{indicators.razorpay === "test" ? "TEST MODE" : indicators.razorpay === "live" ? "live" : "MOCK"}</span>
            </div>
            <div className="provider-row">
              <span className="prov-name">x402 / Solana</span>
              <span className="prov-detail">{indicators.x402 === "devnet" ? "Devnet USDC settlement via x402 facilitator" : "Mock settlement — no funds moved"}</span>
              <span className={`prov-mode ${indicators.x402 === "devnet" ? "devnet" : "mock"}`}>{indicators.x402 === "devnet" ? "DEVNET" : "MOCK"}</span>
            </div>
            <div className="provider-row">
              <span className="prov-name">LLM</span>
              <span className="prov-detail">deterministic fallback active</span>
              <span className="prov-mode disabled">disabled</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
