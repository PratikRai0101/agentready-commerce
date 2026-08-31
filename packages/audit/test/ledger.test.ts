import { describe, expect, it } from "vitest";
import { createAuditLedger, MemoryAuditStore } from "../src";

describe("audit ledger", () => {
  it("appends events and returns a chronological timeline", async () => {
    const ledger = createAuditLedger(new MemoryAuditStore());
    const first = await ledger.log({
      logicalOrderId: "ord_1",
      type: "intent.clarification_requested",
      actor: "agent",
      summary: "Ask for size",
      occurredAt: "2026-01-01T10:00:00.000Z",
    });
    const second = await ledger.log({
      logicalOrderId: "ord_1",
      type: "quote.envelope_created",
      actor: "system",
      summary: "Envelope created",
      occurredAt: "2026-01-01T10:01:00.000Z",
    });

    const timeline = await ledger.timeline("ord_1");
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.type).toBe("intent.clarification_requested");
    expect(first.eventId).toMatch(/^evt_/);
    expect(second.occurredAt).toBe("2026-01-01T10:01:00.000Z");
  });

  it("isolates timelines by order", async () => {
    const ledger = createAuditLedger(new MemoryAuditStore());
    await ledger.log({ logicalOrderId: "ord_a", type: "session.created", actor: "system", summary: "a" });
    await ledger.log({ logicalOrderId: "ord_b", type: "session.created", actor: "system", summary: "b" });
    const timeline = await ledger.timeline("ord_a");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.logicalOrderId).toBe("ord_a");
  });
});