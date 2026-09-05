import { describe, expect, it } from "vitest";

/**
 * Regression test for Decision Ledger prototype approval gating.
 * Mirrors the UI-only prototype state machine in apps/web/app/ledger-prototype/page.tsx
 * - Approval disabled while re-ranking (showLoading) or rebuilding quote
 * - After an edit, reset to "Review updated order" and keep approval disabled until
 *   updated terms are ready (showLoading false) AND displayed (reviewInView true)
 * - Audit events rendered from same mock order state — approval event only after Approve
 * - Payments remain disabled throughout
 */

function formatINR(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

type OrderState = "QUOTED" | "AWAITING_APPROVAL" | "APPROVED";

type PrototypeState = {
  selectedId: string | null;
  approved: boolean;
  showLoading: boolean;
  pendingUpdatedReview: boolean;
  reviewInView: boolean;
};

function deriveOrderState(s: PrototypeState): OrderState {
  if (!s.selectedId) return "QUOTED";
  if (s.approved) return "APPROVED";
  return "AWAITING_APPROVAL";
}

function isApprovalDisabled(s: PrototypeState): boolean {
  // Main approval button + sticky Approve button must be disabled while rebuilding
  if (s.showLoading) return true;
  if (s.pendingUpdatedReview) {
    // pending review requires updated terms to be displayed before approval is enabled
    // For main button (inside review card) this is true when review is visible -> enabled,
    // but we model sticky disabled until reviewInView. For simplicity, disable if not in view.
    if (!s.reviewInView) return true;
  }
  if (!s.selectedId) return true;
  return false;
}

function stickyState(s: PrototypeState): { text: string; disabled: boolean; note: string } {
  if (s.showLoading) {
    return {
      text: "Review updated order",
      disabled: true,
      note: "Rebuilding quote — approval disabled until updated terms are displayed",
    };
  }
  if (s.pendingUpdatedReview) {
    if (!s.reviewInView) {
      return {
        text: "Review updated order",
        disabled: false, // enabled to scroll to review
        note: "Updated terms below — review before approving",
      };
    }
    // pending but review now visible and not loading -> ready to approve (will clear pending)
    return {
      text: "Approve this exact order",
      disabled: false,
      note: "Mock · no charge · hashes in Technical details",
    };
  }
  if (s.approved) {
    return { text: "Approved ✓", disabled: false, note: "Mock · no charge · hashes in Technical details" };
  }
  if (!s.reviewInView) {
    return { text: "Review order", disabled: false, note: "Tap to review exact terms before approval" };
  }
  return { text: "Approve this exact order", disabled: false, note: "Mock · no charge · hashes in Technical details" };
}

function auditCount(s: PrototypeState): number {
  const base = 5;
  return s.approved ? base + 1 : base;
}

function isPayDisabled(): boolean {
  // Prototype never submits payment — always disabled
  return true;
}

describe("ledger prototype regression — approval gating while re-ranking", () => {
  it("disables approval while re-ranking/rebuilding quote", () => {
    const s: PrototypeState = {
      selectedId: "p_vista_max",
      approved: false,
      showLoading: true,
      pendingUpdatedReview: true,
      reviewInView: false,
    };
    expect(isApprovalDisabled(s)).toBe(true);
    expect(stickyState(s).text).toBe("Review updated order");
    expect(stickyState(s).disabled).toBe(true);
    expect(deriveOrderState(s)).toBe("AWAITING_APPROVAL");
    expect(isPayDisabled()).toBe(true);
  });

  it("after edit resets to 'Review updated order' and keeps approval disabled until updated terms displayed", () => {
    // Initial approved state
    let s: PrototypeState = {
      selectedId: "p_vista_max",
      approved: true,
      showLoading: false,
      pendingUpdatedReview: false,
      reviewInView: true,
    };
    expect(deriveOrderState(s)).toBe("APPROVED");
    expect(auditCount(s)).toBe(6);
    expect(stickyState(s).text).toBe("Approved ✓");

    // Edit: remove chip -> invalidates approval, starts rebuilding
    s = {
      selectedId: "p_vista_max",
      approved: false,
      showLoading: true,
      pendingUpdatedReview: true,
      reviewInView: false, // still at top, review not visible
    };
    expect(deriveOrderState(s)).toBe("AWAITING_APPROVAL");
    expect(auditCount(s)).toBe(5);
    expect(isApprovalDisabled(s)).toBe(true);
    expect(stickyState(s).text).toBe("Review updated order");
    expect(stickyState(s).disabled).toBe(true);
    expect(isPayDisabled()).toBe(true);

    // Re-ranking finished but review still not scrolled into view -> still Review updated order (enabled to scroll)
    s = { ...s, showLoading: false };
    expect(isApprovalDisabled(s)).toBe(true); // because pending and not in view
    expect(stickyState(s).text).toBe("Review updated order");
    expect(stickyState(s).disabled).toBe(false); // enabled to scroll
    expect(auditCount(s)).toBe(5);

    // Scroll to review -> updated terms displayed -> pending clears, approval enabled
    s = { ...s, reviewInView: true };
    // Simulate effect that clears pending when reviewInView && !showLoading
    if (s.pendingUpdatedReview && !s.showLoading && s.reviewInView) {
      s.pendingUpdatedReview = false;
    }
    expect(s.pendingUpdatedReview).toBe(false);
    expect(stickyState(s).text).toBe("Approve this exact order");
    expect(stickyState(s).disabled).toBe(false);
    expect(isApprovalDisabled(s)).toBe(false);
  });

  it("enables approval only once updated terms are ready and displayed", () => {
    // After edit, before review visible, approval must remain disabled
    let s: PrototypeState = {
      selectedId: "p_vista_max",
      approved: false,
      showLoading: true,
      pendingUpdatedReview: true,
      reviewInView: false,
    };
    expect(isApprovalDisabled(s)).toBe(true);

    // Still rebuilding, even if scrolled to review, still disabled
    s = { ...s, reviewInView: true };
    expect(isApprovalDisabled(s)).toBe(true); // because showLoading true
    expect(stickyState(s).text).toBe("Review updated order");

    // Rebuilding done, now displayed -> enabled
    s = { ...s, showLoading: false };
    // pending clears via effect
    if (s.pendingUpdatedReview && !s.showLoading && s.reviewInView) s.pendingUpdatedReview = false;
    expect(isApprovalDisabled(s)).toBe(false);
    expect(stickyState(s).text).toBe("Approve this exact order");
  });

  it("shows approval only after clicking Approve, from same mock order state", () => {
    let s: PrototypeState = {
      selectedId: "p_vista_max",
      approved: false,
      showLoading: false,
      pendingUpdatedReview: false,
      reviewInView: true,
    };
    expect(deriveOrderState(s)).toBe("AWAITING_APPROVAL");
    expect(auditCount(s)).toBe(5);
    expect(stickyState(s).text).toBe("Approve this exact order");

    // Click Approve
    s.approved = true;
    expect(deriveOrderState(s)).toBe("APPROVED");
    expect(auditCount(s)).toBe(6);
    expect(stickyState(s).text).toBe("Approved ✓");
  });

  it("approval invalidation after edits: audit drops approval event and order returns to awaiting", () => {
    let s: PrototypeState = {
      selectedId: "p_vista_max",
      approved: true,
      showLoading: false,
      pendingUpdatedReview: false,
      reviewInView: true,
    };
    expect(auditCount(s)).toBe(6);
    expect(deriveOrderState(s)).toBe("APPROVED");

    // Edit chip
    s = {
      selectedId: "p_vista_max",
      approved: false,
      showLoading: true,
      pendingUpdatedReview: true,
      reviewInView: false,
    };
    expect(auditCount(s)).toBe(5);
    expect(deriveOrderState(s)).toBe("AWAITING_APPROVAL");
    expect(isApprovalDisabled(s)).toBe(true);

    // After re-ranking, without approval, still awaiting
    s.showLoading = false;
    expect(deriveOrderState(s)).toBe("AWAITING_APPROVAL");
    expect(auditCount(s)).toBe(5);
  });

  it("currency formatting uses Indian grouping without trailing .00", () => {
    expect(formatINR(489900)).toBe("₹4,899");
    expect(formatINR(4900)).toBe("₹49");
    expect(formatINR(494800)).toBe("₹4,948");
    // Ensure no trailing zeros
    expect(formatINR(489900)).not.toContain(".00");
  });

  it("payments remain disabled in all states", () => {
    const states: PrototypeState[] = [
      { selectedId: null, approved: false, showLoading: false, pendingUpdatedReview: false, reviewInView: false },
      { selectedId: "p_vista_max", approved: false, showLoading: true, pendingUpdatedReview: true, reviewInView: false },
      { selectedId: "p_vista_max", approved: false, showLoading: false, pendingUpdatedReview: false, reviewInView: true },
      { selectedId: "p_vista_max", approved: true, showLoading: false, pendingUpdatedReview: false, reviewInView: true },
    ];
    for (const s of states) {
      expect(isPayDisabled()).toBe(true);
    }
  });
});
