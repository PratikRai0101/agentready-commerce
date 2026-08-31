"use client";

import type { ProductMatch } from "@agentready/catalog";

type Props = {
  match: ProductMatch;
  fitScore?: { fitScore: number; note: string };
  roleLabel: string;
  onSelect: (productId: string) => void;
  disabled: boolean;
  showSelect: boolean;
};

export function ProductCard({ match, fitScore, roleLabel, onSelect, disabled, showSelect }: Props) {
  const { product, score, reasons, compromises } = match;
  const price = `\u20B9${(product.priceMinor / 100).toLocaleString("en-IN")}`;

  return (
    <article className="product-card" aria-label={product.name}>
      <div className="product-card-badge">{roleLabel}</div>
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
        {fitScore ? (
          <div className="product-card-match">
            {fitScore.fitScore}% match
          </div>
        ) : (
          <div className="product-card-match">score {score}</div>
        )}
        {reasons.map((r) => (
          <div key={r} className="product-card-reason">
            &bull; {r}
          </div>
        ))}
        {compromises.map((c) => (
          <div key={c} className="product-card-compromise">
            &ndash; {c}
          </div>
        ))}
        <div className="product-card-actions">
          <button
            className="btn-outline"
            type="button"
            aria-label={`Compare ${product.name}`}
            disabled={disabled}
          >
            Compare
          </button>
          <button
            className="btn-outline"
            type="button"
            aria-label={`Why ${product.name}`}
            disabled={disabled}
          >
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
      </div>
    </article>
  );
}
