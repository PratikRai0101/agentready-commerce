/**
 * AI-1 deterministic validator.
 *
 * Accepts, rejects or normalizes each LLM proposal BEFORE it enters session
 * intent. Rejected proposals are surfaced as auditable reasons only — never
 * chain-of-thought or prompt content.
 */
import {
  ALLOWED_HARD_CONSTRAINT_KEYS,
  ALLOWED_SOFT_PREFERENCE_KEYS,
  ALLOWED_TOP_LEVEL_KEYS,
  HARD_CONSTRAINT_NAMES,
  INTERPRETER_ACTIONS,
  INTERPRETER_SCHEMA_VERSION,
  MAX_AMBIGUITIES,
  MAX_CORRECTIONS,
  MAX_EVIDENCE_LENGTH,
  MAX_HARD_CONSTRAINTS,
  MAX_PRODUCT_IDS,
  MAX_REMOVALS,
  MAX_SOFT_PREFERENCES,
  MAX_STRING_LENGTH,
  MIN_AMOUNT_MINOR,
  MAX_AMOUNT_MINOR,
  MAX_CONFIDENCE,
  MAX_DISTANCE_KM,
  MIN_CONFIDENCE,
  MIN_DISTANCE_KM,
  SOFT_PREFERENCE_NAMES,
  SUPPORTED_COLOURS,
  SUPPORTED_CUSHIONING,
  SUPPORTED_FITS,
  SUPPORTED_SIZES,
  SUPPORTED_USE_CASES,
  type HardConstraintName,
  type ProposedHardConstraint,
  type ProposedSoftPreference,
  type SoftPreferenceName,
  type StructuredInterpretation,
} from "./schema";

export type ValidationIssue = { field: string; reason: string };

export type ValidationResult = {
  valid: boolean;
  interpretation: StructuredInterpretation | null;
  issues: ValidationIssue[];
};

export type CatalogIds = { productIds: string[] };

/** Strict shape + value validation of raw (untrusted) LLM output. */
export function validateInterpretation(
  raw: unknown,
  ctx: { message: string; catalog: CatalogIds },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, interpretation: null, issues: [{ field: "root", reason: "not_an_object" }] };
  }
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { valid: false, interpretation: null, issues: [{ field: key, reason: "unknown_field" }] };
    }
  }

  if (record.schemaVersion !== INTERPRETER_SCHEMA_VERSION) {
    issues.push({ field: "schemaVersion", reason: "unsupported_schema_version" });
  }
  const action = record.action;
  if (typeof action !== "string" || !(INTERPRETER_ACTIONS as readonly string[]).includes(action)) {
    issues.push({ field: "action", reason: "invalid_action_enum" });
  }

  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > MAX_CONFIDENCE) {
    issues.push({ field: "confidence", reason: "confidence_out_of_bounds" });
  }

  const proposedHardConstraints = validateArray(record.proposedHardConstraints, MAX_HARD_CONSTRAINTS, "proposedHardConstraints", issues);
  const proposedSoftPreferences = validateArray(record.proposedSoftPreferences, MAX_SOFT_PREFERENCES, "proposedSoftPreferences", issues);
  const corrections = validateStringArray(record.corrections, MAX_CORRECTIONS, "corrections", issues);
  const removals = validateStringArray(record.removals, MAX_REMOVALS, "removals", issues);
  const ambiguities = validateStringArray(record.ambiguities, MAX_AMBIGUITIES, "ambiguities", issues);
  const requestedProductIds = validateStringArray(record.requestedProductIds, MAX_PRODUCT_IDS, "requestedProductIds", issues);

  if (issues.length > 0) {
    return { valid: false, interpretation: null, issues };
  }

  const hard = validateHardConstraints(proposedHardConstraints, ctx.message, ctx.catalog.productIds, issues);
  const soft = validateSoftPreferences(proposedSoftPreferences, ctx.message, issues);

  // Product IDs must exist in the catalog.
  for (const id of requestedProductIds) {
    if (!ctx.catalog.productIds.includes(id)) {
      issues.push({ field: `requestedProductIds.${id}`, reason: "unknown_product_id" });
    }
  }

  if (issues.length > 0) {
    return { valid: false, interpretation: null, issues };
  }

  return {
    valid: true,
    interpretation: {
      schemaVersion: INTERPRETER_SCHEMA_VERSION,
      action: action as StructuredInterpretation["action"],
      proposedHardConstraints: hard,
      proposedSoftPreferences: soft,
      corrections,
      removals,
      ambiguities,
      confidence: confidence as number,
      requestedProductIds,
    },
    issues,
  };
}

function validateArray(value: unknown, max: number, field: string, issues: ValidationIssue[]): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ field, reason: "not_an_array" });
    return [];
  }
  if (value.length > max) {
    issues.push({ field, reason: `array_too_large_${max}` });
  }
  return value.slice(0, max);
}

function validateStringArray(value: unknown, max: number, field: string, issues: ValidationIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ field, reason: "not_an_array" });
    return [];
  }
  if (value.length > max) {
    issues.push({ field, reason: `array_too_large_${max}` });
  }
  const out: string[] = [];
  for (const item of value.slice(0, max)) {
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ field, reason: "non_string_element" });
      continue;
    }
    if (item.length > MAX_STRING_LENGTH) {
      issues.push({ field: `${field}.${item.slice(0, 16)}`, reason: "string_too_long" });
      continue;
    }
    out.push(item);
  }
  return out;
}

function validateHardConstraints(
  proposed: Record<string, unknown>[],
  message: string,
  catalogProductIds: string[],
  issues: ValidationIssue[],
): ProposedHardConstraint[] {
  const out: ProposedHardConstraint[] = [];
  for (const item of proposed) {
    for (const key of Object.keys(item)) {
      if (!ALLOWED_HARD_CONSTRAINT_KEYS.has(key)) {
        issues.push({ field: `proposedHardConstraints.${key}`, reason: "unknown_field" });
        return out;
      }
    }
    const name = item.name;
    if (typeof name !== "string" || !(HARD_CONSTRAINT_NAMES as readonly string[]).includes(name)) {
      issues.push({ field: "proposedHardConstraints.name", reason: "invalid_constraint_name" });
      continue;
    }
    const value = item.value;
    const normalized = normalizeHardValue(name as HardConstraintName, value, catalogProductIds);
    if (normalized === undefined) {
      issues.push({ field: `proposedHardConstraints.${String(name)}`, reason: `invalid_value_for_${String(name)}` });
      continue;
    }
    const evidence = item.evidence;
    if (typeof evidence !== "string" || evidence.length === 0) {
      issues.push({ field: `proposedHardConstraints.${String(name)}.evidence`, reason: "missing_evidence" });
      continue;
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      issues.push({ field: `proposedHardConstraints.${String(name)}.evidence`, reason: "evidence_too_long" });
      continue;
    }
    if (!message.includes(evidence)) {
      issues.push({ field: `proposedHardConstraints.${String(name)}.evidence`, reason: "evidence_not_in_message" });
      continue;
    }
    out.push({ name: name as HardConstraintName, value: normalized, evidence });
  }
  return out;
}

function validateSoftPreferences(
  proposed: Record<string, unknown>[],
  message: string,
  issues: ValidationIssue[],
): ProposedSoftPreference[] {
  const out: ProposedSoftPreference[] = [];
  for (const item of proposed) {
    for (const key of Object.keys(item)) {
      if (!ALLOWED_SOFT_PREFERENCE_KEYS.has(key)) {
        issues.push({ field: `proposedSoftPreferences.${key}`, reason: "unknown_field" });
        return out;
      }
    }
    const name = item.name;
    if (typeof name !== "string" || !(SOFT_PREFERENCE_NAMES as readonly string[]).includes(name)) {
      issues.push({ field: "proposedSoftPreferences.name", reason: "invalid_preference_name" });
      continue;
    }
    const value = item.value;
    const normalized = normalizeSoftValue(name as SoftPreferenceName, value);
    if (normalized === undefined) {
      issues.push({ field: `proposedSoftPreferences.${String(name)}`, reason: `invalid_value_for_${String(name)}` });
      continue;
    }
    const evidence = item.evidence;
    if (typeof evidence !== "string" || evidence.length === 0) {
      issues.push({ field: `proposedSoftPreferences.${String(name)}.evidence`, reason: "missing_evidence" });
      continue;
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      issues.push({ field: `proposedSoftPreferences.${String(name)}.evidence`, reason: "evidence_too_long" });
      continue;
    }
    if (!message.includes(evidence)) {
      issues.push({ field: `proposedSoftPreferences.${String(name)}.evidence`, reason: "evidence_not_in_message" });
      continue;
    }
    out.push({ name: name as SoftPreferenceName, value: normalized, evidence });
  }
  return out;
}

/** Returns a normalized value or undefined when the proposal must be rejected. */
export function normalizeHardValue(
  name: HardConstraintName,
  value: unknown,
  catalogProductIds: string[],
): string | number | boolean | undefined {
  switch (name) {
    case "size":
      if (typeof value === "string" && (SUPPORTED_SIZES as readonly string[]).includes(value)) return value;
      // tolerate "UK10"/"10" normalizations
      if (typeof value === "number" && value >= 6 && value <= 11) return `UK ${value}`;
      if (typeof value === "string") {
        const num = Number(value.replace(/[^\d]/g, ""));
        if (num >= 6 && num <= 11) return `UK ${num}`;
      }
      return undefined;
    case "useCase":
      return typeof value === "string" && (SUPPORTED_USE_CASES as readonly string[]).includes(value) ? value : undefined;
    case "colour":
      return typeof value === "string" && (SUPPORTED_COLOURS as readonly string[]).includes(value) ? value : undefined;
    case "maxAmountMinor":
      if (typeof value === "number" && Number.isFinite(value)) {
        if (value < MIN_AMOUNT_MINOR || value > MAX_AMOUNT_MINOR) return undefined;
        return Math.round(value);
      }
      if (typeof value === "string" && /^\d+$/.test(value)) {
        const n = Number(value);
        if (n < MIN_AMOUNT_MINOR || n > MAX_AMOUNT_MINOR) return undefined;
        return n;
      }
      return undefined;
    case "mustBeReturnable":
      return typeof value === "boolean" ? value : undefined;
    case "deliverBy":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
    default:
      return undefined;
  }
}

export function normalizeSoftValue(
  name: SoftPreferenceName,
  value: unknown,
): string | number | undefined {
  switch (name) {
    case "fit":
      return typeof value === "string" && (SUPPORTED_FITS as readonly string[]).includes(value) ? value : undefined;
    case "cushioning":
      return typeof value === "string" && (SUPPORTED_CUSHIONING as readonly string[]).includes(value) ? value : undefined;
    case "distanceKm":
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.min(MAX_DISTANCE_KM, Math.max(MIN_DISTANCE_KM, Math.round(value)));
      }
      if (typeof value === "string" && /^\d+$/.test(value)) {
        const n = Number(value);
        return Math.min(MAX_DISTANCE_KM, Math.max(MIN_DISTANCE_KM, Math.round(n)));
      }
      return undefined;
    default:
      return undefined;
  }
}
