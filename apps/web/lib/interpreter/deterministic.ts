/**
 * AI-1 deterministic fallback interpreter.
 *
 * Deterministic parsing remains authoritative for values it can safely parse.
 * This module additionally detects actions, corrections, removals and
 * negations that the AI-0 parser could not represent.
 */
import { SHOE_CATALOG } from "@agentready/catalog";
import { isNegated, parseIntentMessage, type ParsedIntent } from "../intent";
import {
  INTERPRETER_SCHEMA_VERSION,
  type ProposedHardConstraint,
  type ProposedSoftPreference,
  type StructuredInterpretation,
} from "./schema";

export type DeterministicInterpretation = StructuredInterpretation;

const PRODUCT_NAME_ALIASES: Record<string, string[]> = {
  p_streak_4: ["streak 4", "streak4", "streak"],
  p_vista_max: ["max cushion", "vista max", "maxcushion"],
  p_stride_lite: ["stride lite", "stride"],
  p_trail_rock: ["trail rock"],
  p_gym_pace: ["gym pace"],
  p_casual_day: ["everyday", "casual day"],
};

function findProductIds(message: string): string[] {
  const lower = message.toLowerCase();
  const found: string[] = [];
  for (const product of SHOE_CATALOG.products) {
    const aliases = PRODUCT_NAME_ALIASES[product.productId] ?? [product.name.toLowerCase()];
    for (const alias of aliases) {
      if (lower.includes(alias)) {
        found.push(product.productId);
        break;
      }
    }
  }
  return found.slice(0, 5);
}

/** Detect negated constraint names present in the message. */
function detectRemovals(message: string): string[] {
  const removals: string[] = [];
  if (/\bnot\s+black\b|\bno\s+black\b|\bdon'?t\s+(?:want|like)\s+black\b/i.test(message)) removals.push("colour");
  if (isNegated(message, "road") || isNegated(message, "running")) removals.push("useCase");
  if (isNegated(message, "trail")) removals.push("useCase");
  if (isNegated(message, "gym")) removals.push("useCase");
  if (isNegated(message, "casual")) removals.push("useCase");
  for (const colour of ["white", "grey", "navy", "blue", "red"]) {
    if (isNegated(message, colour)) removals.push("colour");
  }
  if (/\bremove\b.*\bcushioning\b|\bno\s+cushioning\b/i.test(message)) removals.push("cushioning");
  if (/\bremove\b.*\bfit\b|\bno\s+wide\b|\bnot\s+wide\b/i.test(message)) removals.push("fit");
  if (/\bremove\b.*\b(?:return|returnable)\b|\bnot\s+returnable\b/i.test(message)) removals.push("mustBeReturnable");
  return [...new Set(removals)];
}

function detectCorrections(message: string): string[] {
  const corrections: string[] = [];
  if (/\b(?:actually|make\s+it|instead|change|switch|correction)\b.*\bsize\b/i.test(message)) corrections.push("size");
  if (/\b(?:actually|make\s+it|instead|change|switch)\b.*\bbudget\b|\b(?:under|below|max)\s+₹/i.test(message)) corrections.push("maxAmountMinor");
  return corrections;
}

/** Build evidence = shortest quoted substring of the message matching the token. */
function evidenceFor(message: string, token: string): string {
  const lower = message.toLowerCase();
  const idx = lower.indexOf(token.toLowerCase());
  if (idx >= 0) return message.slice(idx, idx + token.length);
  return token;
}

export function deterministicInterpretation(
  message: string,
  currentIntent: ParsedIntent,
): DeterministicInterpretation {
  const lower = message.toLowerCase().replace(/[,.]/g, " ");
  const parsed = parseIntentMessage(message);
  const productIds = findProductIds(message);
  const removals = detectRemovals(message);
  const corrections = detectCorrections(message);

  const proposedHard: ProposedHardConstraint[] = [];
  const proposedSoft: ProposedSoftPreference[] = [];

  if (parsed.size) proposedHard.push({ name: "size", value: parsed.size, evidence: evidenceFor(message, parsed.size) });
  if (parsed.colour) proposedHard.push({ name: "colour", value: parsed.colour, evidence: evidenceFor(message, parsed.colour) });
  if (parsed.useCase) proposedHard.push({ name: "useCase", value: parsed.useCase, evidence: evidenceFor(message, parsed.useCase) });
  if (parsed.maxAmountMinor !== undefined) proposedHard.push({ name: "maxAmountMinor", value: parsed.maxAmountMinor, evidence: evidenceFor(message, String(parsed.maxAmountMinor / 100)) });
  if (parsed.mustBeReturnable) proposedHard.push({ name: "mustBeReturnable", value: true, evidence: evidenceFor(message, "return") });
  if (parsed.fit) proposedSoft.push({ name: "fit", value: parsed.fit, evidence: evidenceFor(message, parsed.fit) });
  if (parsed.cushioning) proposedSoft.push({ name: "cushioning", value: parsed.cushioning, evidence: evidenceFor(message, parsed.cushioning) });
  if (parsed.distanceKm !== undefined) proposedSoft.push({ name: "distanceKm", value: parsed.distanceKm, evidence: evidenceFor(message, `${parsed.distanceKm}K`) });

  // "Show me something cheaper" → deterministic budget reduction (app code, not LLM).
  // This is a refine action with explicit budget reduction.
  const isCheaperRequest = /\bcheaper\b|\bcheapest\b|\blower\s+price\b|\bless\s+expensive\b/.test(lower);
  if (isCheaperRequest) {
    const currentBudget = currentIntent.maxAmountMinor ?? 500_000;
    const reduced = Math.max(10_000, Math.round(currentBudget * 0.8));
    proposedHard.push({ name: "maxAmountMinor", value: reduced, evidence: evidenceFor(message, "cheaper") });
    if (!corrections.includes("maxAmountMinor")) corrections.push("maxAmountMinor");
  }

  let action: StructuredInterpretation["action"] = "search";

  if (/\brestart\b|\bstart\s+over\b|\bnew\s+conversation\b/.test(lower)) {
    action = "restart";
  } else if (/\bcompare\b|\bversus\b|\bvs\b/.test(lower) && productIds.length >= 1) {
    action = "compare";
  } else if (/\bwhy\s+(?:not|this|that|the)\b|\bwhy\s+\w+\b|\bexplain\b|\bwhat\s+am\s+i\s+compromising\b/.test(lower)) {
    action = "explain";
  } else if (/\b(?:select|pick|choose)\b/.test(lower) && productIds.length >= 1) {
    action = "select";
  } else if (removals.length > 0 || corrections.length > 0 || /\bcheaper\b/.test(lower)) {
    action = "refine";
  } else if (currentIntent && Object.keys(currentIntent).length > 0) {
    action = "search";
  }

  const ambiguities: string[] = [];
  if (action === "compare" && productIds.length < 2) ambiguities.push("Which two products should I compare?");
  if (action === "explain") ambiguities.push("Which recommendation would you like explained?");

  return {
    schemaVersion: INTERPRETER_SCHEMA_VERSION,
    action,
    proposedHardConstraints: proposedHard,
    proposedSoftPreferences: proposedSoft,
    corrections,
    removals,
    ambiguities,
    confidence: 1,
    requestedProductIds: action === "compare" || action === "select" ? productIds : [],
  };
}
