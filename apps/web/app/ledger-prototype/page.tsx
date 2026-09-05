"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

/* ──────────────────────────────────────────────────────────
   UI-only Decision Ledger prototype — v2
   - No payment submissions (all Pay/Approve are mock, disabled capture)
   - Devnet execution disabled (MOCK labels)
   - Payment fixes & restart-safe recovery tracked separately
   - Isolated preview only — do not wire into main shop until visual approval
   ────────────────────────────────────────────────────────── */

type IntentField = {
  key: string;
  label: string;
  value: string;
  kind: "requirement" | "preference" | "unresolved";
  editable: boolean;
};

const MOCK_INTENT: IntentField[] = [
  { key: "size", label: "UK 9", value: "UK 9", kind: "requirement", editable: true },
  { key: "budget", label: "Max ₹5,000", value: "Max ₹5,000", kind: "requirement", editable: true },
  { key: "returnable", label: "Returnable", value: "true", kind: "requirement", editable: true },
  { key: "colour", label: "Black", value: "black", kind: "requirement", editable: true },
  { key: "useCase", label: "Road", value: "road", kind: "preference", editable: true },
  { key: "fit", label: "Wide fit", value: "wide", kind: "preference", editable: true },
  { key: "cushioning", label: "Max cushioning", value: "max", kind: "preference", editable: true },
  { key: "distance", label: "~10K", value: "10K", kind: "preference", editable: true },
];

function formatINR(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

const MOCK_PRODUCTS = [
  {
    productId: "p_vista_max",
    name: "RunVista Max Cushion",
    brand: "RunVista",
    image: "/images/products/max-cushion.png",
    priceMinor: 489900,
    badge: "Recommended for you",
    score: "92% fit",
    matched: "Wide fit + max cushioning for recovery & long easy runs",
    compromise: null as string | null,
    meta: "In stock · Ships in 3 days · Wide · Max cushioning",
    roleJustification: "Best aligns with wide fit + max cushioning under ₹5,000",
    description: "Maximum cushioning, wide fit, for recovery and long easy runs. Grey/black mesh with responsive foam.",
  },
  {
    productId: "p_streak_4",
    name: "RunVista Streak 4",
    brand: "RunVista",
    image: "/images/products/streak-4.png",
    priceMinor: 429900,
    badge: "Cheaper alternative",
    score: "81% fit",
    matched: "Road + balanced cushioning for 5–15K",
    compromise: "Standard fit — not wide",
    meta: "In stock · 3 days",
    roleJustification: "Lower price, standard fit trade-off",
  },
  {
    productId: "p_stride_lite",
    name: "RunVista Stride Lite",
    brand: "RunVista",
    image: "/images/products/stride-lite.png",
    priceMinor: 349900,
    badge: "Trade-off choice",
    score: "64% fit",
    matched: "Lightweight under budget",
    compromise: "Narrow + minimal cushioning",
    meta: "In stock · 5 days",
    roleJustification: "Budget option with clear compromises",
  },
];

const AUDIT_BASE = [
  { summary: "Session started", actor: "system" },
  { summary: "Clarified: size UK 9, road up to 10K, wide fit", actor: "agent" },
  { summary: "Recommendations ranked — 3 products", actor: "agent" },
  { summary: "Fit-scoring checked via x402 (mock)", actor: "payment" },
  { summary: "Quote prepared — RunVista Max Cushion UK 9", actor: "system" },
] as const;
const AUDIT_APPROVAL = { summary: "Approval recorded — exact terms bound", actor: "customer" } as const;

export default function LedgerPrototypePage() {
  const [view, setView] = useState<"split" | "desktop" | "mobile">("split");
  const [fullCapture, setFullCapture] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (v === "desktop" || v === "mobile" || v === "split") setView(v);
    if (params.get("full") === "1") setFullCapture(true);
  }, []);
  const [techExpanded, setTechExpanded] = useState(false);
  const [techExpandedMobile, setTechExpandedMobile] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>("p_vista_max");
  const [approved, setApproved] = useState(false);
  const [editingChip, setEditingChip] = useState<string | null>(null);
  const [intent, setIntent] = useState<IntentField[]>(MOCK_INTENT);
  const [showLoading, setShowLoading] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatExpandedMobile, setChatExpandedMobile] = useState(false);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [auditExpandedMobile, setAuditExpandedMobile] = useState(false);
  const [pendingUpdatedReview, setPendingUpdatedReview] = useState(false);
  const intentVersion = 4;

  const selectedProduct = MOCK_PRODUCTS.find((p) => p.productId === selectedId) ?? null;
  const quoteDigest = "a1f3c9e2b4d6f890c1234567890abcdef1234567890abcdef1234567890abcd";
  const orderId = "ord_proto_01";
  const mandateId = "mdt_demo_01";
  const issuedAt = "2026-09-02T10:42:34Z";
  const expiresAt = "2026-09-02T11:12:34Z";
  const shippingMinor = 4900;
  const totalMinor = selectedProduct ? selectedProduct.priceMinor + shippingMinor : 0;

  // Single source of truth for approval state — avoids contradictory badges
  const orderState: "QUOTED" | "AWAITING_APPROVAL" | "APPROVED" = !selectedProduct
    ? "QUOTED"
    : approved
      ? "APPROVED"
      : "AWAITING_APPROVAL";

  const handleChipRemove = (key: string) => {
    setIntent((prev) => prev.filter((f) => f.key !== key));
    setApproved(false);
    setPendingUpdatedReview(true);
    setShowLoading(true);
    setTimeout(() => setShowLoading(false), 900);
  };
  const handleChipEditSave = (key: string, newLabel: string) => {
    setIntent((prev) => prev.map((f) => (f.key === key ? { ...f, label: newLabel, value: newLabel } : f)));
    setEditingChip(null);
    setApproved(false);
    setPendingUpdatedReview(true);
    setShowLoading(true);
    setTimeout(() => setShowLoading(false), 900);
  };

  return (
    <div className="proto-root">
      <style>{protoStyles}</style>

      <header className="proto-topbar">
        <div className="proto-topbar-left">
          <div className="proto-brand">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
              <rect x="2" y="18" width="4" height="8" rx="1" fill="var(--accent)" />
              <rect x="8" y="12" width="4" height="14" rx="1" fill="var(--accent)" />
              <rect x="14" y="6" width="4" height="20" rx="1" fill="var(--accent)" />
              <rect x="20" y="2" width="4" height="24" rx="1" fill="var(--accent)" opacity="0.35" />
            </svg>
            <div>
              <div className="proto-brand-name">RunVista</div>
              <div className="proto-brand-sub">Decision Ledger</div>
            </div>
          </div>
          <span className="proto-badge proto-badge-warn">MOCK · payments disabled</span>
        </div>
        <div className="proto-topbar-right">
          <a href="/" className="proto-link">Shop</a>
        </div>
      </header>

      <div className="proto-banner" role="status">
        <span className="proto-banner-pill">MOCK</span>
        <span className="proto-banner-text">UI-only preview · not wired to checkout</span>
        <span className="proto-banner-meta">{orderState} · {formatINR(489900)}</span>
      </div>

      <div className="proto-controls">
        <div className="proto-segment" role="group" aria-label="Preview size">
          <button className={view === "split" ? "active" : ""} onClick={() => setView("split")} type="button">Split</button>
          <button className={view === "desktop" ? "active" : ""} onClick={() => setView("desktop")} type="button">Desktop</button>
          <button className={view === "mobile" ? "active" : ""} onClick={() => setView("mobile")} type="button">Mobile</button>
        </div>
        <div className="proto-controls-hint">Previews use same mock intent · Max ₹5,000 · UK 9 · wide/max/road/10K</div>
      </div>

      <div className={`proto-frames ${view}`}>
        {(view === "desktop" || view === "split") && (
          <section className="proto-frame proto-frame-desktop" aria-label="Desktop preview">
            <div className="proto-frame-head">
              <span className="proto-frame-title">Desktop — 1180px</span>
              <span className="proto-frame-sub">Narrow 320px chat · hero + two compact alternatives</span>
              <span className="proto-frame-pill">Prototype v2</span>
            </div>
            <div className={`proto-frame-body ${fullCapture ? "full-capture" : ""}`}>
              <LedgerContent
                variant="desktop"
                intent={intent}
                editingChip={editingChip}
                onStartEdit={setEditingChip}
                onSaveEdit={handleChipEditSave}
                onCancelEdit={() => setEditingChip(null)}
                onRemove={handleChipRemove}
                showLoading={showLoading}
                pendingUpdatedReview={pendingUpdatedReview}
                onPendingReviewSeen={() => setPendingUpdatedReview(false)}
                intentVersion={intentVersion}
                selectedId={selectedId}
                onSelect={setSelectedId}
                approved={approved}
                onApprove={() => { setApproved(true); setPendingUpdatedReview(false); }}
                onUnapprove={() => setApproved(false)}
                selectedProduct={selectedProduct}
                orderId={orderId}
                mandateId={mandateId}
                quoteDigest={quoteDigest}
                issuedAt={issuedAt}
                expiresAt={expiresAt}
                shippingMinor={shippingMinor}
                totalMinor={totalMinor}
                orderState={orderState}
                techExpanded={techExpanded}
                onToggleTech={() => setTechExpanded((v) => !v)}
                chatExpanded={chatExpanded}
                onToggleChat={() => setChatExpanded((v) => !v)}
                auditExpanded={auditExpanded}
                onToggleAudit={() => setAuditExpanded((v) => !v)}
              />
            </div>
          </section>
        )}
        {(view === "mobile" || view === "split") && (
          <section className="proto-frame proto-frame-mobile" aria-label="Mobile preview">
            <div className="proto-frame-head">
              <span className="proto-frame-title">Mobile — 390px</span>
              <span className="proto-frame-sub">Recommendations first · sticky Review</span>
              <span className="proto-frame-pill">Prototype v2</span>
            </div>
            <div className={`proto-frame-body ${fullCapture ? "full-capture" : ""}`}>
              <LedgerContent
                variant="mobile"
                intent={intent}
                editingChip={editingChip}
                onStartEdit={setEditingChip}
                onSaveEdit={handleChipEditSave}
                onCancelEdit={() => setEditingChip(null)}
                onRemove={handleChipRemove}
                showLoading={showLoading}
                pendingUpdatedReview={pendingUpdatedReview}
                onPendingReviewSeen={() => setPendingUpdatedReview(false)}
                intentVersion={intentVersion}
                selectedId={selectedId}
                onSelect={setSelectedId}
                approved={approved}
                onApprove={() => { setApproved(true); setPendingUpdatedReview(false); }}
                onUnapprove={() => setApproved(false)}
                selectedProduct={selectedProduct}
                orderId={orderId}
                mandateId={mandateId}
                quoteDigest={quoteDigest}
                issuedAt={issuedAt}
                expiresAt={expiresAt}
                shippingMinor={shippingMinor}
                totalMinor={totalMinor}
                orderState={orderState}
                techExpanded={techExpandedMobile}
                onToggleTech={() => setTechExpandedMobile((v) => !v)}
                chatExpanded={chatExpandedMobile}
                onToggleChat={() => setChatExpandedMobile((v) => !v)}
                auditExpanded={auditExpandedMobile}
                onToggleAudit={() => setAuditExpandedMobile((v) => !v)}
              />
            </div>
          </section>
        )}
      </div>

      <footer className="proto-footer">
        <div>Not integrated with main app — wire after visual approval. No <code>/api/pay</code> calls from this route.</div>
        <div className="proto-footer-muted">File: <code>apps/web/app/ledger-prototype/page.tsx</code> · isolated</div>
      </footer>
    </div>
  );
}

function LedgerContent({
  variant,
  intent,
  editingChip,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onRemove,
  showLoading,
  pendingUpdatedReview,
  onPendingReviewSeen,
  intentVersion,
  selectedId,
  onSelect,
  approved,
  onApprove,
  onUnapprove,
  selectedProduct,
  orderId,
  mandateId,
  quoteDigest,
  issuedAt,
  expiresAt,
  shippingMinor,
  totalMinor,
  orderState,
  techExpanded,
  onToggleTech,
  chatExpanded,
  onToggleChat,
  auditExpanded,
  onToggleAudit,
}: {
  variant: "desktop" | "mobile";
  intent: IntentField[];
  editingChip: string | null;
  onStartEdit: (k: string) => void;
  onSaveEdit: (k: string, v: string) => void;
  onCancelEdit: () => void;
  onRemove: (k: string) => void;
  showLoading: boolean;
  pendingUpdatedReview: boolean;
  onPendingReviewSeen: () => void;
  intentVersion: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  approved: boolean;
  onApprove: () => void;
  onUnapprove: () => void;
  selectedProduct: (typeof MOCK_PRODUCTS)[number] | null;
  orderId: string;
  mandateId: string;
  quoteDigest: string;
  issuedAt: string;
  expiresAt: string;
  shippingMinor: number;
  totalMinor: number;
  orderState: "QUOTED" | "AWAITING_APPROVAL" | "APPROVED";
  techExpanded: boolean;
  onToggleTech: () => void;
  chatExpanded: boolean;
  onToggleChat: () => void;
  auditExpanded: boolean;
  onToggleAudit: () => void;
}) {
  const requirements = intent.filter((f) => f.kind === "requirement");
  const preferences = intent.filter((f) => f.kind === "preference");
  const unresolved = intent.filter((f) => f.kind === "unresolved");
  const hero = MOCK_PRODUCTS[0]!;
  const alts = MOCK_PRODUCTS.slice(1);
  const isHeroSelected = selectedId === hero.productId;
  const reviewRef = useRef<HTMLDivElement>(null);
  const [reviewInView, setReviewInView] = useState(false);

  useEffect(() => {
    if (variant !== "mobile") return;
    const card = reviewRef.current;
    if (!card) return;
    const frame = card.closest(".proto-frame-body") as HTMLElement | null;
    if (!frame) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.isIntersecting) setReviewInView(true);
        else setReviewInView(false);
      },
      { root: frame, threshold: 0.35 }
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [variant, selectedProduct, approved]);

  useEffect(() => {
    if (pendingUpdatedReview && !showLoading && reviewInView) {
      onPendingReviewSeen();
    }
  }, [pendingUpdatedReview, showLoading, reviewInView, onPendingReviewSeen]);

  useEffect(() => {
    if (variant === "desktop" && pendingUpdatedReview && !showLoading) {
      onPendingReviewSeen();
    }
  }, [variant, pendingUpdatedReview, showLoading, onPendingReviewSeen]);

  const scrollToReview = () => {
    const card = reviewRef.current;
    const frame = card?.closest(".proto-frame-body") as HTMLElement | null;
    if (card && frame) {
      const top = card.offsetTop - 12;
      frame.scrollTo({ top, behavior: "smooth" });
    } else if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const ChatPanel = (
    <section className="ledger-chat" aria-label="Conversation">
      <div className="ledger-chat-head">
        <h2>Assistant</h2>
        <span className="ledger-chat-status">Deterministic · mock</span>
      </div>
      {variant === "mobile" && !chatExpanded ? (
        <button type="button" className="ledger-chat-collapsed" onClick={onToggleChat} aria-expanded="false">
          <span className="ledger-chat-collapsed-summary">UK 9 · Road · Wide · Max cushioning → 3 ranked</span>
          <span className="ledger-chat-collapsed-cta">Show conversation ▼</span>
        </button>
      ) : (
        <>
          <div className="ledger-chat-log" role="log" aria-live="polite">
            <div className="ledger-msg user">I need black shoes under ₹5,000.</div>
            <div className="ledger-msg agent">Got it — black running shoes under ₹5,000. To be accurate I need size, use and fit. Is that UK 9, road up to 10K, wide with max cushioning?</div>
            <div className="ledger-msg user">UK 9 · road up to 10K · wide fit · cushioned · must be returnable</div>
            <div className="ledger-msg agent">Thanks — 3 evidence-backed options below. Model suggests, you decide.</div>
          </div>
          <div className="ledger-quick" role="group" aria-label="Quick replies">
            <button type="button" className="ledger-quick-btn">UK 9</button>
            <button type="button" className="ledger-quick-btn">Wide fit</button>
            <button type="button" className="ledger-quick-btn">Road · 10K</button>
          </div>
        </>
      )}
      <div className="ledger-composer">
        <input className="ledger-composer-input" placeholder="Refine: e.g. 'stricter budget'…" aria-label="Message" defaultValue="" />
        <button className="ledger-composer-send" type="button">Send</button>
      </div>
      <div className="ledger-chat-foot">Mock composer — no request sent</div>
      {variant === "mobile" && chatExpanded && (
        <button type="button" className="ledger-chat-collapse-btn" onClick={onToggleChat}>Hide conversation ▲</button>
      )}
    </section>
  );

  const Recommendations = (
    <>
      <div className="ledger-section ledger-hero-wrap">
        <div className="ledger-section-head">
          <h3>Recommendation</h3>
          <span className="ledger-section-sub">Model advisory only · 1 dominant + 2 alternatives</span>
        </div>
        {/* Hero */}
        <article className={`ledger-hero ${isHeroSelected ? "selected" : ""}`}>
          <div className="ledger-hero-badge">{hero.badge}</div>
          <div className="ledger-hero-media">
            <Image src={hero.image} alt={hero.name} width={640} height={400} className="ledger-hero-img" unoptimized />
            <div className="ledger-hero-gradient" aria-hidden="true" />
          </div>
          <div className="ledger-hero-body">
            <div className="ledger-hero-title-row">
              <h4 className="ledger-hero-name">{hero.name}</h4>
              <span className="ledger-hero-price">{formatINR(hero.priceMinor)}</span>
            </div>
            <div className="ledger-hero-score">{hero.score} · <span>{hero.meta}</span></div>
            <p className="ledger-hero-desc">{hero.description}</p>
            <div className="ledger-hero-reason">• {hero.matched}</div>
            {hero.compromise && <div className="ledger-hero-compromise">— {hero.compromise}</div>}
            <div className="ledger-hero-actions">
              <button type="button" className="ledger-btn-ghost" disabled title="Prototype — no explain call">Why this one?</button>
              <button
                type="button"
                className={`ledger-btn-primary ${isHeroSelected ? "is-selected" : ""}`}
                onClick={() => onSelect(hero.productId)}
                aria-pressed={isHeroSelected}
              >
                {isHeroSelected ? "Selected" : "Select"} · {formatINR(hero.priceMinor)}
              </button>
            </div>
          </div>
        </article>

        {/* Two compact alternatives */}
        <div className="ledger-alts">
          {alts.map((p) => {
            const sel = selectedId === p.productId;
            return (
              <article key={p.productId} className={`ledger-alt ${sel ? "selected" : ""}`}>
                <Image src={p.image} alt={p.name} width={240} height={150} className="ledger-alt-img" unoptimized />
                <div className="ledger-alt-body">
                  <span className="ledger-alt-badge">{p.badge}</span>
                  <div className="ledger-alt-head">
                    <span className="ledger-alt-name">{p.name}</span>
                    <span className="ledger-alt-price">{formatINR(p.priceMinor)}</span>
                  </div>
                  <div className="ledger-alt-score">{p.score} · {p.meta}</div>
                  <div className="ledger-alt-reason">• {p.matched}</div>
                  {p.compromise && <div className="ledger-alt-compromise">— {p.compromise}</div>}
                  <div className="ledger-alt-actions">
                    <button type="button" className="ledger-btn-ghost sm" disabled>Why?</button>
                    <button type="button" className={`ledger-btn-primary sm ${sel ? "is-selected" : ""}`} onClick={() => onSelect(p.productId)}>{sel ? "Selected" : "Select"}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        <div className="ledger-note">Grounded in catalog only · stock checked at quote time</div>
      </div>
    </>
  );

  const Constraints = (
    <div className="ledger-section ledger-section-muted">
      <div className="ledger-section-head">
        <h3>What I understood</h3>
        <span className="ledger-section-sub">Editable · v{intentVersion}</span>
      </div>
      {showLoading ? (
        <div className="ledger-loading" role="status" aria-live="polite">
          <span className="ledger-dots" aria-hidden="true"><span className="ledger-dot" /><span className="ledger-dot" /><span className="ledger-dot" /></span>
          <span className="ledger-loading-text">Re-ranking…</span>
        </div>
      ) : null}
      {requirements.length > 0 && (
        <>
          <div className="ledger-label">Requirements</div>
          <div className="ledger-chips">
            {requirements.map((f) =>
              editingChip === f.key ? (
                <span key={f.key} className="ledger-chip editing">
                  <input autoFocus defaultValue={f.label} onKeyDown={(e) => { if (e.key === "Enter") onSaveEdit(f.key, (e.target as HTMLInputElement).value); if (e.key === "Escape") onCancelEdit(); }} onBlur={(e) => onSaveEdit(f.key, e.currentTarget.value)} aria-label={`Edit ${f.label}`} className="ledger-chip-input" style={{ width: Math.max(56, f.label.length * 7 + 24) }} />
                </span>
              ) : (
                <span key={f.key} className="ledger-chip requirement">
                  <button type="button" className="ledger-chip-label" onClick={() => onStartEdit(f.key)} aria-label={`Edit ${f.label}`}>{f.label}</button>
                  <button type="button" className="ledger-chip-x" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.label}`}>×</button>
                </span>
              )
            )}
          </div>
        </>
      )}
      {preferences.length > 0 && (
        <>
          <div className="ledger-label" style={{ marginTop: 10 }}>Preferences</div>
          <div className="ledger-chips">
            {preferences.map((f) =>
              editingChip === f.key ? (
                <span key={f.key} className="ledger-chip editing">
                  <input autoFocus defaultValue={f.label} onKeyDown={(e) => { if (e.key === "Enter") onSaveEdit(f.key, (e.target as HTMLInputElement).value); if (e.key === "Escape") onCancelEdit(); }} onBlur={(e) => onSaveEdit(f.key, e.currentTarget.value)} aria-label={`Edit ${f.label}`} className="ledger-chip-input" style={{ width: Math.max(56, f.label.length * 7 + 24) }} />
                </span>
              ) : (
                <span key={f.key} className="ledger-chip preference">
                  <button type="button" className="ledger-chip-label" onClick={() => onStartEdit(f.key)} aria-label={`Edit ${f.label}`}>{f.label}</button>
                  <button type="button" className="ledger-chip-x" onClick={() => onRemove(f.key)} aria-label={`Remove ${f.label}`}>×</button>
                </span>
              )
            )}
          </div>
        </>
      )}
      {unresolved.length > 0 && (
        <>
          <div className="ledger-label ledger-label-warn">Needs your input</div>
          <div className="ledger-chips">{unresolved.map((f) => <span key={f.key} className="ledger-chip unresolved">{f.label}</span>)}</div>
        </>
      )}
      <div className="ledger-hint">Tap to edit · × to remove · changes re-rank (mock)</div>
    </div>
  );

  const ApprovalCard = (
    <div ref={reviewRef} id="order-review" className={`ledger-approval ${approved ? "approved" : ""}`}>
      <div className="ledger-approval-head">
        <h3>{approved ? "Order review — approved" : "Order review"}</h3>
        <span className={`ledger-approval-pill ${orderState === "APPROVED" ? "good" : orderState === "AWAITING_APPROVAL" ? "accent" : "muted"}`}>{orderState === "APPROVED" ? "✓ Approved" : orderState === "AWAITING_APPROVAL" ? "Awaiting approval" : "Select a shoe"}</span>
      </div>
      <div className="ledger-approval-sub">Approval locks these exact terms. Any material change requires re-approval. Hashes in technical details.</div>
      {selectedProduct ? (
        <>
          <div className="ledger-approval-grid">
            <span className="k">Item</span>
            <span className="v">{selectedProduct.name} · {selectedProduct.productId === "p_vista_max" ? "VMAX-BLK-9 · UK 9" : selectedProduct.productId === "p_streak_4" ? "STRK4-BLK-9 · UK 9" : "STRL-BLK-9 · UK 9"}</span>
            <span className="k">Qty</span>
            <span className="v">1</span>
            <span className="k">Subtotal</span>
            <span className="v">{formatINR(selectedProduct.priceMinor)}</span>
            <span className="k">Shipping</span>
            <span className="v">{formatINR(shippingMinor)}</span>
            <span className="k">Total</span>
            <span className="v total">{formatINR(totalMinor)}</span>
            <span className="k">Return</span>
            <span className="v">Returnable within 14 days, unworn</span>
          </div>
          {!approved ? (
            <button className="ledger-approve-btn" type="button" onClick={onApprove} disabled={showLoading} aria-busy={showLoading} title={showLoading ? "Rebuilding quote — approval disabled" : "Approve exact terms"}>{showLoading ? "Review updated order" : "Approve this exact order"}</button>
          ) : (
            <div className="ledger-approved-row">
              <span className="ledger-approved-check">✓ Approved — exact terms bound</span>
              <button type="button" className="ledger-btn-ghost" onClick={onUnapprove}>Undo (prototype)</button>
            </div>
          )}
          <div className="ledger-approval-foot">No Razorpay order until approved — payment stays disabled in prototype.</div>
        </>
      ) : (
        <div className="ledger-empty">Select a recommendation to generate the exact order.</div>
      )}
    </div>
  );

  const AgentResource = (
    <div className="ledger-resource">
      <div className="ledger-resource-head">
        <h3>Agent resource</h3>
        <span className="ledger-resource-pill mock">Mock — no funds moved</span>
      </div>
      <div className="ledger-resource-sub">Separate from Razorpay payment · synthetic · Devnet disabled</div>
      <div className="ledger-resource-summary">
        <span className="ledger-resource-icon" aria-hidden="true">◈</span>
        <div>
          <div className="ledger-resource-title">RunVista Premium Fit-Scoring API via x402 v2</div>
          <div className="ledger-resource-meta">0.02 USDC · used to disambiguate wide vs standard fit · not the retail invoice</div>
        </div>
      </div>
      <details className="ledger-details">
        <summary>Show resource evidence</summary>
        <div className="ledger-details-body mono">
          <div className="ledger-kv"><span>Payment ID</span><span>x402_mock_7f3a…c9e2</span></div>
          <div className="ledger-kv"><span>Tx</span><span>mock_4k9…9f21 (explorer disabled)</span></div>
          <div className="ledger-kv"><span>Request digest</span><span>sha256:8b1a…3f</span></div>
        </div>
      </details>
    </div>
  );

  const visibleAudit = approved ? [...AUDIT_BASE, AUDIT_APPROVAL] : AUDIT_BASE;
  const Audit = (
    <div className="ledger-box">
      <div className="ledger-box-head">
        <h3>Audit history</h3>
        <span className="ledger-box-count">{visibleAudit.length} events · {orderState}</span>
        <button type="button" className="ledger-link-btn" onClick={onToggleAudit} aria-expanded={auditExpanded}>{auditExpanded ? "Hide details" : "Show details"}</button>
      </div>
      <div className="ledger-timeline">
        {visibleAudit.map((e, i) => (
          <div key={i} className="ledger-timeline-row">
            <span className="ledger-timeline-dot" aria-hidden="true" />
            <span className="ledger-timeline-event">{e.summary}</span>
            <span className="ledger-timeline-actor">{e.actor}</span>
          </div>
        ))}
      </div>
      {auditExpanded && (
        <div className="ledger-audit-expand">
          <div className="ledger-mono">IDs · hashes · timestamps and developer notes are collapsed by default. Full envelope digest, orderId, mandateId, issuedAt/expiresAt appear in Technical details below.</div>
        </div>
      )}
    </div>
  );

  const Tech = (
    <div className="ledger-tech">
      <button type="button" className="ledger-tech-toggle" onClick={onToggleTech} aria-expanded={techExpanded}>
        Technical details <span className="ledger-tech-chevron">{techExpanded ? "▲" : "▼"}</span>
      </button>
      {techExpanded && (
        <div className="ledger-tech-body">
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">IDs, hashes, timestamps</div>
            <div className="ledger-mono">orderId: {orderId} · mandateId: {mandateId}</div>
            <div className="ledger-mono">digest: {quoteDigest}</div>
            <div className="ledger-mono">signature: mock_sig_… · nonce: nonce_mock</div>
            <div className="ledger-mono">issuedAt: {issuedAt} · expiresAt: {expiresAt}</div>
          </div>
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">Commerce Envelope (canonical)</div>
            <pre className="ledger-pre">{`{
  "version": 1,
  "logicalOrderId": "${orderId}",
  "merchantId": "merchant_runvista",
  "items": [{ "sku": "VMAX-BLK-9", "quantity": 1, "unitAmountMinor": ${selectedProduct?.priceMinor ?? 489900} }],
  "totalMinor": ${totalMinor},
  "currency": "INR",
  "mandateId": "${mandateId}",
  "issuedAt": "${issuedAt}",
  "expiresAt": "${expiresAt}"
}`}</pre>
          </div>
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">Developer explanations</div>
            <ul className="ledger-tech-list">
              <li>Policy checks merchant, amount, expiry and re-approval on material change before payment.</li>
              <li>Deterministic ranking only — never invents catalog attributes.</li>
              <li>x402 resource is a separate spend; not a second retail charge.</li>
            </ul>
          </div>
          <div className="ledger-tech-section">
            <div className="ledger-tech-title">Providers &amp; modes</div>
            <div className="ledger-provider"><span>Razorpay</span><span className="muted">rzp_test · capture verified</span><span className="pill mock">MOCK</span></div>
            <div className="ledger-provider"><span>x402 / Solana</span><span className="muted">Mock settlement — no funds moved</span><span className="pill mock">MOCK</span></div>
            <div className="ledger-provider"><span>LLM</span><span className="muted">deterministic fallback</span><span className="pill disabled">disabled</span></div>
          </div>
          <div className="ledger-tech-note">All IDs truncated in UI · full values in this section only · sensitive fields never on-chain</div>
        </div>
      )}
    </div>
  );

  // State badge for progress — consistent with orderState
  const activeStep = orderState === "QUOTED" ? 1 : orderState === "AWAITING_APPROVAL" ? 3 : 4;

  return (
    <div className={`ledger variant-${variant}`}>
      <div className="ledger-topbar">
        <div className="ledger-brand">
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect x="2" y="18" width="4" height="8" rx="1" fill="var(--accent)" />
            <rect x="8" y="12" width="4" height="14" rx="1" fill="var(--accent)" />
            <rect x="14" y="6" width="4" height="20" rx="1" fill="var(--accent)" />
            <rect x="20" y="2" width="4" height="24" rx="1" fill="var(--accent)" opacity="0.35" />
          </svg>
          <span className="ledger-brand-name">RunVista</span>
          <span className="ledger-brand-sub">Sports</span>
        </div>
        <span className={`ledger-order-pill ${orderState === "APPROVED" ? "is-approved" : ""}`}>{orderState === "APPROVED" ? "● Approved" : orderState === "AWAITING_APPROVAL" ? "○ Awaiting approval" : "○ Quoted"}</span>
        <span className="ledger-mock-badge">Mock</span>
      </div>

      {variant === "desktop" ? (
        <div className="ledger-grid desktop">
          {ChatPanel}
          <section className="ledger-main" aria-label="Decision ledger">
            <div className="ledger-progress" role="navigation" aria-label="Order progress">
              {["Preferences", "Recommendation", "Review", "Approval", "Payment"].map((label, i) => (
                <span key={label} className={`ledger-step ${i + 1 === activeStep ? "active" : i + 1 < activeStep ? "done" : ""}`}>
                  <span className="ledger-step-num">{i + 1}</span> {label}
                </span>
              ))}
            </div>
            {Recommendations}
            {Constraints}
            {ApprovalCard}
            {AgentResource}
            <div className="ledger-box ledger-pay">
              <h3>Payment</h3>
              <div className="ledger-pay-status">{orderState === "APPROVED" ? "Approved — ready for Razorpay" : "Awaiting approval — payment blocked"}</div>
              <button className="ledger-btn-primary disabled" type="button" disabled title="Prototype — no payment submission">Pay with Razorpay</button>
              <div className="ledger-hint">Disabled in prototype · preserves existing checkout</div>
            </div>
            {Audit}
            {Tech}
          </section>
        </div>
      ) : (
        // Mobile: recommendations first, chat collapsed, sticky action
        <div className="ledger-stack">
          <section className="ledger-main" aria-label="Decision ledger">
            <div className="ledger-progress" role="navigation" aria-label="Order progress">
              {["Preferences", "Recommendation", "Review", "Approval", "Payment"].map((label, i) => (
                <span key={label} className={`ledger-step ${i + 1 === activeStep ? "active" : i + 1 < activeStep ? "done" : ""}`}>
                  <span className="ledger-step-num">{i + 1}</span> {label}
                </span>
              ))}
            </div>
            {Recommendations}
            {Constraints}
            {ApprovalCard}
            {AgentResource}
            {Audit}
            {ChatPanel}
            <div className="ledger-box ledger-pay">
              <h3>Payment</h3>
              <div className="ledger-pay-status">{orderState === "APPROVED" ? "Approved — ready for Razorpay" : "Awaiting approval"}</div>
              <button className="ledger-btn-primary disabled" type="button" disabled>Pay with Razorpay</button>
            </div>
            {Tech}
            <div style={{ height: 72 }} aria-hidden="true" />
          </section>
          <div className="ledger-sticky">
            <div className="ledger-sticky-inner">
              <span className="ledger-sticky-total">{selectedProduct ? formatINR(totalMinor) : "—"} · {showLoading ? "Updating order…" : pendingUpdatedReview ? "Review updated order" : orderState === "APPROVED" ? "Approved" : reviewInView ? "Ready to approve" : "Review needed"}</span>
              {showLoading ? (
                <button className="ledger-btn-primary" type="button" disabled aria-busy="true" title="Rebuilding quote — approval disabled">Review updated order</button>
              ) : pendingUpdatedReview ? (
                !reviewInView ? (
                  <button className="ledger-btn-primary" type="button" onClick={scrollToReview} title="Updated terms below — scroll to review">Review updated order</button>
                ) : (
                  <button className="ledger-btn-primary" type="button" onClick={onApprove} disabled={!selectedProduct} title="Updated terms displayed — approve now">Approve this exact order</button>
                )
              ) : approved ? (
                <button className="ledger-btn-primary is-selected" type="button" onClick={onUnapprove} title="Undo mock approval">Approved ✓</button>
              ) : !reviewInView ? (
                <button className="ledger-btn-primary" type="button" onClick={scrollToReview} title="Scroll to exact terms">Review order</button>
              ) : (
                <button className="ledger-btn-primary" type="button" onClick={onApprove} disabled={!selectedProduct} title="Mock approve exact order">Approve this exact order</button>
              )}
            </div>
            <div className="ledger-sticky-note">{showLoading ? "Rebuilding quote — approval disabled until updated terms are displayed" : pendingUpdatedReview && !reviewInView ? "Updated terms below — review before approving" : reviewInView ? "Mock · no charge · hashes in Technical details" : "Tap to review exact terms before approval"}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const protoStyles = `
  :root { --proto-bg: #f7f3ed; }
  .proto-root { min-height: 100vh; background: var(--proto-bg); color: var(--text); font-family: var(--font-body); }
  .proto-topbar { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; background:#fff; border-bottom:1px solid var(--border); position:sticky; top:0; z-index:30; }
  .proto-topbar-left { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .proto-brand { display:flex; align-items:center; gap:10px; }
  .proto-brand-name { font-family: var(--font-head); font-weight:700; font-size:15px; }
  .proto-brand-sub { font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:var(--text-muted); }
  .proto-badge { padding:4px 8px; border-radius:999px; font-size:10px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; }
  .proto-badge-muted { background: var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .proto-badge-accent { background: var(--accent-soft); color:var(--accent-deep); }
  .proto-badge-warn { background: var(--warn-soft); color: var(--warn); border:1px solid var(--warn); }
  .proto-topbar-right { display:flex; gap:14px; align-items:center; }
  .proto-link { font-size:12px; color:var(--text-soft); text-decoration:none; }
  .proto-link:hover { color:var(--accent-deep); text-decoration:underline; }
  .proto-banner { margin:8px 20px 12px; display:flex; align-items:center; gap:10px; padding:8px 12px; background:#fff; border:1px solid var(--border); border-radius:999px; font-size:11px; color:var(--text-soft); overflow:hidden; }
  .proto-banner-pill { padding:3px 8px; border-radius:999px; background: var(--warn-soft); border:1px solid var(--warn); color: var(--warn); font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; flex-shrink:0; }
  .proto-banner-text { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .proto-banner-meta { margin-left:auto; font-size:10px; color:var(--text-muted); white-space:nowrap; flex-shrink:0; }
  @media (max-width: 700px) { .proto-banner-meta { display:none; } .proto-banner-text { white-space: normal; } }
  .proto-controls { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 20px 12px; flex-wrap:wrap; }
  .proto-segment { display:inline-flex; background:#fff; border:1px solid var(--border); border-radius:999px; padding:3px; gap:2px; }
  .proto-segment button { padding:7px 14px; border-radius:999px; border:none; background:transparent; font-size:12px; font-weight:500; cursor:pointer; color:var(--text-soft); transition: all 0.2s; }
  .proto-segment button.active { background: var(--text); color:#fff; transform: translateY(-0.5px); }
  .proto-controls-hint { font-size:11px; color:var(--text-muted); }
  .proto-frames { display:grid; gap:16px; padding:0 20px 20px; }
  .proto-frames.split { grid-template-columns: 1.35fr 0.85fr; align-items:start; }
  .proto-frames.desktop { grid-template-columns: 1fr; }
  .proto-frames.mobile { grid-template-columns: 420px; justify-content:center; }
  @media (max-width: 1020px) { .proto-frames.split { grid-template-columns: 1fr; } }
  .proto-frame { background:#fff; border:1px solid var(--border); border-radius:16px; overflow:hidden; box-shadow: var(--shadow-md); }
  .proto-frame-head { display:flex; align-items:center; gap:10px; padding:10px 14px; background: linear-gradient(180deg, #ffffff 0%, #fdf8f2 100%); border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .proto-frame-title { font-size:12px; font-weight:700; letter-spacing:0.04em; }
  .proto-frame-sub { font-size:11px; color:var(--text-muted); }
  .proto-frame-pill { margin-left:auto; font-size:10px; padding:3px 7px; border-radius:999px; background:var(--text); color:#fff; letter-spacing:0.06em; text-transform:uppercase; }
  .proto-frame-body { height: 78vh; overflow:auto; overflow-x:hidden; background: var(--bg); position:relative; min-width:0; }
  .proto-frame-body.full-capture { height: auto; overflow: visible; }
  .proto-footer { padding:14px 20px; font-size:12px; color:var(--text-soft); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; border-top:1px solid var(--border); background:#fff; }
  .proto-footer-muted { color:var(--text-muted); }

  /* ── Ledger — min-width fixes for horizontal clipping ── */
  .ledger, .ledger-grid, .ledger-main, .ledger-hero-wrap, .ledger-section, .ledger-hero { min-width:0; }
  .ledger { background: var(--bg); min-height:100%; }
  .ledger-topbar { display:flex; align-items:center; gap:10px; padding:11px 14px; background:#fff; border-bottom:1px solid var(--border); position:sticky; top:0; z-index:5; }
  .ledger-brand { display:flex; align-items:center; gap:8px; }
  .ledger-brand-name { font-family:var(--font-head); font-weight:700; font-size:14px; letter-spacing:-0.02em; }
  .ledger-brand-sub { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); }
  .ledger-order-pill { margin-left:8px; font-size:11px; padding:4px 10px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-soft); font-weight:500; }
  .ledger-order-pill.is-approved { background: var(--good-soft); border-color: var(--good); color: var(--good); }
  .ledger-mock-badge { margin-left:auto; font-size:10px; padding:3px 8px; border-radius:999px; background: var(--warn-soft); color: var(--warn); border:1px solid var(--warn); font-weight:600; letter-spacing:0.06em; text-transform:uppercase; }

  /* Desktop grid: narrow 320px chat + flexible ledger — no stretch, no blank gap */
  .ledger-grid.desktop { display:grid; grid-template-columns: 320px minmax(0,1fr); min-height:0; align-items: start; gap:0; }
  .ledger-chat { background:#fff; border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; align-self: start; height: fit-content; max-height: calc(78vh - 12px); overflow: auto; position: sticky; top: 0; }
  .ledger-chat-head { display:flex; align-items:center; justify-content:space-between; padding:12px 12px 8px; border-bottom:1px solid var(--border-subtle); }
  .ledger-chat-head h2 { font-family:var(--font-head); font-size:13px; font-weight:700; letter-spacing:-0.01em; }
  .ledger-chat-status { font-size:10px; padding:2px 6px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-chat-collapsed { display:flex; flex-direction:column; gap:6px; margin:10px; padding:10px 12px; background: var(--bg); border:1px dashed var(--border); border-radius:10px; cursor:pointer; text-align:left; }
  .ledger-chat-collapsed-summary { font-size:11px; font-weight:500; color:var(--text-soft); }
  .ledger-chat-collapsed-cta { font-size:10px; font-weight:600; color:var(--accent-deep); }
  .ledger-chat-collapse-btn { margin:6px 10px 10px; padding:6px; background:none; border:none; font-size:11px; color:var(--text-muted); cursor:pointer; }
  .ledger-chat-log { padding:10px 12px; display:flex; flex-direction:column; gap:8px; max-height: 260px; overflow:auto; }
  .ledger-msg { max-width:88%; padding:8px 10px; border-radius:12px; font-size:12px; line-height:1.5; }
  .ledger-msg.user { align-self:flex-end; background: linear-gradient(180deg, var(--accent-soft) 0%, #f0d5c8 100%); border-bottom-right-radius:4px; color:var(--text); }
  .ledger-msg.agent { align-self:flex-start; background:#fff; border:1px solid var(--border); box-shadow:var(--shadow-sm); border-bottom-left-radius:4px; }
  .ledger-quick { display:flex; gap:6px; flex-wrap:wrap; padding:0 12px 10px; }
  .ledger-quick-btn { padding:6px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent-deep); border:none; font-size:11px; font-weight:500; cursor:pointer; }
  .ledger-composer { display:flex; gap:6px; padding:8px 10px; background:#fff; border-top:1px solid var(--border); margin-top:auto; }
  .ledger-composer-input { flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:8px; font-size:12px; background:var(--bg); outline:none; }
  .ledger-composer-input:focus { border-color: var(--accent); }
  .ledger-composer-send { padding:8px 12px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; }
  .ledger-chat-foot { padding:6px 10px; font-size:10px; color:var(--text-muted); text-align:center; background:#fff; border-top:1px dashed var(--border); }

  .ledger-main { padding:14px 14px 16px; display:flex; flex-direction:column; gap:14px; min-width:0; overflow:hidden; }
  .ledger-stack { display:flex; flex-direction:column; min-height:100%; position:relative; min-width:0; }
  .ledger-stack .ledger-main { padding-bottom: 0; }

  .ledger-progress { display:flex; gap:6px; flex-wrap:wrap; }
  .ledger-step { display:inline-flex; align-items:center; gap:5px; padding:5px 10px; border-radius: 999px; font-size:11px; font-weight:500; background:#fff; border:1px solid var(--border); color:var(--text-muted); transition: all 0.2s; }
  .ledger-step.active { background: var(--accent); color:#fff; border-color:var(--accent); box-shadow: 0 2px 8px rgba(200,92,59,0.25); }
  .ledger-step.done { background: var(--good-soft); border-color: var(--good); color: var(--good); }
  .ledger-step-num { font-weight:700; font-size:10px; width:16px; height:16px; display:inline-grid; place-items:center; border-radius:50%; background: rgba(0,0,0,0.06); }
  .ledger-step.active .ledger-step-num { background: rgba(255,255,255,0.2); }

  /* Hero */
  .ledger-hero-wrap { background:#fff; border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:var(--shadow-sm); overflow:hidden; }
  .ledger-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  .ledger-section-head h3 { font-family:var(--font-head); font-size:14px; font-weight:700; letter-spacing:-0.02em; }
  .ledger-section-sub { font-size:11px; color:var(--text-muted); }
  .ledger-hero { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#fff; box-shadow:var(--shadow-sm); transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s; }
  .ledger-hero:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); border-color: var(--accent); }
  .ledger-hero.selected { border-color:var(--accent); box-shadow:0 6px 20px rgba(200,92,59,0.14); }
  .ledger-hero-badge { padding:7px 12px; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; background: linear-gradient(90deg, var(--accent-soft) 0%, #f0d5c8 100%); color:var(--accent-deep); border-bottom:1px solid var(--border-subtle); }
  .ledger-hero.selected .ledger-hero-badge { background: linear-gradient(90deg, var(--accent) 0%, #d46a4a 100%); color:#fff; }
  .ledger-hero-media { position:relative; aspect-ratio: 16/9; background: #EDE4D8; overflow:hidden; }
  .ledger-hero-img { width:100%; height:100%; object-fit: cover; display:block; }
  .ledger-hero-gradient { position:absolute; inset:0; background: linear-gradient(180deg, transparent 60%, rgba(32,26,21,0.04) 100%); pointer-events:none; }
  .ledger-hero-body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:8px; min-width:0; }
  .ledger-hero-title-row { display:flex; justify-content:space-between; gap:8px; align-items:baseline; min-width:0; }
  /* Desktop hero two-column: image beside details */
  .variant-desktop .ledger-hero { display: grid; grid-template-columns: 340px minmax(0, 1fr); grid-template-rows: auto 1fr; }
  .variant-desktop .ledger-hero-badge { grid-column: 1 / -1; grid-row: 1; }
  .variant-desktop .ledger-hero-media { grid-column: 1; grid-row: 2; aspect-ratio: auto; height: 100%; min-height: 240px; }
  .variant-desktop .ledger-hero-body { grid-column: 2; grid-row: 2; }
  @media (max-width: 920px) { .variant-desktop .ledger-hero { grid-template-columns: 1fr; } .variant-desktop .ledger-hero-media { aspect-ratio: 16/9; min-height: auto; height: auto; } }
  .ledger-hero-name { font-family:var(--font-head); font-size:17px; font-weight:700; letter-spacing:-0.02em; line-height:1.2; }
  .ledger-hero-price { font-size:17px; font-weight:800; letter-spacing:-0.03em; color: var(--text); }
  .ledger-hero-score { font-size:12px; font-weight:600; color:var(--accent-deep); }
  .ledger-hero-score span { font-weight:400; color:var(--text-muted); font-size:11px; }
  .ledger-hero-desc { font-size:12px; color:var(--text-soft); line-height:1.5; }
  .ledger-hero-reason { font-size:12px; color:var(--text-soft); }
  .ledger-hero-compromise { font-size:11px; color:var(--warn); }
  .ledger-hero-actions { display:flex; gap:8px; margin-top:6px; }
  .ledger-btn-ghost { padding:9px 14px; background:#fff; border:1px solid var(--border); border-radius:8px; font-size:12px; font-weight:500; cursor:pointer; }
  .ledger-btn-ghost:hover { border-color: var(--accent); }
  .ledger-btn-ghost.sm { padding:7px 10px; font-size:11px; }
  .ledger-btn-primary { flex:1; padding:10px 14px; background: var(--accent); color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; transition: background 0.15s, transform 0.15s, box-shadow 0.15s; }
  .ledger-btn-primary:hover { background: var(--accent-deep); transform: translateY(-0.5px); box-shadow: 0 4px 12px rgba(200,92,59,0.2); }
  .ledger-btn-primary:active { transform:none; }
  .ledger-btn-primary.is-selected { background: var(--good); }
  .ledger-btn-primary.is-selected:hover { background: #356a43; }
  .ledger-btn-primary.sm { padding:7px 10px; font-size:11px; }
  .ledger-btn-primary.disabled { background: var(--text-muted); opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; }

  /* Alts — badge inline (no overlap), min-width fixes for clipping */
  .ledger-alts { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; margin-top:12px; }
  .variant-mobile .ledger-alts { grid-template-columns: 1fr; }
  .ledger-alt { display:flex; gap:10px; padding:10px; border:1px solid var(--border); border-radius:10px; background:#fff; box-shadow:var(--shadow-sm); transition: all 0.2s; min-width:0; overflow:hidden; }
  .ledger-alt:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .ledger-alt.selected { border-color: var(--accent); box-shadow: 0 4px 14px rgba(200,92,59,0.12); }
  .ledger-alt-img { width:84px; height:84px; object-fit: cover; border-radius:8px; background:#EDE4D8; flex-shrink:0; }
  .ledger-alt-body { flex:1; display:flex; flex-direction:column; gap:4px; min-width:0; overflow:hidden; }
  .ledger-alt-head { display:flex; justify-content:space-between; gap:6px; align-items:baseline; min-width:0; }
  .ledger-alt-name { font-family:var(--font-head); font-size:12px; font-weight:700; line-height:1.2; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; min-width:0; flex:1; }
  .ledger-alt-price { font-size:12px; font-weight:700; white-space:nowrap; flex-shrink:0; }
  .ledger-alt-score { font-size:11px; font-weight:600; color:var(--accent-deep); overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ledger-alt-reason { font-size:11px; color:var(--text-soft); line-height:1.3; overflow:hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ledger-alt-compromise { font-size:10px; color:var(--warn); }
  .ledger-alt-actions { display:flex; gap:6px; margin-top:auto; }
  .ledger-alt-badge { display:inline-flex; align-self: flex-start; font-size:9px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; padding:3px 6px; border-radius:999px; background: var(--bg); border:1px solid var(--border); color:var(--text-muted); margin-bottom: 2px; flex-shrink:0; }
  .ledger-alt.selected .ledger-alt-badge { background: var(--accent); color:#fff; border-color: var(--accent); }
  .ledger-note { font-size:10px; color:var(--text-muted); margin-top:8px; font-style:italic; }

  /* Editable constraints */
  .ledger-section-muted { background:#fff; border:1px solid var(--border); border-radius:12px; padding:12px; box-shadow:var(--shadow-sm); }
  .ledger-label { font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); margin:0 0 6px; }
  .ledger-chips { display:flex; flex-wrap:wrap; gap:6px; }
  .ledger-chip { display:inline-flex; align-items:center; gap:4px; padding:6px 10px; border-radius:999px; font-size:11px; font-weight:600; box-shadow:var(--shadow-sm); transition: transform 0.15s; }
  .ledger-chip:hover { transform: translateY(-0.5px); }
  .ledger-chip.requirement { background:var(--text); color:#fff; border:1px solid var(--text); }
  .ledger-chip.preference { background:var(--bg-raised); color:var(--text); border:1px solid var(--border); }
  .ledger-chip.unresolved { background:var(--warn-soft); color:var(--warn); border:1px solid var(--warn); }
  .ledger-chip.editing { background:#fff; border:1px solid var(--accent); padding:2px; }
  .ledger-chip-label { background:none; border:none; color:inherit; font:inherit; cursor:pointer; padding:0; }
  .ledger-chip-x { background:transparent; border:none; color:inherit; opacity:0.7; cursor:pointer; font-size:12px; line-height:1; padding:0 1px; }
  .ledger-chip-x:hover { opacity:1; }
  .ledger-chip-input { border:none; background:transparent; font-size:11px; font-family:var(--font-body); outline:none; color:var(--text); }
  .ledger-hint { font-size:10px; color:var(--text-muted); margin-top:8px; }
  .ledger-loading { display:flex; align-items:center; gap:8px; padding:8px 0; }
  .ledger-dots { display:inline-flex; gap:4px; }
  .ledger-dot { width:5px; height:5px; border-radius:50%; background:var(--accent); animation: ledgerPulse 1.8s infinite ease-in-out; }
  .ledger-dot:nth-child(2){animation-delay:0.2s} .ledger-dot:nth-child(3){animation-delay:0.4s}
  @keyframes ledgerPulse { 0%,80%,100%{opacity:0.28; transform:scale(0.85)} 40%{opacity:1; transform:scale(1)} }
  @media (prefers-reduced-motion: reduce){ .ledger-dot{animation:none; opacity:0.6} }
  .ledger-loading-text { font-size:11px; color:var(--text-muted); }

  /* Approval */
  .ledger-approval { background:#fff; border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:12px; padding:14px; box-shadow:var(--shadow-sm); }
  .ledger-approval.approved { border-left-color:var(--good); background: linear-gradient(180deg, #fff 0%, #f8fdf9 100%); }
  .ledger-approval-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .ledger-approval-head h3 { font-family:var(--font-head); font-size:15px; font-weight:700; letter-spacing:-0.02em; }
  .ledger-approval-pill { padding:4px 8px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; }
  .ledger-approval-pill.accent { background:var(--accent-soft); color:var(--accent-deep); }
  .ledger-approval-pill.good { background:var(--good-soft); color:var(--good); }
  .ledger-approval-pill.muted { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-approval-sub { font-size:11px; color:var(--text-soft); margin:4px 0 10px; line-height:1.5; }
  .ledger-approval-grid { display:grid; grid-template-columns: 88px 1fr; gap:4px 10px; font-size:12px; }
  .ledger-approval-grid .k { color:var(--text-soft); font-size:11px; }
  .ledger-approval-grid .v { overflow-wrap:anywhere; font-weight:500; }
  .ledger-approval-grid .v.total { font-weight:800; font-size:15px; letter-spacing:-0.03em; }
  .ledger-approve-btn { width:100%; margin-top:12px; padding:11px 14px; background: linear-gradient(180deg, var(--accent) 0%, var(--accent-deep) 100%); color:#fff; border:none; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; transition: transform 0.15s, box-shadow 0.15s; box-shadow: 0 2px 10px rgba(200,92,59,0.2); }
  .ledger-approve-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(200,92,59,0.28); }
  .ledger-approved-row { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .ledger-approved-check { font-size:12px; font-weight:700; color:var(--good); }
  .ledger-approval-foot { font-size:10px; color:var(--text-muted); margin-top:8px; }
  .ledger-empty { padding:12px; background:var(--bg); border:1px dashed var(--border); border-radius:8px; font-size:11px; color:var(--text-muted); text-align:center; }

  /* Resource */
  .ledger-resource { background: linear-gradient(180deg, #fdfbf8 0%, #fff 100%); border:1px solid var(--border); border-radius:12px; padding:14px; }
  .ledger-resource-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .ledger-resource-head h3 { font-family:var(--font-head); font-size:13px; font-weight:700; }
  .ledger-resource-pill { padding:3px 7px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }
  .ledger-resource-pill.mock { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
  .ledger-resource-sub { font-size:11px; color:var(--text-muted); margin:4px 0 10px; }
  .ledger-resource-summary { display:flex; gap:10px; align-items:center; padding:10px 12px; background:#fff; border:1px solid var(--border); border-radius:10px; }
  .ledger-resource-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:8px; background: var(--accent-soft); color: var(--accent-deep); font-size:14px; flex-shrink:0; }
  .ledger-resource-title { font-size:12px; font-weight:600; }
  .ledger-resource-meta { font-size:11px; color:var(--text-muted); }
  .ledger-details { margin-top:10px; border-top:1px solid var(--border-subtle); padding-top:8px; }
  .ledger-details summary { font-size:11px; font-weight:600; color:var(--accent-deep); cursor:pointer; list-style:none; text-align:center; }
  .ledger-details summary::-webkit-details-marker { display:none; }
  .ledger-details-body { padding-top:8px; display:flex; flex-direction:column; gap:6px; }
  .ledger-details-body.mono { font-family: var(--mono); font-size:11px; color: var(--text-soft); }
  .ledger-kv { display:flex; justify-content:space-between; gap:8px; font-size:11px; }
  .ledger-kv span:first-child { color:var(--text-muted); }

  /* Boxes */
  .ledger-box { background:#fff; border:1px solid var(--border); border-radius:12px; padding:14px; box-shadow:var(--shadow-sm); }
  .ledger-box h3 { font-family:var(--font-head); font-size:13px; font-weight:700; margin-bottom:8px; letter-spacing:-0.01em; }
  .ledger-box-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .ledger-box-head h3 { margin-bottom:0; }
  .ledger-link-btn { background:none; border:none; font-size:11px; font-weight:600; color:var(--accent-deep); cursor:pointer; }
  .ledger-pay-status { font-size:12px; font-weight:600; color:var(--text-soft); margin-bottom:8px; }
  .ledger-hint { font-size:10px; color:var(--text-muted); margin-top:6px; }

  /* Timeline */
  .ledger-timeline { display:flex; flex-direction:column; gap:1px; }
  .ledger-timeline-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border-subtle); font-size:11px; }
  .ledger-timeline-row:last-child{border-bottom:none}
  .ledger-timeline-dot { width:7px; height:7px; border-radius:50%; background: var(--accent); flex-shrink:0; }
  .ledger-timeline-row:last-child .ledger-timeline-dot { background: var(--good); }
  .ledger-timeline-event { color:var(--text); flex:1; }
  .ledger-timeline-actor { font-size:10px; padding:2px 6px; border-radius:999px; background:var(--bg); border:1px solid var(--border); color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; }
  .ledger-audit-expand { margin-top:10px; padding:8px 10px; background:var(--bg); border-radius:8px; }
  .ledger-mono { font-family:var(--mono); font-size:11px; color:var(--text-soft); overflow-wrap:anywhere; }

  /* Tech */
  .ledger-tech { background:#fff; border:1px solid var(--border); border-radius:12px; padding:10px 14px; }
  .ledger-tech-toggle { width:100%; display:flex; justify-content:space-between; align-items:center; background:none; border:none; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); cursor:pointer; }
  .ledger-tech-chevron { font-size:10px; transition: transform 0.2s; }
  .ledger-tech-body { margin-top:12px; display:flex; flex-direction:column; gap:12px; }
  .ledger-tech-title { font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-soft); margin-bottom:6px; }
  .ledger-pre { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; font-family:var(--mono); font-size:10px; line-height:1.5; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .ledger-provider { display:flex; justify-content:space-between; gap:8px; align-items:center; padding:8px 10px; background:var(--bg); border-radius:8px; font-size:11px; }
  .ledger-provider .pill { font-family:var(--mono); font-size:10px; font-weight:700; padding:2px 6px; border-radius:999px; }
  .ledger-provider .pill.mock { background:#fff; border:1px solid var(--border); color:var(--text-muted); }
  .ledger-provider .pill.disabled { background:var(--warn-soft); color:var(--warn); }
  .ledger-tech-list { margin:0; padding-left:16px; font-size:11px; color:var(--text-soft); line-height:1.5; }
  .ledger-tech-note { font-size:10px; color:var(--text-muted); font-style:italic; }

  /* Sticky mobile — fixed to viewport bottom from initial load, no content cover */
  .ledger-sticky { position:sticky; bottom:0; left:0; right:0; background: rgba(255,255,255,0.96); backdrop-filter: blur(8px); border-top:1px solid var(--border); padding:10px 12px calc(10px + env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:6px; box-shadow: 0 -4px 12px rgba(32,26,21,0.06); }
  .variant-mobile .ledger-sticky { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); width: 390px; max-width: calc(100vw - 20px); z-index: 30; border:1px solid var(--border); border-radius: 12px; padding:10px 12px; box-shadow: 0 8px 24px rgba(32,26,21,0.14); }
  .variant-mobile .ledger-stack { padding-bottom: 96px; }
  .variant-mobile .proto-frame-body { padding-bottom: 0; }
  .ledger-sticky-inner { display:flex; align-items:center; gap:10px; }
  .ledger-sticky-total { font-size:12px; font-weight:700; }
  .ledger-sticky .ledger-btn-primary { flex:1; padding:10px 14px; font-size:13px; }
  .ledger-sticky-note { font-size:10px; color:var(--text-muted); text-align:center; }
`;
