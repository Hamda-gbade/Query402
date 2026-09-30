import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { PaymentAttempt, UsageEvent } from "@query402/shared";
import { z } from "zod";
import { paymentAttemptToRow, usageEventToRow } from "./serialization.js";
import { closeAnalyticsDb, getAnalyticsDb, runInAnalyticsTransaction } from "./sqlite/store.js";
import { resolveApiDataPath } from "./paths.js";

const usageEventSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["search", "news", "scrape"]),
  endpoint: z.string().min(1),
  providerId: z.string().min(1),
  queryOrUrl: z.string().min(1),
  priceUsd: z.number(),
  network: z.string().min(1),
  paymentStatus: z
    .enum(["verified", "settled", "failed", "demo-paid", "paid"])
    .transform((value) => (value === "paid" ? "settled" : value)),
  paymentTxHash: z.string().optional(),
  facilitatorUrl: z.string().optional(),
  payerPublicKey: z.string().optional(),
  traceId: z.string().min(1),
  createdAt: z.string().min(1),
  latencyMs: z.number(),
  sponsorshipGrantId: z.string().optional(),
  policyDecision: z.string().optional(),
  paymentSource: z.enum(["sponsored", "wallet", "demo"]).optional(),
  sponsorPublicKey: z.string().optional()
});

const paymentAttemptSchema = z.object({
  id: z.string().min(1),
  endpoint: z.string().min(1),
  providerId: z.string().min(1),
  amountUsd: z.number(),
  network: z.string().min(1),
  payerPublicKey: z.string().optional(),
  payToAddress: z.string().min(1),
  facilitatorUrl: z.string().min(1),
  status: z.enum(["demo-paid", "verified", "settled", "failed"]),
  transactionHash: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  sponsorshipGrantId: z.string().optional(),
  policyDecision: z.string().optional(),
  paymentSource: z.enum(["sponsored", "wallet", "demo"]).optional(),
  sponsorPublicKey: z.string().optional()
});

const legacyDbSchema = z.object({
  usage: z.array(usageEventSchema),
  payments: z.array(paymentAttemptSchema)
});

export type LegacyDbJson = z.infer<typeof legacyDbSchema>;

export interface JsonMigrationOptions {
  sourcePath: string;
  targetPath: string;
  dryRun?: boolean;
  archiveSource?: boolean;
}

export interface JsonMigrationResult {
  sourcePath: string;
  targetPath: string;
  usageTotal: number;
  usageInserted: number;
  usageSkipped: number;
  paymentsTotal: number;
  paymentsInserted: number;
  paymentsSkipped: number;
  dryRun: boolean;
  archivedPath?: string;
}

const INSERT_USAGE = `
INSERT OR IGNORE INTO usage_events (
  id, mode, endpoint, provider_id, query_or_url, price_usd, network,
  payment_status, payment_kind, payment_tx_hash, asset, pay_to_address, amount,
  facilitator_url, payer_public_key, trace_id, created_at, latency_ms,
  sponsorship_grant_id, policy_decision, payment_source, sponsor_public_key
) VALUES (
  @id, @mode, @endpoint, @provider_id, @query_or_url, @price_usd, @network,
  @payment_status, @payment_kind, @payment_tx_hash, @asset, @pay_to_address, @amount,
  @facilitator_url, @payer_public_key, @trace_id, @created_at, @latency_ms,
  @sponsorship_grant_id, @policy_decision, @payment_source, @sponsor_public_key
)
`;

const INSERT_PAYMENT = `
INSERT OR IGNORE INTO payment_attempts (
  id, endpoint, provider_id, amount_usd, network, asset, amount, evidence_kind,
  payer_public_key, pay_to_address, facilitator_url, status, transaction_hash,
  facilitator_result, error, created_at, sponsorship_grant_id, policy_decision,
  payment_source, sponsor_public_key
) VALUES (
  @id, @endpoint, @provider_id, @amount_usd, @network, @asset, @amount, @evidence_kind,
  @payer_public_key, @pay_to_address, @facilitator_url, @status, @transaction_hash,
  @facilitator_result, @error, @created_at, @sponsorship_grant_id, @policy_decision,
  @payment_source, @sponsor_public_key
)
`;

export function discoverLegacyDbJsonPaths(extraCandidates: string[] = []): string[] {
  const candidates = [
    ...extraCandidates,
    resolveApiDataPath("data/db.json"),
    resolveApiDataPath("apps/api/data/db.json"),
    path.resolve(process.cwd(), "apps/api/data/db.json"),
    path.resolve(process.cwd(), "data/db.json")
  ];

  const seen = new Set<string>();
  const existing: string[] = [];

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || !fs.existsSync(normalized)) {
      continue;
    }

    seen.add(normalized);
    existing.push(normalized);
  }

  return existing;
}

export function parseLegacyDbJson(raw: string): LegacyDbJson {
  const parsed = legacyDbSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid legacy db.json shape: ${parsed.error.message}`);
  }

  return parsed.data;
}

export function readLegacyDbJson(sourcePath: string): LegacyDbJson {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Legacy db.json not found: ${sourcePath}`);
  }

  const raw = fs.readFileSync(sourcePath, "utf-8");
  return parseLegacyDbJson(raw);
}

function insertRecords(
  database: Database.Database,
  usage: UsageEvent[],
  payments: PaymentAttempt[]
): Pick<
  JsonMigrationResult,
  "usageInserted" | "usageSkipped" | "paymentsInserted" | "paymentsSkipped"
> {
  const insertUsage = database.prepare(INSERT_USAGE);
  const insertPayment = database.prepare(INSERT_PAYMENT);

  let usageInserted = 0;
  let paymentsInserted = 0;

  for (const event of usage) {
    const result = insertUsage.run(usageEventToRow(event));
    if (result.changes === 1) {
      usageInserted += 1;
    }
  }

  for (const payment of payments) {
    const result = insertPayment.run(paymentAttemptToRow(payment));
    if (result.changes === 1) {
      paymentsInserted += 1;
    }
  }

  return {
    usageInserted,
    usageSkipped: usage.length - usageInserted,
    paymentsInserted,
    paymentsSkipped: payments.length - paymentsInserted
  };
}

export function migrateLegacyJsonToSqlite(options: JsonMigrationOptions): JsonMigrationResult {
  const legacy = readLegacyDbJson(options.sourcePath);

  if (options.dryRun) {
    return {
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      usageTotal: legacy.usage.length,
      usageInserted: legacy.usage.length,
      usageSkipped: 0,
      paymentsTotal: legacy.payments.length,
      paymentsInserted: legacy.payments.length,
      paymentsSkipped: 0,
      dryRun: true
    };
  }

  try {
    const counts = runInAnalyticsTransaction(options.targetPath, (database) =>
      insertRecords(database, legacy.usage, legacy.payments)
    );

    let archivedPath: string | undefined;
    if (options.archiveSource) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      archivedPath = `${options.sourcePath}.migrated.${timestamp}`;
      fs.renameSync(options.sourcePath, archivedPath);
    }

    return {
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      usageTotal: legacy.usage.length,
      paymentsTotal: legacy.payments.length,
      dryRun: false,
      archivedPath,
      ...counts
    };
  } finally {
    closeAnalyticsDb();
  }
}

export function assertTargetDbIsEmpty(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const database = getAnalyticsDb(targetPath);
  const usageCount = (
    database.prepare(`SELECT COUNT(*) AS count FROM usage_events`).get() as { count: number }
  ).count;
  const paymentCount = (
    database.prepare(`SELECT COUNT(*) AS count FROM payment_attempts`).get() as { count: number }
  ).count;

  closeAnalyticsDb();

  if (usageCount > 0 || paymentCount > 0) {
    throw new Error(
      `Target analytics database is not empty (${usageCount} usage, ${paymentCount} payments). ` +
        "Use --force to merge records or choose a different ANALYTICS_DB_PATH."
    );
  }
}

export function formatMigrationResult(result: JsonMigrationResult): string {
  const lines = [
    result.dryRun ? "Dry run — no changes written." : "Migration complete.",
    `Source: ${result.sourcePath}`,
    `Target: ${result.targetPath}`,
    `Usage: ${result.usageInserted}/${result.usageTotal} inserted (${result.usageSkipped} skipped)`,
    `Payments: ${result.paymentsInserted}/${result.paymentsTotal} inserted (${result.paymentsSkipped} skipped)`
  ];

  if (result.archivedPath) {
    lines.push(`Archived source: ${result.archivedPath}`);
  }

  return lines.join("\n");
}
