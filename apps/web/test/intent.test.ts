import { describe, expect, it } from "vitest";
import { parseIntentMessage } from "../lib/intent";

describe("parseIntentMessage", () => {
  it("parses the demo opener", () => {
    const parsed = parseIntentMessage("I need black shoes under ₹5,000.");
    expect(parsed.maxAmountMinor).toBe(500_000);
    expect(parsed.colour).toBe("black");
  });

  it("parses Indian-style amounts with commas and spaces", () => {
    expect(parseIntentMessage("under 5,000").maxAmountMinor).toBe(500_000);
    expect(parseIntentMessage("below ₹4,999").maxAmountMinor).toBe(499_900);
    expect(parseIntentMessage("up to 10 000 rupees").maxAmountMinor).toBe(1_000_000);
  });

  it("parses size, use case and distance", () => {
    const parsed = parseIntentMessage("UK 9, road running up to 10K");
    expect(parsed.size).toBe("UK 9");
    expect(parsed.useCase).toBe("road");
    expect(parsed.distanceKm).toBe(10);
    expect(parsed.maxAmountMinor).toBeUndefined();
  });

  it("does not treat distances as an amount", () => {
    const parsed = parseIntentMessage("up to 10 km road runs");
    expect(parsed.maxAmountMinor).toBeUndefined();
    expect(parsed.distanceKm).toBe(10);
  });

  it("parses fit, cushioning and returnability", () => {
    const parsed = parseIntentMessage("Wide fit, cushioning preferred, must be returnable");
    expect(parsed.fit).toBe("wide");
    expect(parsed.cushioning).toBe("max");
    expect(parsed.mustBeReturnable).toBe(true);
  });

  it("parses a weekday delivery deadline", () => {
    const parsed = parseIntentMessage("Delivery before Sunday");
    expect(parsed.deliverBy).toBeDefined();
    expect(new Date(parsed.deliverBy!).getDay()).toBe(0);
  });

  it("leaves unknown text unparsed", () => {
    const parsed = parseIntentMessage("hello there");
    expect(parsed.maxAmountMinor).toBeUndefined();
    expect(parsed.size).toBeUndefined();
  });
});

describe("chip-edit budget correction (bug fix)", () => {
  it("Change Max ₹5,000 to Max ₹3,000 → ₹3,000", () => {
    const parsed = parseIntentMessage("Change Max ₹5,000 to Max ₹3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("Change budget from ₹5,000 to ₹3,000 → ₹3,000", () => {
    const parsed = parseIntentMessage("Change budget from ₹5,000 to ₹3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("Change budget to 3000 → ₹3,000", () => {
    const parsed = parseIntentMessage("Change budget to 3000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("Set max to Rs. 3,000 → ₹3,000", () => {
    const parsed = parseIntentMessage("Set max to Rs. 3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("₹5,000 → ₹3,000 → ₹3,000", () => {
    const parsed = parseIntentMessage("₹5,000 → ₹3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("₹3,000 → ₹3,000 is a no-op (still ₹3,000)", () => {
    const parsed = parseIntentMessage("₹3,000 → ₹3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("budget to Rs.3000 → ₹3,000", () => {
    const parsed = parseIntentMessage("budget to Rs.3000");
    expect(parsed.maxAmountMinor).toBe(300_000);
  });

  it("does not misparse Max ₹5,000 as the target when to-pattern is present", () => {
    const parsed = parseIntentMessage("Change Max ₹5,000 to Max ₹3,000");
    expect(parsed.maxAmountMinor).toBe(300_000);
    expect(parsed.maxAmountMinor).not.toBe(500_000);
  });
});
