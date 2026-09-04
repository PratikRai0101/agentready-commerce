/**
 * Operator CLI core (pure, offline-testable). No request handler may import
 * this module: release lives only in the operator path, authenticated by
 * deployment IAM / operator database credentials — never a static token.
 */

export type ReleaseArgs = {
  operationId: string;
  operatorId: string;
  newApprovalEventId: string;
  /** Optional override; defaults to the row's staged blockhash (must match). */
  blockhash?: string;
  transferVerification: string;
  note: string;
};

export function parseReleaseArgs(argv: string[]): { ok: boolean; args?: ReleaseArgs; error?: string } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const operationId = get("--operation") ?? "";
  const operatorId = get("--operator") ?? "";
  const newApprovalEventId = get("--new-approval") ?? "";
  const blockhash = get("--blockhash");
  const transferVerification = get("--transfer") ?? "";
  const note = get("--note") ?? "";
  if (!operationId) return { ok: false, error: "--operation <operation-id> is required" };
  if (!operatorId) return { ok: false, error: "--operator <operator-id> is required" };
  if (!newApprovalEventId) return { ok: false, error: "--new-approval <appr_...> is required" };
  if (!transferVerification) return { ok: false, error: "--transfer <verification-state> is required" };
  if (!note) return { ok: false, error: "--note <text> is required" };
  return { ok: true, args: { operationId, operatorId, newApprovalEventId, blockhash, transferVerification, note } };
}

/**
 * Resolve which blockhash the release evidence must cite: an explicit flag
 * must equal the row's staged blockhash (operator typo guard); otherwise the
 * row's own bound blockhash is used. No row blockhash means expiry is
 * unprovable and release is refused downstream.
 */
export function resolveReleaseBlockhash(
  rowBlockhash: string | null,
  flagValue: string | undefined,
): { ok: boolean; blockhash?: string; error?: string } {
  if (flagValue !== undefined && flagValue.length > 0) {
    if (!rowBlockhash) {
      return { ok: false, error: "attempt has no staged blockhash; resolve via incident track, release is refused" };
    }
    if (flagValue !== rowBlockhash) {
      return { ok: false, error: "flagged blockhash does not match the attempt's staged blockhash" };
    }
    return { ok: true, blockhash: flagValue };
  }
  if (!rowBlockhash) {
    return { ok: false, error: "attempt has no staged blockhash; resolve via incident track, release is refused" };
  }
  return { ok: true, blockhash: rowBlockhash };
}

export const OPERATOR_USAGE = [
  "x402 operator CLI — release a manual attempt ONLY. No settlement is submitted here.",
  "",
  "  node operator-cli.mjs release \\",
  "    --operation <operation-id> --operator <you> --new-approval <appr_...> \\",
  "    --transfer <unavailable|mismatch> --note <fund-safety finding> \\",
  "    [--blockhash <override, must match staged>] [--rpc-url <solana rpc>]",
  "",
  "Preconditions (checked before writing): row is manual; the attempt's staged",
  "blockhash is provably expired via canonical RPC isBlockhashValid (false);",
  "no verified on-chain transfer for the attempt; new approval id cited.",
  "Connect as x402_operator (the database trigger rejects released writes",
  "from every other role, including superusers). Requires operator DB",
  "credentials via deployment IAM; DATABASE_URL and X402_STORE_ENC_KEY set.",
].join("\n");
