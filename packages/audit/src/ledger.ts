import { newId } from "@agentready/domain";

export type AuditActor = "customer" | "agent" | "merchant" | "policy" | "payment" | "system";

export type AuditDecision = "allow" | "block" | "review";

export type AuditEvent = {
  eventId: string;
  logicalOrderId: string;
  type: string;
  actor: AuditActor;
  occurredAt: string;
  summary: string;
  inputDigest?: string;
  outputDigest?: string;
  externalReferences?: Record<string, string>;
  decision?: AuditDecision;
  reasonCodes?: string[];
};

export type AuditStore = {
  append(event: AuditEvent): Promise<void>;
  list(logicalOrderId: string): Promise<AuditEvent[]>;
  /** Optional membership probe used when rehydrating stateless snapshots. */
  has?(eventId: string): Promise<boolean>;
};

export class MemoryAuditStore implements AuditStore {
  private events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async has(eventId: string): Promise<boolean> {
    return this.events.some((event) => event.eventId === eventId);
  }

  async list(logicalOrderId: string): Promise<AuditEvent[]> {
    return this.events
      .filter((event) => event.logicalOrderId === logicalOrderId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async all(): Promise<AuditEvent[]> {
    return [...this.events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

export type AuditLedger = {
  log(input: Omit<AuditEvent, "eventId" | "occurredAt"> & { occurredAt?: string }): Promise<AuditEvent>;
  timeline(logicalOrderId: string): Promise<AuditEvent[]>;
};

export function createAuditLedger(store: AuditStore): AuditLedger {
  return {
    async log(input) {
      const event: AuditEvent = {
        ...input,
        eventId: newId("evt"),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
      };
      await store.append(event);
      return event;
    },
    timeline(logicalOrderId) {
      return store.list(logicalOrderId);
    },
  };
}