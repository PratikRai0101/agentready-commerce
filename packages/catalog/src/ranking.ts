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
  if (!c.size) missing.push({ name: "size", label: "Shoe size (e.g. UK 9)" });
  if (!c.useCase) missing.push({ name: "useCase", label: "Primary use (road, trail, gym, casual)", options: ["road", "trail", "gym", "casual"] });
  return missing;
}

/* ── Documented scoring weights (must sum to 100) ── */

export const SCORE_WEIGHTS = {
  useCase: 28,
  fit: 14,
  cushioning: 14,
  distance: 10,
  colour: 5,
  budget: 8,
  delivery: 7,
  returnable: 5,
  rating: 10,
} as const;

export const SCORE_MAXIMUM = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0); // 101

export type RecommendationRole = "bestOverall" | "cheaperAlternative" | "tradeoffChoice" | "none";

export type EligibilityEvidence = {
  withinBudget: boolean;
  sizeAvailable: boolean;
  inStock: boolean;
  returnable: boolean;
  deliveryMet: boolean;
  rejectionReasons: string[];
};

export type ProductMatch = {
  product: CatalogProduct;
  score: number;
  scoreNormalized: number;
  role: RecommendationRole;
  roleJustification: string;
  matchedRequirements: string[];
  matchedPreferences: string[];
  compromises: string[];
  eligibility: EligibilityEvidence;
  colourMatched: boolean;
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
  if (missing.length > 0) return { matches: [], missing, ranked: false };

  const soft = new Map(intent.softPreferences.map((p: SoftPreference) => [p.name, p.value]));
  const now = nowIso ?? new Date().toISOString();

  // Phase 1: Evaluate all products (eligibility + preference score)
  const all = catalog.products.map((product) => evaluate(product, c, soft, now));

  // Phase 2: Filter to eligible only
  const eligible = all.filter((m) => m.eligibility.rejectionReasons.length === 0);

  // Phase 3: Sort by normalized score descending, take top 3
  const top = eligible.sort((a, b) => b.scoreNormalized - a.scoreNormalized).slice(0, 3);

  // Phase 4: Assign roles based on evidence
  assignRoles(top);

  return { matches: top, missing: [], ranked: true };
}

function evaluate(
  product: CatalogProduct,
  c: HardConstraints,
  soft: Map<string, string>,
  nowIso: string,
): ProductMatch {
  const matchedRequirements: string[] = [];
  const matchedPreferences: string[] = [];
  const compromises: string[] = [];
  const rejectionReasons: string[] = [];
  let rawScore = 0;

  // ── Eligibility checks (hard filters) ──
  const sizeAvailable = Boolean(c.size && product.variants.some((v) => v.size === c.size));
  const inStock = Boolean(c.size && product.variants.some((v) => v.size === c.size && v.inStock > 0));
  const withinBudget = product.priceMinor <= c.maxAmountMinor;
  const colourMatched = !c.colour || product.colour.includes(c.colour);
  const returnable = !c.mustBeReturnable || product.returnable;
  const delivery = estimateShipping(product.deliveryLeadDays, nowIso);
  const deliveryMet = !c.deliverBy || delivery.deliverBy <= c.deliverBy;

  if (!withinBudget) rejectionReasons.push(`₹${fmtPrice(product.priceMinor)} exceeds budget of ₹${fmtPrice(c.maxAmountMinor)}`);
  if (!sizeAvailable) rejectionReasons.push(`Size ${c.size} not available`);
  if (!inStock) rejectionReasons.push(`Out of stock in ${c.size}`);
  if (!returnable) rejectionReasons.push("Not returnable (required)");
  if (!deliveryMet) rejectionReasons.push(`Delivery after deadline (${product.deliveryLeadDays} days)`);

  // ── Preference scoring ──
  if (product.useCase === (c.useCase as ShoeUseCase)) {
    rawScore += SCORE_WEIGHTS.useCase;
    matchedRequirements.push(`Purpose-built for ${c.useCase}`);
  } else {
    rawScore += Math.round(SCORE_WEIGHTS.useCase * 0.43); // 12 out of 28
    compromises.push(`Not purpose-built for ${c.useCase}`);
  }

  const requestedFit = soft.get("fit");
  if (!requestedFit || product.fit === requestedFit) {
    rawScore += SCORE_WEIGHTS.fit;
    if (requestedFit) matchedPreferences.push(`${capitalize(product.fit)} fit`);
  } else {
    compromises.push(`Fit is ${product.fit}, not ${requestedFit}`);
  }

  const cushioning = soft.get("cushioning");
  if (!cushioning || product.cushioning === cushioning) {
    rawScore += SCORE_WEIGHTS.cushioning;
    if (cushioning) matchedPreferences.push(`${capitalize(product.cushioning)} cushioning`);
  } else {
    compromises.push(`Cushioning is ${product.cushioning}, not ${cushioning}`);
  }

  const distance = Number(soft.get("distance") ?? "0");
  if (distance > 0) {
    const delta = Math.abs(product.typicalDistanceKm - distance);
    if (delta <= 2) {
      rawScore += SCORE_WEIGHTS.distance;
      matchedPreferences.push(`Covers ~${distance}K distance`);
    } else if (product.typicalDistanceKm < distance) {
      compromises.push(`Optimised for ${product.typicalDistanceKm}K, shorter than ~${distance}K`);
    } else {
      matchedPreferences.push(`Handles up to ${product.typicalDistanceKm}K`);
    }
  }

  if (colourMatched) {
    rawScore += SCORE_WEIGHTS.colour;
    if (c.colour) matchedPreferences.push(`${capitalize(c.colour)} colour`);
  } else {
    compromises.push(`No ${c.colour} colourway`);
  }

  if (withinBudget) {
    rawScore += SCORE_WEIGHTS.budget;
    matchedRequirements.push(`${fmtPrice(product.priceMinor)} within budget`);
  }

  if (deliveryMet) {
    rawScore += SCORE_WEIGHTS.delivery;
    matchedRequirements.push(`Ships in ${product.deliveryLeadDays} day${product.deliveryLeadDays === 1 ? "" : "s"}`);
  } else {
    compromises.push(`Ships in ${product.deliveryLeadDays} days, after deadline`);
  }

  if (returnable) {
    rawScore += SCORE_WEIGHTS.returnable;
  }

  // Rating: normalize to 0..SCORE_WEIGHTS.rating
  const ratingContribution = Math.round((product.rating / 5) * SCORE_WEIGHTS.rating);
  rawScore += ratingContribution;

  const scoreNormalized = Math.min(100, Math.max(0, Math.round((rawScore / SCORE_MAXIMUM) * 100)));

  return {
    product,
    score: rawScore,
    scoreNormalized,
    role: "none",
    roleJustification: "",
    matchedRequirements,
    matchedPreferences,
    compromises,
    eligibility: {
      withinBudget,
      sizeAvailable,
      inStock,
      returnable,
      deliveryMet,
      rejectionReasons,
    },
    colourMatched,
  };
}

/**
 * Assign roles based on evidence — never by array index.
 * - bestOverall: highest normalized score
 * - cheaperAlternative: genuinely cheaper than best while retaining every hard requirement
 * - tradeoffChoice: offers a meaningfully different advantage with an explicit compromise
 */
function assignRoles(matches: ProductMatch[]): void {
  if (matches.length === 0) return;

  // Best overall: highest score
  matches[0]!.role = "bestOverall";
  matches[0]!.roleJustification = "Highest preference match score across all criteria";

  if (matches.length < 2) return;

  const best = matches[0]!;
  const bestPrice = best.product.priceMinor;

  // Cheaper alternative: strictly cheaper than best, same hard requirements
  const cheaper = matches.find(
    (m) => m !== best && m.product.priceMinor < bestPrice && m.role === "none",
  );
  if (cheaper) {
    cheaper.role = "cheaperAlternative";
    const saving = fmtPrice(bestPrice - cheaper.product.priceMinor);
    cheaper.roleJustification = `${saving} less than ${best.product.name} while meeting all requirements`;
  }

  // Tradeoff choice: remaining product with meaningful compromise
  for (const m of matches) {
    if (m !== best && m !== cheaper && m.role === "none" && m.compromises.length > 0) {
      m.role = "tradeoffChoice";
      m.roleJustification = m.compromises[0] ?? "Different trade-off profile";
      break;
    }
  }
}

function fmtPrice(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
