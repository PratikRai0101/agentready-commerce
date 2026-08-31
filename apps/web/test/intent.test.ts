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