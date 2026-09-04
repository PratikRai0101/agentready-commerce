"use client";

import { useCallback, useEffect, useState } from "react";
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

  const refreshTimeline = useCallback(async (orderId: string) => {
    const res = await fetch(`/api/audit?orderId=${orderId}`);
    const data = await res.json();
    setTimeline(data.events ?? []);
  }, []);

  const startSession = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/session", { method: "POST" });
    const data = await res.json();
    setSession({ orderId: data.orderId, state: data.state, rails: data.rails ?? [], indicators: data.indicators ?? { razorpay: "mock", x402: "mock", llm: "disabled" } });
    setTimeline([]);
    setConformance(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  const runScenario = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/scenario");
    const data = await res.json();
    setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
    setTimeline(data.events ?? []);
    setBusy(false);
  }, []);

  const resetServer = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/reset", { method: "POST" });
    const data = await res.json();
    setSession((prev) => prev ? { ...prev, orderId: data.orderId, state: data.state } : prev);
    setTimeline([]);
    setConformance(null);
    setNotice(null);
    setBusy(false);
  }, []);

  const runConformance = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/conformance");
    const data = await res.json();
    setConformance(data);
    setBusy(false);
  }, []);

  const tamper = useCallback(
    async (field: "price" | "variant") => {
      if (!session) return;
      setBusy(true);
      const res = await fetch("/api/tamper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: session.orderId, field }),
      });
      const data = await res.json();
      if (data.ok) {
        setNotice(`Material change detected: ${data.changes.join("; ")}`);
      } else {
        setNotice(`Tamper failed: ${data.error}`);
      }
      void refreshTimeline(session.orderId);
      setBusy(false);
    },
    [session, refreshTimeline],
  );

  const replayWebhook = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const first = await fetch("/api/webhook/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: session.orderId, replay: false }),
    });
    const firstData = await first.json();
    const second = await fetch("/api/webhook/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: session.orderId, replay: true }),
    });
    const secondData = await second.json();
    setNotice(
      `Webhook replay: first ${firstData.processed ? "processed" : "failed"} (${firstData.deduplicated ? "dedup" : "fresh"}), second ${secondData.deduplicated ? "deduplicated" : "processed"}.`,
    );
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const duplicateRequest = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const res = await fetch("/api/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: session.orderId, message: "I need black shoes under ₹5,000." }),
    });
    const data = await res.json();
    setNotice(`Duplicate request: state ${data.state}, kind ${data.kind}`);
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const fulfilFail = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const res = await fetch("/api/fulfil", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: session.orderId, fail: true }),
    });
    const data = await res.json();
    setNotice(`Fulfilment: ${data.ok ? "ok" : data.error}`);
    void refreshTimeline(session.orderId);
    setBusy(false);
  }, [session, refreshTimeline]);

  const startRefund = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const res = await fetch("/api/compensate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: session.orderId }),
    });
    const data = await res.json();
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
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>TEST MODE</span>
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
              <span className="prov-detail">rzp_test_ keys &middot; capture verified</span>
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
