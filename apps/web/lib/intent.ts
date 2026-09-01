import { canonicalize } from "@agentready/domain";

export type ParsedIntent = {
  size?: string;
  colour?: string;
  useCase?: string;
  maxAmountMinor?: number;
  mustBeReturnable?: boolean;
  deliverBy?: string;
  distanceKm?: number;
  fit?: string;
  cushioning?: string;
};

const USE_CASES = ["road", "trail", "gym", "casual"] as const;
export const SIZES = ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"];
const COLOURS = ["black", "white", "grey", "navy", "blue", "red"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** True when `token` appears negated ("not black", "don't want gym", "no navy", ...). */
export function isNegated(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:not|no|never|don'?t\\s+(?:want|like|need)|do\\s+not\\s+(?:want|like|need))\\s+(?:a|the|any)?\\s*${escaped}\\b`, "i").test(text);
}

export function parseIntentMessage(message: string): ParsedIntent {
  const text = message.toLowerCase().replace(/[,.]/g, " ");
  const parsed: ParsedIntent = {};

  const distanceMatch = text.match(/(\d{1,3})\s*k\s*m?\b/);
  if (distanceMatch) {
    parsed.distanceKm = Number(distanceMatch[1]);
  }
  const textWithoutDistance = text.replace(/\d{1,3}\s*k\s*m?\b/g, " DIST ");

  // Extract all amounts from the message.
  // Matches: ₹/rs-prefixed amounts, comma/space-separated (3,000 / 3 000), or 4+ bare digits.
  // Excludes single-digit numbers like "UK 9" or "10K".
  const amountRe = /(?:₹|rs\.?)\s*([\d][\d\s,]+)|([\d]{1,3}(?:[\s,]\d{3})+)|([\d]{4,})/g;
  const allAmounts = [...textWithoutDistance.matchAll(amountRe)]
    .map((m) => {
      const raw = m[1] || m[2] || m[3] || "";
      const digits = raw.replace(/[^\d]/g, "");
      return digits ? Math.round(Number(digits) * 100) : null;
    })
    .filter((n): n is number => n !== null);

  // Correction patterns: when "to" or arrow is present with multiple amounts,
  // the destination/right-hand value is the last amount. This correctly handles
  // "Change Max ₹5,000 to Max ₹3,000" where "max ₹" sits between "to" and "3000".
  const hasCorrectionKeyword = /(?:\bto\b|→|->|=>)/.test(textWithoutDistance);
  if (hasCorrectionKeyword && allAmounts.length >= 2) {
    parsed.maxAmountMinor = allAmounts[allAmounts.length - 1]!;
  }

  // Single-amount correction: "Change budget to 3000", "Set max to Rs. 3,000"
  if (parsed.maxAmountMinor === undefined && allAmounts.length === 1 && hasCorrectionKeyword) {
    parsed.maxAmountMinor = allAmounts[0]!;
  }

  // Generic "under/below/max" pattern: only when no correction pattern matched.
  if (parsed.maxAmountMinor === undefined) {
    const amountMatch = textWithoutDistance.match(/(?:under|below|less than|max|at most|upto|up to)\s*(?:₹|rs\.?|inr|rupees?)?\s*([\d][\d\s,]*)/);
    if (amountMatch) {
      parsed.maxAmountMinor = parseIndianAmount(amountMatch[1]!);
    }
  }

  for (const size of SIZES) {
    const normalized = size.toLowerCase();
    if (text.includes(normalized) || new RegExp(`\\b${size.replace(" ", "\\s*")}\\b`, "i").test(text)) {
      parsed.size = size;
      break;
    }
  }
  const sizeDigits = text.match(/\bsize\s*(\d{1,2})\b/);
  if (!parsed.size && sizeDigits) {
    const num = Number(sizeDigits[1]);
    if (num >= 6 && num <= 11) parsed.size = `UK ${num}`;
  }

  const useCase = USE_CASES.find((use) => {
    if (isNegated(text, use)) return false;
    if (use === "road" && isNegated(text, "running")) return false;
    return text.includes(use) || (use === "road" && text.includes("running"));
  });
  if (useCase) parsed.useCase = useCase;

  const colour = COLOURS.find((colour) => !isNegated(text, colour) && new RegExp(`\\b${colour}\\b`).test(text));
  if (colour) parsed.colour = colour;

  if (/\breturn\w*\b/.test(text)) parsed.mustBeReturnable = true;

  for (const [index, day] of DAYS.entries()) {
    if (text.includes(day)) {
      parsed.deliverBy = nextWeekday(index, 1);
      break;
    }
  }
  if (!parsed.deliverBy && /\btomorrow\b/.test(text)) {
    parsed.deliverBy = nextWeekday(new Date().getDay(), 1);
  }

  if (text.includes("wide")) parsed.fit = "wide";
  else if (text.includes("narrow")) parsed.fit = "narrow";
  else if (text.includes("standard")) parsed.fit = "standard";

  if (text.includes("max cushioning") || text.includes("cushioning preferred")) parsed.cushioning = "max";
  else if (text.includes("minimal") || text.includes("light cushioning")) parsed.cushioning = "minimal";
  else if (text.includes("balanced")) parsed.cushioning = "balanced";

  return parsed;
}

function parseIndianAmount(raw: string): number {
  const digits = raw.replace(/[^\d]/g, "");
  return Math.round(Number(digits) * 100);
}

function nextWeekday(targetDay: number, hour: number): string {
  const now = new Date();
  const today = now.getDay();
  let delta = (targetDay - today + 7) % 7;
  if (delta === 0) delta = 7;
  const date = new Date(now);
  date.setDate(date.getDate() + delta);
  date.setHours(hour, 59, 59, 999);
  return date.toISOString();
}

export function mergeIntents(current: ParsedIntent, incoming: ParsedIntent): ParsedIntent {
  return { ...current, ...incoming };
}

export function intentDigest(intent: ParsedIntent): string {
  return canonicalize(intent);
}
