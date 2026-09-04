import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guards the operator CLI's two production incidents:
// 1. It imported a module graph plain-node type stripping rejects
//    (TypeScript parameter properties), crashing before arg parsing.
// 2. Its pool allowed unverified TLS when the URL carried no sslmode flag.
// No database, network, or payment calls in this file.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(ROOT, "packages", "payments", "operator-cli.mjs");

function runCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: (error as { code?: number } | null)?.code ?? 0, output: `${stdout}\n${stderr}` });
    });
  });
}

describe("operator CLI loadability", () => {
  it("--help loads without build step and exits zero", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("x402 operator CLI");
  });

  it("missing command fails without touching any store", async () => {
    const result = await runCli([]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("x402 operator CLI");
  });
});

describe("operator CLI mandatory TLS", () => {
  it("enforces verified TLS and never disables verification", () => {
    const source = readFileSync(CLI, "utf8");
    expect(source).toContain("rejectUnauthorized: true");
    expect(source).not.toContain("rejectUnauthorized: false");
  });
});
