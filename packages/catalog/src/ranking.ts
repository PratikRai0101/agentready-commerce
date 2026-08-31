import type { HardConstraints, PurchaseIntent, SoftPreference } from "@agentready/domain";
import { estimateShipping } from "./catalog";
import type { Catalog, CatalogProduct, ShoeUseCase } from "./catalog";

export const REQUIRED_HARD_CONSTRAINTS = ["size", "useCase"] as const;

export type MissingConstraint = {
  name: string;
  label: string;
  options?: string[];
};

export function missingHardConstraints(intent: PurchaseIntent): MissingConstraint[] {
  const missing: MissingConstraint[] = [];
  const c = intent.hardConstraints;
  if (!c.size) {
    missing.push({ name: "size", label: "Shoe size (e.g. UK 9)" });
  }
  if (!c.useCase) {
    missing.push({
      name: "useCase",
      label: "Primary use (road, trail, gym, casual)",
      options: ["road", "trail", "gym", "casual"],
    });
  }
  return missing;
}

export type ProductMatch = {
  product: CatalogProduct;
  score: number;
  withinBudget: boolean;
  sizeAvailable: boolean;
  inStock: boolean;
  returnable: boolean;
  deliveryMet: boolean;
  colourMatched: boolean;
  reasons: string[];
  compromises: string[];
};

export type RankingResult = {
  matches: ProductMatch[];
  missing: MissingConstraint[];
  ranked: boolean;
};

export function rankProducts(
  intent: PurchaseIntent,
  catalog: Catalog,
  nowIso?: string,
): RankingResult {
  const missing = missingHardConstraints(intent);
  const c = intent.hardConstraints;

  if (missing.length > 0) {
    return { matches: [], missing, ranked: false };
  }

  const soft = new Map(intent.softPreferences.map((p: SoftPreference) => [p.name, p.value]));

  const matches: ProductMatch[] = catalog.products
    .map((product) => evaluate(product, c, soft, nowIso ?? new Date().toISOString()))
    .filter((match) => match.withinBudget && match.sizeAvailable && match.inStock)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return { matches, missing: [], ranked: true };
}

function evaluate(
  product: CatalogProduct,
  c: HardConstraints,
  soft: Map<string, string>,
  nowIso: string,
): ProductMatch {
  const reasons: string[] = [];
  const compromises: string[] = [];
  let score = 0;

  const sizeAvailable = Boolean(c.size && product.variants.some((v) => v.size === c.size));
  const inStock = Boolean(
    c.size && product.variants.some((v) => v.size === c.size && v.inStock > 0),
  );

  const withinBudget = product.priceMinor <= c.maxAmountMinor;
  const colourMatched = !c.colour || product.colour.includes(c.colour);
  const returnable = !c.mustBeReturnable || product.returnable;
  const delivery = estimateShipping(product.deliveryLeadDays, nowIso);
  const deliveryMet = !c.deliverBy || delivery.deliverBy <= c.deliverBy;

  if (product.useCase === (c.useCase as ShoeUseCase)) {
    score += 35;
    reasons.push(`Purpose-built for ${c.useCase} running`);
  } else {
    score += 12;
    compromises.push(`Not purpose-built for ${c.useCase}`);
  }

  const requestedFit = soft.get("fit");
  if (!requestedFit || product.fit === requestedFit) {
    score += 10;
    if (requestedFit) reasons.push(`${capitalize(product.fit)} fit`);
  } else {
    compromises.push(`Fit is ${product.fit}, not ${requestedFit}`);
  }

  const cushioning = soft.get("cushioning");
  if (!cushioning || product.cushioning === cushioning) {
    score += 10;
    if (cushioning) reasons.push(`${capitalize(product.cushioning)} cushioning`);
  } else {
    compromises.push(`Cushioning is ${product.cushioning}, not ${cushioning}`);
  }

  const distance = Number(soft.get("distance") ?? "0");
  if (distance > 0) {
    const delta = Math.abs(product.typicalDistanceKm - distance);
    if (delta <= 2) {
      score += 12;
      reasons.push(`Covers your ~${distance}K distance`);
    } else if (product.typicalDistanceKm < distance) {
      compromises.push(`Optimised for ${product.typicalDistanceKm}K, shorter than your ~${distance}K`);
    } else {
      reasons.push(`Handles up to ${product.typicalDistanceKm}K`);
    }
  }

  if (colourMatched) {
    score += 5;
  } else {
    compromises.push(`No ${c.colour} colourway`);
  }

  if (withinBudget) {
    score += 8;
    reasons.push(`₹${(product.priceMinor / 100).toFixed(2)} within budget`);
  } else {
    compromises.push(`₹${(product.priceMinor / 100).toFixed(2)} exceeds budget`);
  }

  if (deliveryMet) {
    score += 6;
    reasons.push(`Ships within ${product.deliveryLeadDays} day${product.deliveryLeadDays === 1 ? "" : "s"}`);
  } else {
    compromises.push(`Ships in ${product.deliveryLeadDays} days, after your deadline`);
  }

  if (returnable) {
    score += 4;
  } else {
    compromises.push("Not returnable");
  }

  score += Math.round(product.rating * 4);

  return {
    product,
    score,
    withinBudget,
    sizeAvailable,
    inStock,
    returnable,
    deliveryMet,
    colourMatched,
    reasons,
    compromises,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}