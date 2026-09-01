"use client";

import { useState } from "react";
import type { ProductMatch } from "@agentready/catalog";

type Props = {
  match: ProductMatch;
  fitScore?: { fitScore: number; note: string };
  onSelect: (productId: string) => void;
  onExplain?: (productId: string) => void;
  onCompare?: (productId: string) => void;
  disabled: boolean;
  showSelect: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  bestOverall: "Best overall match",
  cheaperAlternative: "Cheaper alternative",
  tradeoffChoice: "Trade-off choice",
  none: "Option",
};

export function ProductCard({ match, fitScore, onSelect, onExplain, onCompare, disabled, showSelect }: Props) {
  const { product, scoreNormalized, role, matchedPreferences, compromises, eligibility } = match;
  const [showEvidence, setShowEvidence] = useState(false);
  const price = `\u20B9${(product.priceMinor / 100).toLocaleString("en-IN")}`;

  return (
    <article className="product-card" aria-label={product.name}>
      <div className="product-card-badge">{ROLE_LABELS[role] ?? "Option"}</div>
      {product.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="product-card-img"
          src={product.image}
          alt={product.name}
          width={432}
          height={270}
          loading="lazy"
        />
      )}
      <div className="product-card-body">
        <div className="product-card-name-row">
          <span className="product-card-name">{product.name}</span>
          <span className="product-card-price">{price}</span>
        </div>
        <div className="product-card-match">
          {fitScore ? `${fitScore.fitScore}% fit match` : `${scoreNormalized}/100`}
        </div>
        {matchedPreferences.slice(0, 3).map((r) => (
          <div key={r} className="product-card-reason">&bull; {r}</div>
        ))}
        {compromises.length > 0 && (
          <div className="product-card-compromise">&ndash; {compromises[0]}</div>
        )}
        <div className="product-card-meta">
          {eligibility.inStock ? "In stock" : "Out of stock"} &middot; Ships in {product.deliveryLeadDays}d
        </div>
        <div className="product-card-actions">
          <button className="btn-outline" type="button" onClick={() => onCompare?.(product.productId)} disabled={disabled}>
            Compare
          </button>
          <button className="btn-outline" type="button" onClick={() => onExplain?.(product.productId)} disabled={disabled}>
            Why this one?
          </button>
          {showSelect && (
            <button
              className="product-card-select"
              type="button"
              onClick={() => onSelect(product.productId)}
              disabled={disabled}
            >
              Select
            </button>
          )}
        </div>
        <button
          className="product-card-evidence-toggle"
          type="button"
          onClick={() => setShowEvidence(!showEvidence)}
          aria-expanded={showEvidence}
        >
          {showEvidence ? "Hide details" : "Show details"}
        </button>
        {showEvidence && (
          <div className="product-card-evidence">
            <div className="evidence-row"><span className="evidence-label">Score</span><span>{scoreNormalized}/100</span></div>
            <div className="evidence-row"><span className="evidence-label">Role</span><span>{ROLE_LABELS[role] ?? "N/A"} &mdash; {match.roleJustification}</span></div>
            <div className="evidence-row"><span className="evidence-label">Eligible</span><span>{eligibility.rejectionReasons.length === 0 ? "Yes" : eligibility.rejectionReasons.join("; ")}</span></div>
            {matchedPreferences.length > 0 && <div className="evidence-row"><span className="evidence-label">Matched</span><span>{matchedPreferences.join("; ")}</span></div>}
            {compromises.length > 0 && <div className="evidence-row"><span className="evidence-label">Compromises</span><span>{compromises.join("; ")}</span></div>}
            <div className="evidence-row"><span className="evidence-label">Price</span><span>{price} ({Math.round((product.priceMinor / 500_000) * 100)}% of budget)</span></div>
          </div>
        )}
      </div>
    </article>
  );
}
