import { describe, expect, it } from "vitest";
import {
  checkRunNonce,
  parseListenPids,
  isOwnedByRoot,
  isBindConflict,
  checkIndicators,
  checkUsageZeroed,
  withinMessageCap,
} from "./runner-guards.mjs";

describe("stale-server rejection via run nonce", () => {
  it("accepts the exact launched nonce", () => {
    expect(checkRunNonce({ runNonce: "abc123xy" }, "abc123xy").ok).toBe(true);
  });

  it("rejects a mismatched nonce (stale occupant)", () => {
    const result = checkRunNonce({ runNonce: "older-nonce-1" }, "fresh-nonce-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/);
  });

  it("rejects a missing nonce (server predates the guard)", () => {
    expect(checkRunNonce({}, "fresh-nonce-2").ok).toBe(false);
    expect(checkRunNonce({ runNonce: null }, "fresh-nonce-2").ok).toBe(false);
  });

  it("rejects an unusable launcher nonce", () => {
    expect(checkRunNonce({ runNonce: "abc123xy" }, "").ok).toBe(false);
    expect(checkRunNonce({ runNonce: "abc123xy" }, "short").ok).toBe(false);
  });
});

describe("bind-conflict rejection", () => {
  it("detects EADDRINUSE variants", () => {
    expect(isBindConflict("Error: listen EADDRINUSE: address already in use :::3101")).toBe(true);
    expect(isBindConflict("Port 3101 is already in use")).toBe(true);
    expect(isBindConflict("ready in 900ms")).toBe(false);
    expect(isBindConflict("")).toBe(false);
  });

  it("parses lsof listener PIDs", () => {
    expect(parseListenPids("7216\n85115\n")).toEqual([7216, 85115]);
    expect(parseListenPids("")).toEqual([]);
    expect(parseListenPids("abc\n-4\n0\n42\n")).toEqual([42]);
  });

  it("rejects a foreign listener with no chain to the launched root", () => {
    const getPpid = (pid: number) => (pid === 7216 ? 7210 : pid === 7210 ? 1 : null);
    expect(isOwnedByRoot([7216], getPpid, 9999)).toBe(false);
  });

  it("accepts a grandchild listener tracing to the launched root", () => {
    const getPpid = (pid: number) => (pid === 7216 ? 7210 : pid === 7210 ? 7199 : null);
    expect(isOwnedByRoot([7216], getPpid, 7199)).toBe(true);
  });

  it("accepts a direct listener and rejects an empty set", () => {
    expect(isOwnedByRoot([7199], () => null, 7199)).toBe(true);
    expect(isOwnedByRoot([], () => null, 7199)).toBe(false);
  });
});

describe("indicator and usage guards", () => {
  const mockStatus = { indicators: { razorpay: "mock", x402: "mock", llm: "openai-compatible" } };

  it("requires both rails mocked and LLM enabled", () => {
    expect(checkIndicators(mockStatus).ok).toBe(true);
    expect(checkIndicators({ indicators: { ...mockStatus.indicators, razorpay: "test" } }).ok).toBe(false);
    expect(checkIndicators({ indicators: { ...mockStatus.indicators, x402: "devnet" } }).ok).toBe(false);
    expect(checkIndicators({ indicators: { ...mockStatus.indicators, llm: "disabled" } }).ok).toBe(false);
    expect(checkIndicators({}).ok).toBe(false);
  });

  it("requires zeroed usage before the session", () => {
    expect(checkUsageZeroed({ calls: 0, promptTokens: 0, completionTokens: 0 }).ok).toBe(true);
    expect(checkUsageZeroed({ calls: 1, promptTokens: 0, completionTokens: 0 }).ok).toBe(false);
    expect(checkUsageZeroed(undefined).ok).toBe(false);
  });

  it("enforces the message cap boundary", () => {
    expect(withinMessageCap(15, 15)).toBe(true);
    expect(withinMessageCap(16, 15)).toBe(false);
  });
});
