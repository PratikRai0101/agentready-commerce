import { MockRazorpayAdapter } from "./mock-razorpay";
import { RazorpayAdapter } from "./razorpay";
import type { PaymentAdapter, PaymentRail } from "./types";

export type AdapterConfig = {
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  forceMock?: boolean;
};

export type AdapterRegistry = {
  get(rail: PaymentRail): PaymentAdapter | undefined;
  all(): PaymentAdapter[];
  isMock(rail: PaymentRail): boolean;
};

export function createAdapterRegistry(config: AdapterConfig): AdapterRegistry {
  const useReal = Boolean(
    !config.forceMock && config.razorpayKeyId && config.razorpayKeySecret,
  );

  const razorpay = useReal
    ? new RazorpayAdapter({
        keyId: config.razorpayKeyId!,
        keySecret: config.razorpayKeySecret!,
        webhookSecret: config.razorpayWebhookSecret,
      })
    : new MockRazorpayAdapter({
        keyId: config.razorpayKeyId ?? "rzp_test_mock",
        keySecret: config.razorpayKeySecret ?? "mock_secret",
      });

  const adapters: PaymentAdapter[] = [razorpay];

  return {
    get(rail) {
      return adapters.find((adapter) => adapter.rail === rail);
    },
    all() {
      return adapters;
    },
    isMock(rail) {
      return adapters.find((adapter) => adapter.rail === rail)?.isMock ?? true;
    },
  };
}