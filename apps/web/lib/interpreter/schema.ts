/**
 * AI-1 structured conversational interpreter — versioned schema.
 *
 * The LLM may PROPOSE values; deterministic application code remains
 * authoritative. This module defines the bounded, explicitly allowed fields.
 * Unknown fields are rejected by the validator.
 */

export const INTERPRETER_SCHEMA_VERSION = "ai1.v1" as const;

export const INTERPRETER_ACTIONS = ["search", "refine", "compare", "explain", "select", "restart"] as const;
export type InterpretationAction = (typeof INTERPRETER_ACTIONS)[number];

/** Hard constraint field names the interpreter may propose. */
export const HARD_CONSTRAINT_NAMES = [
  "size",
  "useCase",
  "colour",
  "maxAmountMinor",
  "mustBeReturnable",
  "deliverBy",
] as const;
export type HardConstraintName = (typeof HARD_CONSTRAINT_NAMES)[number];

/** Soft preference field names the interpreter may propose. */
export const SOFT_PREFERENCE_NAMES = ["fit", "cushioning", "distanceKm"] as const;
export type SoftPreferenceName = (typeof SOFT_PREFERENCE_NAMES)[number];

/** Supported, bounded enum values (must match catalog/domain knowledge). */
export const SUPPORTED_SIZES = ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"] as const;
export const SUPPORTED_USE_CASES = ["road", "trail", "gym", "casual"] as const;
export const SUPPORTED_COLOURS = ["black", "white", "grey", "navy", "blue", "red"] as const;
export const SUPPORTED_FITS = ["wide", "narrow", "standard"] as const;
export const SUPPORTED_CUSHIONING = ["max", "balanced", "minimal"] as const;

/** Bounded ranges. */
export const MIN_AMOUNT_MINOR = 10_000; // ₹100
export const MAX_AMOUNT_MINOR = 1_000_000; // ₹10,000 (matches mandate ceiling)
export const MIN_DISTANCE_KM = 1;
export const MAX_DISTANCE_KM = 50;
export const MAX_CONFIDENCE = 1;
export const MIN_CONFIDENCE = 0;

/** Bounded array lengths and string lengths. */
export const MAX_HARD_CONSTRAINTS = 6;
export const MAX_SOFT_PREFERENCES = 3;
export const MAX_CORRECTIONS = 6;
export const MAX_REMOVALS = 6;
export const MAX_AMBIGUITIES = 5;
export const MAX_PRODUCT_IDS = 5;
export const MAX_STRING_LENGTH = 80;
export const MAX_EVIDENCE_LENGTH = 120;

export type HardConstraintValue = string | number | boolean;

export type ProposedHardConstraint = {
  name: HardConstraintName;
  value: HardConstraintValue;
  /** Verbatim substring of the original user message that supports this change. */
  evidence: string;
};

export type ProposedSoftPreference = {
  name: SoftPreferenceName;
  value: string | number;
  evidence: string;
};

export type StructuredInterpretation = {
  schemaVersion: typeof INTERPRETER_SCHEMA_VERSION;
  action: InterpretationAction;
  proposedHardConstraints: ProposedHardConstraint[];
  proposedSoftPreferences: ProposedSoftPreference[];
  /** Intent field names that are being corrected in this message. */
  corrections: string[];
  /** Intent field names that must be removed. */
  removals: string[];
  /** Human-readable descriptions of unresolved ambiguities. */
  ambiguities: string[];
  /** 0..1 — how confident the interpreter is. */
  confidence: number;
  /** Valid catalog product IDs explicitly requested (compare/select). */
  requestedProductIds: string[];
};

/** Allowed top-level keys. Any other key makes the proposal invalid. */
export const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "action",
  "proposedHardConstraints",
  "proposedSoftPreferences",
  "corrections",
  "removals",
  "ambiguities",
  "confidence",
  "requestedProductIds",
]);

export const ALLOWED_HARD_CONSTRAINT_KEYS: ReadonlySet<string> = new Set(["name", "value", "evidence"]);
export const ALLOWED_SOFT_PREFERENCE_KEYS: ReadonlySet<string> = new Set(["name", "value", "evidence"]);
