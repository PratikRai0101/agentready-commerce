/**
 * AI-3 deterministic explanation renderer.
 *
 * Produces complete, natural, evidence-backed responses without an LLM.
 * Same product facts and decisions are returned regardless of provider
 * availability. The LLM may verbalize validated evidence but may not
 * invent facts, select candidates, calculate money or alter ranking.
 */
import type { ProductMatch } from "@agentready/catalog";

function fmtPrice(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN")}`;
}

/**
 * Render a grounded "why this one?" explanation.
 * Must cover: eligibility, role, strongest matches, top compromise,
 * price relative to budget.
 */
export function renderWhyThisOne(match: ProductMatch, budgetMinor?: number): string {
  const { product, scoreNormalized, role, roleJustification, matchedPreferences, matchedRequirements, compromises, eligibility } = match;
  const parts: string[] = [];

  // Eligibility
  const eligParts: string[] = [];
  if (eligibility.withinBudget) eligParts.push("within your budget");
  if (eligibility.inStock) eligParts.push("in stock in your size");
  if (eligibility.returnable) eligParts.push("returnable");
  if (eligibility.deliveryMet) eligParts.push(`ships in ${product.deliveryLeadDays} day${product.deliveryLeadDays === 1 ? "" : "s"}`);
  if (eligParts.length > 0) parts.push(`${product.name} is eligible — ${eligParts.join(", ")}.`);

  // Role
  if (role === "bestOverall") parts.push(`It is the best overall match with a score of ${scoreNormalized}/100.`);
  else if (role === "cheaperAlternative") parts.push(`It is a cheaper alternative — ${roleJustification}.`);
  else if (role === "tradeoffChoice") parts.push(`It is a trade-off choice — ${roleJustification}.`);

  // Strongest matches
  if (matchedPreferences.length > 0) parts.push(`Key strengths: ${matchedPreferences.join("; ")}.`);
  if (matchedRequirements.length > 0) parts.push(`Meets requirements: ${matchedRequirements.join("; ")}.`);

  // Top compromise
  if (compromises.length > 0) parts.push(`Main trade-off: ${compromises[0]}.`);

  // Price vs budget
  const price = `₹${(product.priceMinor / 100).toLocaleString("en-IN")}`;
  if (budgetMinor && budgetMinor > 0) {
    const pct = Math.round((product.priceMinor / budgetMinor) * 100);
    parts.push(`Priced at ${price} (${pct}% of your budget).`);
  } else {
    parts.push(`Priced at ${price}.`);
  }

  return parts.join(" ");
}

/**
 * Render a grounded comparison between two products.
 * Must show actual values for: price, fit, cushioning, distance/use case,
 * stock in selected size, delivery, preference matches and compromises.
 */
export function renderComparison(a: ProductMatch, b: ProductMatch): { strengths: string[]; differences: string[]; compromises: string[] } {
  const strengths: string[] = [];
  const differences: string[] = [];
  const compromises: string[] = [];

  if (!a?.product || !b?.product) {
    return { strengths: [], differences: ["Unable to compare: one or both products not found"], compromises: [] };
  }

  // Price difference
  if (a.product.priceMinor !== undefined && b.product.priceMinor !== undefined && a.product.priceMinor !== b.product.priceMinor) {
    const cheaperProduct = a.product.priceMinor < b.product.priceMinor ? a.product : b.product;
    const dearerProduct = a.product.priceMinor > b.product.priceMinor ? a.product : b.product;
    const saving = Math.abs(a.product.priceMinor - b.product.priceMinor);
    differences.push(`${cheaperProduct.name} is ${fmtPrice(saving)} cheaper than ${dearerProduct.name} (${fmtPrice(cheaperProduct.priceMinor)} vs ${fmtPrice(dearerProduct.priceMinor)})`);
  } else if (a.product.priceMinor === b.product.priceMinor) {
    strengths.push("Same price point");
  }

  // Fit
  if (a.product.fit !== b.product.fit) {
    differences.push(`Fit: ${a.product.name} is ${a.product.fit}; ${b.product.name} is ${b.product.fit}`);
  } else {
    strengths.push(`Same ${a.product.fit} fit`);
  }

  // Cushioning
  if (a.product.cushioning !== b.product.cushioning) {
    differences.push(`Cushioning: ${a.product.name} is ${a.product.cushioning}; ${b.product.name} is ${b.product.cushioning}`);
  } else {
    strengths.push(`Same ${a.product.cushioning} cushioning`);
  }

  // Distance
  if (a.product.typicalDistanceKm !== b.product.typicalDistanceKm) {
    differences.push(`Distance: ${a.product.name} up to ${a.product.typicalDistanceKm}K; ${b.product.name} up to ${b.product.typicalDistanceKm}K`);
  }

  // Use case
  if (a.product.useCase !== b.product.useCase) {
    differences.push(`Use case: ${a.product.name} is ${a.product.useCase}; ${b.product.name} is ${b.product.useCase}`);
  }

  // Stock
  const aStock = a.eligibility.inStock ? "in stock" : "out of stock";
  const bStock = b.eligibility.inStock ? "in stock" : "out of stock";
  if (aStock !== bStock) differences.push(`Stock: ${a.product.name} is ${aStock}; ${b.product.name} is ${bStock}`);

  // Delivery
  differences.push(`Delivery: ${a.product.name} in ${a.product.deliveryLeadDays} day${a.product.deliveryLeadDays === 1 ? "" : "s"}; ${b.product.name} in ${b.product.deliveryLeadDays} day${b.product.deliveryLeadDays === 1 ? "" : "s"}`);

  // Scores
  differences.push(`Score: ${a.product.name} ${a.scoreNormalized}/100; ${b.product.name} ${b.scoreNormalized}/100`);

  // Compromises
  for (const m of [a, b]) {
    if (m.compromises.length > 0) compromises.push(`${m.product.name}: ${m.compromises.join("; ")}`);
  }

  return { strengths, differences, compromises };
}

/**
 * Render a "what am I compromising?" response for a selected product.
 */
export function renderCompromises(match: ProductMatch): string {
  if (match.compromises.length === 0) {
    return `${match.product.name} satisfies all your stated preferences with no compromises.`;
  }
  return `With ${match.product.name}, you are compromising on: ${match.compromises.join("; ")}.`;
}

/**
 * Render a "cheaper" response.
 */
export function renderCheaper(
  currentBest: ProductMatch,
  cheaperOption: ProductMatch | null,
  budgetMinor: number,
): string {
  if (!cheaperOption) {
    return `There is no eligible product cheaper than ${currentBest.product.name} (₹${(currentBest.product.priceMinor / 100).toLocaleString("en-IN")}) that meets all your requirements.`;
  }
  const saving = currentBest.product.priceMinor - cheaperOption.product.priceMinor;
  const parts: string[] = [];
  parts.push(`${cheaperOption.product.name} is ₹${(saving / 100).toLocaleString("en-IN")} cheaper at ₹${(cheaperOption.product.priceMinor / 100).toLocaleString("en-IN")}.`);
  if (cheaperOption.compromises.length > 0) {
    parts.push(`Trade-offs: ${cheaperOption.compromises.join("; ")}.`);
  }
  parts.push(`Score: ${cheaperOption.scoreNormalized}/100.`);
  return parts.join(" ");
}

/**
 * Render a grounded "compare" response with actual values.
 */
export function renderCompareFull(a: ProductMatch, b: ProductMatch): string {
  const { differences, compromises } = renderComparison(a, b);
  const parts: string[] = [];
  parts.push(`${a.product.name} vs ${b.product.name}:`);
  if (differences.length > 0) parts.push(differences.join(". ") + ".");
  if (compromises.length > 0) parts.push(`Compromises: ${compromises.join(". ")}.`);
  return parts.join(" ");
}
