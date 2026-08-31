import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CommerceEnvelope } from "./types";

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

export function canonicalize(value: unknown): string {
  return canonicalStringify(value);
}

export function envelopeDigest(envelope: CommerceEnvelope): string {
  return createHash("sha256").update(canonicalize(envelope), "utf8").digest("hex");
}

export function signEnvelope(envelope: CommerceEnvelope, secret: string): string {
  const digest = envelopeDigest(envelope);
  return createHmac("sha256", secret).update(digest, "utf8").digest("hex");
}

export function verifyEnvelopeSignature(
  envelope: CommerceEnvelope,
  secret: string,
  signature: string,
): boolean {
  const expected = signEnvelope(envelope, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomHex(6)}`;
}