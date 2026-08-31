export type ShoeUseCase = "road" | "trail" | "gym" | "casual";

export type ShoeFit = "narrow" | "standard" | "wide";
export type ShoeCushioning = "minimal" | "balanced" | "max";

export type CatalogVariant = {
  sku: string;
  size: string;
  inStock: number;
};

export type CatalogProduct = {
  productId: string;
  name: string;
  brand: string;
  category: "running_shoes";
  useCase: ShoeUseCase;
  fit: ShoeFit;
  cushioning: ShoeCushioning;
  colour: string[];
  priceMinor: number;
  currency: "INR";
  typicalDistanceKm: number;
  returnable: boolean;
  deliveryLeadDays: number;
  rating: number;
  description: string;
  variants: CatalogVariant[];
};

export type InventoryHold = {
  inventoryHoldId: string;
  sku: string;
  quantity: number;
  expiresAt: string;
};

export type ReturnPolicy = {
  policyId: string;
  returnable: boolean;
  windowDays: number;
  condition: string;
};

export type ShippingEstimate = {
  leadDays: number;
  deliverBy: string;
  feeMinor: number;
};

export type Catalog = {
  merchantId: string;
  merchantName: string;
  products: CatalogProduct[];
  returnPolicy: ReturnPolicy;
};

export const SHOE_CATALOG: Catalog = {
  merchantId: "merchant_runvista",
  merchantName: "RunVista Sports",
  returnPolicy: {
    policyId: "rp_runvista_std",
    returnable: true,
    windowDays: 14,
    condition: "Unworn, in original box",
  },
  products: [
    {
      productId: "p_streak_4",
      name: "RunVista Streak 4",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "road",
      fit: "standard",
      cushioning: "balanced",
      colour: ["black"],
      priceMinor: 429900,
      currency: "INR",
      typicalDistanceKm: 10,
      returnable: true,
      deliveryLeadDays: 3,
      rating: 4.6,
      description: "Balanced daily road trainer for 5–15K runs.",
      variants: [
        { sku: "STRK4-BLK-9", size: "UK 9", inStock: 6 },
        { sku: "STRK4-BLK-10", size: "UK 10", inStock: 2 },
      ],
    },
    {
      productId: "p_vista_max",
      name: "RunVista Max Cushion",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "road",
      fit: "wide",
      cushioning: "max",
      colour: ["black", "grey"],
      priceMinor: 489900,
      currency: "INR",
      typicalDistanceKm: 12,
      returnable: true,
      deliveryLeadDays: 3,
      rating: 4.7,
      description: "Maximum cushioning, wide fit, for recovery and long easy runs.",
      variants: [
        { sku: "VMAX-BLK-9", size: "UK 9", inStock: 4 },
        { sku: "VMAX-BLK-10", size: "UK 10", inStock: 0 },
      ],
    },
    {
      productId: "p_stride_lite",
      name: "RunVista Stride Lite",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "road",
      fit: "narrow",
      cushioning: "minimal",
      colour: ["black", "navy"],
      priceMinor: 349900,
      currency: "INR",
      typicalDistanceKm: 8,
      returnable: true,
      deliveryLeadDays: 5,
      rating: 4.3,
      description: "Lightweight minimal trainer for speedwork and tempo.",
      variants: [
        { sku: "STRL-BLK-9", size: "UK 9", inStock: 9 },
        { sku: "STRL-BLK-10", size: "UK 10", inStock: 5 },
      ],
    },
    {
      productId: "p_trail_rock",
      name: "RunVista Trail Rock",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "trail",
      fit: "standard",
      cushioning: "balanced",
      colour: ["black"],
      priceMinor: 459900,
      currency: "INR",
      typicalDistanceKm: 10,
      returnable: true,
      deliveryLeadDays: 4,
      rating: 4.5,
      description: "Grippy trail shoe for mixed terrain and trail runs.",
      variants: [
        { sku: "TRLK-BLK-9", size: "UK 9", inStock: 3 },
        { sku: "TRLK-BLK-10", size: "UK 10", inStock: 7 },
      ],
    },
    {
      productId: "p_gym_pace",
      name: "RunVista Gym Pace",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "gym",
      fit: "standard",
      cushioning: "balanced",
      colour: ["black"],
      priceMinor: 379900,
      currency: "INR",
      typicalDistanceKm: 5,
      returnable: true,
      deliveryLeadDays: 3,
      rating: 4.4,
      description: "Hybrid training shoe for gym and short treadmill runs.",
      variants: [
        { sku: "GYMP-BLK-9", size: "UK 9", inStock: 5 },
        { sku: "GYMP-BLK-10", size: "UK 10", inStock: 8 },
      ],
    },
    {
      productId: "p_casual_day",
      name: "RunVista Everyday",
      brand: "RunVista",
      category: "running_shoes",
      useCase: "casual",
      fit: "wide",
      cushioning: "balanced",
      colour: ["black", "white"],
      priceMinor: 299900,
      currency: "INR",
      typicalDistanceKm: 3,
      returnable: true,
      deliveryLeadDays: 2,
      rating: 4.2,
      description: "Comfortable everyday sneaker for walking and casual wear.",
      variants: [
        { sku: "CASE-BLK-9", size: "UK 9", inStock: 10 },
        { sku: "CASE-BLK-10", size: "UK 10", inStock: 4 },
      ],
    },
  ],
};

export function formatMinor(amountMinor: number, currency = "INR"): string {
  if (currency === "USDC") {
    return `$${(amountMinor / 1_000_000).toFixed(6)}`;
  }
  return `₹${(amountMinor / 100).toFixed(2)}`;
}

export function inrToMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function estimateShipping(leadDays: number, fromIso?: string): ShippingEstimate {
  const from = fromIso ? new Date(fromIso) : new Date();
  const deliverBy = new Date(from);
  deliverBy.setDate(deliverBy.getDate() + leadDays);
  return {
    leadDays,
    deliverBy: deliverBy.toISOString(),
    feeMinor: 4900,
  };
}