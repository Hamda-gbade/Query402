import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { SignedGrant, SponsorshipGrant } from "@query402/shared";
import { vi } from "vitest";

export const TEST_WALLET = `G${"A".repeat(55)}`;
export const OTHER_WALLET = `G${"B".repeat(55)}`;

export function applySponsorshipTestEnv(overrides: Record<string, string> = {}) {
  const dbPath = overrides.SPONSORSHIP_DB_PATH ?? `/tmp/query402-test-${randomUUID()}.db`;

  const defaults: Record<string, string> = {
    NODE_ENV: "test",
    X402_PAY_TO_ADDRESS: TEST_WALLET,
    STELLAR_NETWORK: "stellar:testnet",
    SPONSORSHIP_ENABLED: "true",
    SPONSORSHIP_SIGNING_SECRET: "test-signing-secret",
    SPONSORSHIP_GLOBAL_DAILY_BUDGET_USD: "10",
    SPONSORSHIP_PER_WALLET_DAILY_BUDGET_USD: "1",
    SPONSORSHIP_GRANT_TTL_SECONDS: "300",
    SPONSORSHIP_CHALLENGE_TTL_SECONDS: "60",
    SPONSORSHIP_DB_PATH: dbPath,
    IDEMPOTENCY_TTL_SECONDS: "86400",
    ...overrides
  };

  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] = value;
  }

  vi.resetModules();
  return dbPath;
}

export async function resetSponsorshipStore(dbPath?: string) {
  const store = await import("../lib/sponsorship/store.js");
  store.closeSponsorshipDb();

  const pathToDelete = dbPath ?? process.env.SPONSORSHIP_DB_PATH;
  if (pathToDelete && fs.existsSync(pathToDelete)) {
    fs.rmSync(pathToDelete, { force: true });
  }
}

export function buildGrant(overrides: Partial<SponsorshipGrant> = {}): SponsorshipGrant {
  const now = new Date();

  return {
    grantId: randomUUID(),
    wallet: TEST_WALLET,
    network: "stellar:testnet",
    maxAmountUsd: 1,
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    nonce: randomUUID(),
    issuedAt: now.toISOString(),
    ...overrides
  };
}

export async function createSignedGrant(
  overrides: Partial<SponsorshipGrant> = {}
): Promise<SignedGrant> {
  const grantModule = await import("../lib/sponsorship/grant.js");
  return grantModule.signGrant(buildGrant(overrides));
}

export function encodeGrantHeader(signedGrant: SignedGrant): string {
  return Buffer.from(JSON.stringify(signedGrant)).toString("base64");
}

export async function readGlobalBudgetSpent(): Promise<number> {
  const { getSponsorshipDb } = await import("../lib/sponsorship/store.js");
  const { getDailyWindowStart } = await import("../lib/sponsorship/budget.js");
  const row = getSponsorshipDb()
    .prepare(
      `SELECT spent_usd
       FROM sponsorship_budgets
       WHERE scope = 'global' AND wallet IS NULL AND window_start = ?`
    )
    .get(getDailyWindowStart()) as { spent_usd: number } | undefined;

  return row?.spent_usd ?? 0;
}

export async function readWalletBudgetSpent(wallet: string): Promise<number> {
  const { getSponsorshipDb } = await import("../lib/sponsorship/store.js");
  const { getDailyWindowStart } = await import("../lib/sponsorship/budget.js");
  const row = getSponsorshipDb()
    .prepare(
      `SELECT spent_usd
       FROM sponsorship_budgets
       WHERE scope = 'wallet' AND wallet = ? AND window_start = ?`
    )
    .get(wallet, getDailyWindowStart()) as { spent_usd: number } | undefined;

  return row?.spent_usd ?? 0;
}
