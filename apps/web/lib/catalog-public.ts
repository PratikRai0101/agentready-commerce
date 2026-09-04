import { SHOE_CATALOG } from "@agentready/catalog";

/**
 * Machine-readable projection of the merchant catalog for buyer clients.
 * Read-only view over the same typed SHOE_CATALOG the ranking engine uses —
 * no separate data model, so the storefront and machine clients can never
 * disagree on price, stock, or policy. Synthetic demo data, labelled as such
 * in the discovery descriptor.
 */
export type PublicCatalogProduct = {
  productId: string;
  name: string;
  brand: string;
  priceMinor: number;
  currency: "INR";
  useCase: string;
  fit: string;
  cushioning: string;
  colours: string[];
  typicalDistanceKm: number;
  returnable: boolean;
  deliveryLeadDays: number;
  description: string;
  variants: Array<{ sku: string; size: string; inStock: number }>;
};

export type PublicCatalog = {
  merchantId: string;
  merchantName: string;
  currency: "INR";
  productCount: number;
  products: PublicCatalogProduct[];
  returnPolicy: { policyId: string; windowDays: number; condition: string };
};

export function buildPublicCatalog(): PublicCatalog {
  return {
    merchantId: SHOE_CATALOG.merchantId,
    merchantName: SHOE_CATALOG.merchantName,
    currency: "INR",
    productCount: SHOE_CATALOG.products.length,
    products: SHOE_CATALOG.products.map((p) => ({
      productId: p.productId,
      name: p.name,
      brand: p.brand,
      priceMinor: p.priceMinor,
      currency: p.currency,
      useCase: p.useCase,
      fit: p.fit,
      cushioning: p.cushioning,
      colours: [...p.colour],
      typicalDistanceKm: p.typicalDistanceKm,
      returnable: p.returnable,
      deliveryLeadDays: p.deliveryLeadDays,
      description: p.description,
      variants: p.variants.map((v) => ({ sku: v.sku, size: v.size, inStock: v.inStock })),
    })),
    returnPolicy: {
      policyId: SHOE_CATALOG.returnPolicy.policyId,
      windowDays: SHOE_CATALOG.returnPolicy.windowDays,
      condition: SHOE_CATALOG.returnPolicy.condition,
    },
  };
}
