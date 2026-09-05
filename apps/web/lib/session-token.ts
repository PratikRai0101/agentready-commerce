import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { AuditEvent } from "@agentready/audit";
import type { PurchaseMandate } from "@agentready/domain";
import type { AppServices, EnvelopeRecord, Session } from "./services";

/**
 * Signed, tamper-evident stateless session snapshot for mock-mode commerce.
 *
 * Vercel serverless functions do not share in-memory state, so a browser
 * session that spans several HTTP requests can land on different instances.
 * Instead of provisioning shared storage, each response carries a snapshot of
 * this order's exact server state, compressed and authenticated with HMAC
 * (server signing secret, never exposed). The next request presents it back;
 * any tampering with prices, recipients, approval or payment state breaks the
 * signature and the snapshot is rejected outright.
 *
 * Nothing sensitive is added by the snapshot: it contains the same order,
 * envelope, mandate and audit data the server already returns piecemeal.
 */
export const SESSION_SNAPSHOT_VERSION = 1;
/** Demo sessions expire a day after issue; envelope/quote expiry still applies. */
export const SESSION_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound the in-memory session maps per instance (insertion-ordered eviction). */
export const MAX_CACHED_SESSIONS = 500;

export type SessionSnapshot = {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  session: Session;
  envelope: EnvelopeRecord | null;
  mandate: PurchaseMandate | null;
  audit: AuditEvent[];
};

export function sealSnapshot(snapshot: SessionSnapshot, secret: string): string {
  const payload = deflateSync(Buffer.from(JSON.stringify(snapshot), "utf8")).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${payload}.${signature}`;
}

export function openSnapshot(token: string, secret: string, nowIso?: string): SessionSnapshot | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) return null;
  let snapshot: SessionSnapshot;
  try {
    snapshot = JSON.parse(inflateSync(Buffer.from(payload, "base64url")).toString("utf8")) as SessionSnapshot;
  } catch {
    return null;
  }
  if (!snapshot || snapshot.version !== SESSION_SNAPSHOT_VERSION) return null;
  if (typeof snapshot.session?.logicalOrderId !== "string") return null;
  if (!Array.isArray(snapshot.audit)) return null;
  if (typeof snapshot.expiresAt !== "string") return null;
  const now = nowIso ?? new Date().toISOString();
  if (snapshot.expiresAt < now) return null;
  return snapshot;
}

/** Read a session token from header (preferred), body, or query string. */
export function readSessionToken(
  request: Request,
  body?: unknown,
  url?: string,
): string | null {
  const header = request.headers.get("x-session-token");
  if (header && header.trim()) return header.trim();
  if (body && typeof body === "object" && body !== null && "sessionToken" in body) {
    const value = (body as { sessionToken?: unknown }).sessionToken;
    if (typeof value === "string" && value) return value;
  }
  if (url) {
    try {
      const value = new URL(url).searchParams.get("st");
      if (value) return value;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Restore this order's sealed snapshot when the local instance never saw it
 * (the normal case when consecutive requests land on different serverless
 * instances). No-op when the session is already cached or no token arrives.
 */
export async function restoreSession(
  services: AppServices,
  orderId: string | undefined | null,
  token: string | null,
): Promise<void> {
  if (!orderId || services.getSession(orderId) || !token) return;
  await services.importSession(token);
}

/** Fresh sealed token for the response envelope (null when the order is unknown). */
export async function tokenFor(
  services: AppServices,
  orderId: string | undefined | null,
): Promise<string | null> {
  if (!orderId) return null;
  return services.exportSession(orderId);
}
