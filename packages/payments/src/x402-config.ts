import { readFileSync } from "node:fs";

export type X402Mode = "mock" | "devnet";

export type X402DevnetConfig = {
  mode: "devnet";
  facilitatorUrl: string;
  solanaRpcUrl?: string;
  payerSecretKey: Uint8Array;
  payerPublicKey: string;
  payeePublicKey: string;
  devnetUsdcMint: string;
  amountMinor: number;
};

export type X402MockConfig = {
  mode: "mock";
  payeeWallet: string;
  agentWallet: string;
  usdcMint: string;
  amountMinor: number;
};

export type X402Config = X402DevnetConfig | X402MockConfig;

const VALID_MODES: readonly X402Mode[] = ["mock", "devnet"];

const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const DEFAULT_AMOUNT_MINOR = 10_000; // 0.01 USDC

function derivePublicKeyBase58(secretKeyBytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { base58 } = require("@scure/base") as { base58: { encode(bytes: Uint8Array): string } };
  if (secretKeyBytes.length === 64) {
    return base58.encode(secretKeyBytes.subarray(32));
  }
  if (secretKeyBytes.length === 32) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ed25519 } = require("@noble/curves/ed25519.js") as {
      ed25519: { getPublicKey(key: Uint8Array, isPrivate?: boolean): Uint8Array };
    };
    const pubkey = ed25519.getPublicKey(secretKeyBytes, true);
    return base58.encode(pubkey);
  }
  throw new Error(`Invalid Solana secret key length: ${secretKeyBytes.length}. Expected 32 or 64 bytes.`);
}

function loadKeypairBytes(path: string): Uint8Array {
  const raw = readFileSync(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  if (!Array.isArray(arr) || (arr.length !== 32 && arr.length !== 64)) {
    throw new Error(
      `Keypair file ${path} must contain a JSON array of 32 or 64 numbers. Got ${arr.length} elements.`,
    );
  }
  return Uint8Array.from(arr);
}

function parseAmountMinor(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`X402_AMOUNT_MINOR must be a positive integer. Got: "${value}"`);
  }
  return n;
}

export function loadX402Config(env: Record<string, string | undefined> = process.env): X402Config {
  const rawMode = (env.X402_MODE ?? "mock").trim().toLowerCase();
  if (!VALID_MODES.includes(rawMode as X402Mode)) {
    throw new Error(
      `X402_MODE must be one of: ${VALID_MODES.join(", ")}. Received: "${env.X402_MODE}". ` +
      `Do not silently fall back to mock — fix the configuration.`,
    );
  }
  const mode = rawMode as X402Mode;

  if (mode === "devnet") {
    const payerKeyPairPath = env.X402_PAYER_KEYPAIR_PATH;
    if (!payerKeyPairPath) {
      throw new Error("X402_PAYER_KEYPAIR_PATH is required when X402_MODE=devnet");
    }

    const payeePublicKey = env.X402_PAYEE_PUBLIC_KEY;
    if (!payeePublicKey || payeePublicKey === "PLACEHOLDER_PAYEE_PUBLIC_KEY") {
      throw new Error("X402_PAYEE_PUBLIC_KEY is required when X402_MODE=devnet");
    }

    let payerSecretKey: Uint8Array;
    try {
      payerSecretKey = loadKeypairBytes(payerKeyPairPath);
    } catch {
      throw new Error(
        "Failed to load payer keypair. Verify the keypair file exists, contains a valid JSON array of 32 or 64 numbers, and is readable.",
      );
    }

    let payerPublicKey: string;
    try {
      payerPublicKey = derivePublicKeyBase58(payerSecretKey);
    } catch {
      throw new Error(
        "Failed to derive public key from payer keypair. Ensure the keypair file contains a valid ed25519 secret key.",
      );
    }

    return {
      mode: "devnet",
      facilitatorUrl: env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL,
      solanaRpcUrl: env.X402_SOLANA_RPC_URL || undefined,
      payerSecretKey,
      payerPublicKey,
      payeePublicKey,
      devnetUsdcMint: env.X402_DEVNET_USDC_MINT || USDC_DEVNET_MINT,
      amountMinor: parseAmountMinor(env.X402_AMOUNT_MINOR, DEFAULT_AMOUNT_MINOR),
    };
  }

  return {
    mode: "mock",
    payeeWallet: env.X402_DEMO_PAYEE_WALLET || "demo_payee_RunVista_mock",
    agentWallet: env.X402_DEMO_AGENT_WALLET || "demo_agent_wallet_mock",
    usdcMint: env.X402_DEMO_USDC_MINT || "usdc_devnet_mock_mint",
    amountMinor: parseAmountMinor(env.X402_AMOUNT_MINOR, DEFAULT_AMOUNT_MINOR),
  };
}

export { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT };
