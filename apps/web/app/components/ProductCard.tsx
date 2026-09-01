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

function ProductImageFallback({ name }: { name: string }) {
  return (
    <div className="product-card-img product-card-img-fallback" aria-label={name}>
      <svg viewBox="0 0 432 270" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <rect width="432" height="270" fill="#EDE4D8"/>
        <path d="M180 120C180 100 200 80 220 80C240 80 260 95 270 110C280 95 300 85 320 90C340 95 350 115 345 130C340 145 320 155 300 150L280 145C275 155 265 160 255 160H200C185 160 180 145 180 135V120Z" fill="#C85C3B" opacity="0.7"/>
        <path d="M140 170L160 155L180 165L220 140L260 155L300 145L340 160L360 175" stroke="#A94A2E" strokeWidth="2" strokeLinecap="round"/>
        <text x="216" y="210" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="14" fontWeight="600" fill="#574E46">RunVista</text>
      </svg>
    </div>
  );
}

export function ProductCard({ match, fitScore, onSelect, onExplain, onCompare, disabled, showSelect }: Props) {
  const { product, scoreNormalized, role, matchedPreferences, compromises, eligibility } = match;
  const [showEvidence, setShowEvidence] = useState(false);
  const price = `\u20B9${(product.priceMinor / 100).toLocaleString("en-IN")}`;

  return (
    <article className="product-card" aria-label={product.name}>
      <div className="product-card-badge">{ROLE_LABELS[role] ?? "Option"}</div>
      {product.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="product-card-img"
          src={product.image}
          alt={product.name}
          width={432}
          height={270}
          loading="lazy"
        />
      ) : (
        <ProductImageFallback name={product.name} />
      )}
      <div className="product-card-body">
        <div className="product-card-name-row">
          <span className="product-card-name">{product.name}</span>
          <span className="product-card-price">{price}</span>
        </div>
        <div className="product-card-match">
          {fitScore ? `${fitScore.fitScore}% fit match` : `${scoreNormalized}/100`}
        </div>
        {matchedPreferences.slice(0, 1).map((r) => (
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
          <button className="btn-outline product-card-action-why" type="button" onClick={() => onExplain?.(product.productId)} disabled={disabled}>
            Why?
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
