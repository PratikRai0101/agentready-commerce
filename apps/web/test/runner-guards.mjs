// Pure guard predicates for the hardened verification runner.
// Dependency-free so both the runner script and vitest can import this file.
// No network, no processes, no side effects here.

/** Stale-server rejection: status must echo the exact nonce this run launched with. */
export function checkRunNonce(statusJson, expectedNonce) {
  if (typeof expectedNonce !== "string" || expectedNonce.length < 8) {
    return { ok: false, reason: "launcher did not generate a usable nonce" };
  }
  const seen = statusJson?.runNonce ?? null;
  if (typeof seen !== "string" || seen.length === 0) {
    return { ok: false, reason: "server returned no run nonce (stale or foreign process)" };
  }
  if (seen !== expectedNonce) {
    return { ok: false, reason: "run nonce mismatch (stale or foreign process)" };
  }
  return { ok: true, reason: "nonce matches launched process" };
}

/** Parse `lsof -t` style output (one PID per line) into numbers. */
export function parseListenPids(lsofOutput) {
  return String(lsofOutput ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * True when a listening PID is the launched root or descends from it
 * (dev servers listen from a grandchild). getPpid(pid) returns the parent
 * PID or null when unknown. Anything else is a stale/foreign occupant.
 */
export function isOwnedByRoot(listenPids, getPpid, rootPid, maxDepth = 16) {
  if (!Array.isArray(listenPids) || listenPids.length === 0) return false;
  for (const pid of listenPids) {
    let current = pid;
    for (let depth = 0; depth <= maxDepth; depth++) {
      if (current === rootPid) return true;
      const parent = getPpid(current);
      if (parent === null || parent === undefined || parent === current) break;
      current = parent;
    }
  }
  return false;
}

/** Bind-conflict detection over captured process output (fail closed). */
export function isBindConflict(output) {
  return /EADDRINUSE|already in use|\bin use\b|already allocated/i.test(
    String(output ?? ""),
  );
}

/** Rails must stay mocked; LLM must report enabled (never "disabled"). */
export function checkIndicators(statusJson) {
  const indicators = statusJson?.indicators;
  if (!indicators) return { ok: false, reason: "no indicators in status" };
  if (indicators.razorpay !== "mock") return { ok: false, reason: `razorpay left mock: ${indicators.razorpay}` };
  if (indicators.x402 !== "mock") return { ok: false, reason: `x402 left mock: ${indicators.x402}` };
  if (!indicators.llm || indicators.llm === "disabled") return { ok: false, reason: "llm provider not enabled" };
  return { ok: true, reason: `llm=${indicators.llm} rails mocked` };
}

/** Fresh-process usage counters must all read zero before the session. */
export function checkUsageZeroed(usage) {
  if (!usage) return { ok: false, reason: "no usage snapshot in status" };
  const { calls = -1, promptTokens = -1, completionTokens = -1 } = usage;
  if (calls !== 0 || promptTokens !== 0 || completionTokens !== 0) {
    return { ok: false, reason: `usage not zeroed: ${JSON.stringify(usage)}` };
  }
  return { ok: true, reason: "usage counters start at zero" };
}

/** Hard message cap for the single session. */
export function withinMessageCap(sent, cap) {
  return Number.isInteger(sent) && sent <= cap;
}
