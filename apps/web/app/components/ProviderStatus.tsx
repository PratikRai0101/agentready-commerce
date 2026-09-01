"use client";

/**
 * AI-4 provider transparency indicator.
 * Subtle, non-alarming status: AI-assisted or deterministic mode.
 * Never suggests degraded correctness.
 */

type Props = {
  providerStatus: "ai-assisted" | "deterministic" | "unknown";
};

export function ProviderStatus({ providerStatus }: Props) {
  if (providerStatus === "unknown") return null;

  return (
    <div className="provider-status" aria-label={`AI mode: ${providerStatus}`}>
      <span className={`provider-dot ${providerStatus}`} aria-hidden="true" />
      <span className="provider-label">
        {providerStatus === "ai-assisted" ? "AI-assisted" : "Deterministic"}
      </span>
    </div>
  );
}
