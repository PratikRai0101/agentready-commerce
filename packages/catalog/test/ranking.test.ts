import { describe, expect, it } from "vitest";
import { SHOE_CATALOG, rankProducts, missingHardConstraints } from "../src";
import type { PurchaseIntent } from "@agentready/domain";

const baseIntent = (overrides: Partial<PurchaseIntent["hardConstraints"]> = {}): PurchaseIntent => ({
  merchantId: "merchant_runvista",
  category: "running_shoes",
  hardConstraints: {
    maxAmountMinor: 500_000,
    currency: "INR",
    ...overrides,
  },
  softPreferences: [],
});

describe("missingHardConstraints", () => {
  it("requires size and use case", () => {
    const missing = missingHardConstraints(baseIntent());
    const names = missing.map((m) => m.name);
    expect(names).toContain("size");
    expect(names).toContain("useCase");
  });

  it("reports none when size and use case are present", () => {
    const missing = missingHardConstraints(
      baseIntent({ size: "UK 9", useCase: "road" }),
    );
    expect(missing).toEqual([]);
  });
});

describe("rankProducts", () => {
  it("refuses to rank when hard constraints are missing", () => {
    const result = rankProducts(baseIntent(), SHOE_CATALOG);
    expect(result.ranked).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("ranks the demo scenario deterministically", () => {
    const intent = baseIntent({
      size: "UK 9",
      colour: "black",
      useCase: "road",
      mustBeReturnable: true,
    });
    intent.softPreferences = [
      { name: "distance", value: "10", weight: 1 },
      { name: "fit", value: "wide", weight: 1 },
      { name: "cushioning", value: "max", weight: 1 },
    ];
    const result = rankProducts(intent, SHOE_CATALOG);
    expect(result.ranked).toBe(true);
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]!.product.productId).toBe("p_vista_max");
    expect(result.matches[0]!.score).toBeGreaterThan(result.matches[1]!.score);
  });

  it("never surfaces an out-of-stock or unavailable size", () => {
    const intent = baseIntent({ size: "UK 10", useCase: "road" });
    const result = rankProducts(intent, SHOE_CATALOG);
    for (const match of result.matches) {
      expect(match.eligibility.sizeAvailable).toBe(true);
      expect(match.eligibility.inStock).toBe(true);
    }
  });

  it("excludes products above budget", () => {
    const intent = baseIntent({ size: "UK 9", useCase: "road", maxAmountMinor: 350_000 });
    const result = rankProducts(intent, SHOE_CATALOG);
    for (const match of result.matches) {
      expect(match.product.priceMinor).toBeLessThanOrEqual(350_000);
    }
  });

  it("scores identically across repeated calls", () => {
    const intent = baseIntent({ size: "UK 9", useCase: "road" });
    const first = rankProducts(intent, SHOE_CATALOG);
    const second = rankProducts(intent, SHOE_CATALOG);
    expect(first.matches.map((m) => m.product.productId)).toEqual(second.matches.map((m) => m.product.productId));
    expect(first.matches.map((m) => m.score)).toEqual(second.matches.map((m) => m.score));
  });
});