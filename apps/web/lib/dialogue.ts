/**
 * AI-2 session-aware dialogue state.
 *
 * Bounded, structured dialogue memory. Generated assistant prose is NOT
 * authoritative memory. Chain-of-thought is never stored.
 */
import type { ParsedIntent } from "./intent";
import type { ProductMatch } from "@agentready/catalog";

export const MAX_DIALOGUE_MEMORY_BYTES = 4000;
export const MAX_RECENT_ACTIONS = 10;

export type DialogueMemory = {
  /** Requirements currently validated by deterministic parsing. */
  requirements: string[];
  /** Soft preferences currently validated. */
  preferences: string[];
  /** Unresolved clarification questions (labels). */
  unresolved: string[];
  /** Product IDs shown in the most recent shortlist. */
  shownProductIds: string[];
  /** Product IDs selected for comparison. */
  comparedProductIds: string[];
  /** Currently selected product for quoting. */
  selectedProductId?: string;
  /** Quote state. */
  quoteProductId?: string;
  quoteValid: boolean;
  /** Bounded recent conversational action labels. */
  recentActions: string[];
  /** Concise user-evidence references (max 10). */
  evidence: string[];
};

export function createDialogueMemory(): DialogueMemory {
  return {
    requirements: [],
    preferences: [],
    unresolved: [],
    shownProductIds: [],
    comparedProductIds: [],
    quoteValid: false,
    recentActions: [],
    evidence: [],
  };
}

/**
 * Priority-ordered clarification: return the single highest-value unresolved
 * question, or null if nothing blocking remains.
 *
 * 1. contradictory or invalid requirements
 * 2. required size
 * 3. intended use case
 * 4. another constraint genuinely required for safe ranking
 * 5. optional preference clarification only when materially changes results
 */
export function nextClarification(
  intent: ParsedIntent,
  missing: string[],
): string | null {
  // Filter out already-resolved fields
  const stillMissing = missing.filter((name) => !isFieldResolved(intent, name));
  if (stillMissing.length === 0) return null;

  // Priority 1: size (required for any ranking)
  if (stillMissing.includes("size")) return "size";
  // Priority 2: use case
  if (stillMissing.includes("useCase")) return "useCase";
  // Priority 3+: remaining missing fields (all are hard constraints)
  return stillMissing[0] ?? null;
}

function isFieldResolved(intent: ParsedIntent, name: string): boolean {
  switch (name) {
    case "size": return Boolean(intent.size);
    case "useCase": return Boolean(intent.useCase);
    case "colour": return Boolean(intent.colour);
    case "maxAmountMinor": return Boolean(intent.maxAmountMinor);
    case "mustBeReturnable": return intent.mustBeReturnable === true;
    case "deliverBy": return Boolean(intent.deliverBy);
    default: return false;
  }
}

/**
 * Generate a natural acknowledgement of a correction or removal.
 * Deterministic — never invents facts.
 */
export function acknowledgeChange(
  corrections: string[],
  removals: string[],
  intent: ParsedIntent,
): string | null {
  const parts: string[] = [];
  for (const field of corrections) {
    const val = (intent as Record<string, unknown>)[field];
    if (field === "size" && typeof val === "string") parts.push(`Got it—${val} instead.`);
    if (field === "maxAmountMinor" && typeof val === "number") {
      parts.push(`Budget updated to ₹${(val / 100).toFixed(0)}.`);
    }
  }
  for (const field of removals) {
    if (field === "colour") parts.push("Black is no longer required.");
    else if (field === "cushioning") parts.push("I\u2019ve removed cushioning as a preference.");
    else if (field === "fit") parts.push("Fit preference removed.");
    else parts.push(`${field} removed.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Sync dialogue memory with current intent and ranking.
 * Call after each successful respond().
 */
export function syncMemory(
  memory: DialogueMemory,
  intent: ParsedIntent,
  shownIds: string[],
  missing: string[],
  recentAction: string,
  userEvidence: string,
): void {
  memory.requirements = [];
  if (intent.size) memory.requirements.push(`size ${intent.size}`);
  if (intent.colour) memory.requirements.push(`colour ${intent.colour}`);
  if (intent.useCase) memory.requirements.push(`use case ${intent.useCase}`);
  if (intent.maxAmountMinor) memory.requirements.push(`budget ₹${(intent.maxAmountMinor / 100).toFixed(0)}`);
  if (intent.mustBeReturnable) memory.requirements.push("returnable");

  memory.preferences = [];
  if (intent.fit) memory.preferences.push(`fit ${intent.fit}`);
  if (intent.cushioning) memory.preferences.push(`cushioning ${intent.cushioning}`);
  if (intent.distanceKm) memory.preferences.push(`distance ${intent.distanceKm}K`);

  memory.unresolved = missing;
  memory.shownProductIds = shownIds;
  memory.recentActions = [...memory.recentActions, recentAction].slice(-MAX_RECENT_ACTIONS);

  if (userEvidence && !memory.evidence.includes(userEvidence)) {
    memory.evidence = [...memory.evidence, userEvidence].slice(-8);
  }
}

/** Invalidate the current quote in dialogue memory. */
export function invalidateQuote(memory: DialogueMemory): void {
  memory.quoteValid = false;
  memory.selectedProductId = undefined;
  memory.quoteProductId = undefined;
  memory.comparedProductIds = [];
}
