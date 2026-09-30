import { test, describe, before } from "node:test";
import assert from "node:assert";
import { registerHooks } from "node:module";
import type { SponsorshipPreview } from "@query402/shared";

// Stub @stellar/freighter-api (browser-only) and import.meta.env (Vite-only)
// so sponsorship.ts can be imported in the Node test runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@stellar/freighter-api") {
      return {
        url: "data:text/javascript,export const signMessage = async () => ({ error: new Error('stub') });",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result.source && result.source.includes("import.meta.env")) {
      const source =
        typeof result.source === "string"
          ? result.source
          : Buffer.from(result.source).toString("utf8");
      if (source.includes("import.meta.env")) {
        result.source = source.replaceAll(
          /import\.meta\.env(\.\w+)?/g,
          '({ VITE_API_BASE_URL: "http://localhost:3001" })'
        );
      }
    }
    return result;
  }
});

type BudgetGateModule = typeof import("./sponsorship.js");

let BudgetGate: BudgetGateModule["BudgetGate"];
let evaluateBudgetGate: BudgetGateModule["evaluateBudgetGate"];

before(async () => {
  const mod = await import("./sponsorship.js");
  BudgetGate = mod.BudgetGate;
  evaluateBudgetGate = mod.evaluateBudgetGate;
});

function makePreview(overrides: Partial<SponsorshipPreview> = {}): SponsorshipPreview {
  return {
    sponsorshipEnabled: true,
    storageAvailable: true,
    available: true,
    decision: "allowed",
    network: "stellar:testnet",
    wallet: "GABC123",
    mode: "search",
    provider: "search.basic",
    providerName: "Search Basic",
    grant: {
      maxAmountUsd: 1,
      ttlSeconds: 300,
      expiresInSeconds: 300,
      restrictions: { mode: null, providerId: null }
    },
    quotedPriceUsd: 0.01,
    priceFitsGrant: true,
    perWalletBudget: { limitUsd: 1, spentUsd: 0, remainingUsd: 1, windowStart: "2026-09-30" },
    globalBudget: { limitUsd: 10, spentUsd: 0, remainingUsd: 10, windowStart: "2026-09-30" },
    ...overrides
  };
}

describe("evaluateBudgetGate", () => {
  test("a remaining budget enables the fixture action", () => {
    const preview = makePreview({ available: true, decision: "allowed" });
    const result = evaluateBudgetGate(preview);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, null);
  });

  test("an exhausted budget disables it", () => {
    const preview = makePreview({
      available: false,
      decision: "denied_budget_exceeded",
      reason: "wallet_budget_exceeded",
      perWalletBudget: { limitUsd: 1, spentUsd: 1, remainingUsd: 0, windowStart: "2026-09-30" }
    });
    const result = evaluateBudgetGate(preview);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "wallet_budget_exceeded");
    assert.strictEqual(result.decision, "denied_budget_exceeded");
  });

  test("a policy deny disables it", () => {
    const preview = makePreview({
      available: false,
      decision: "denied_price_exceeded",
      reason: "price_exceeds_grant"
    });
    const result = evaluateBudgetGate(preview);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "price_exceeds_grant");
    assert.strictEqual(result.decision, "denied_price_exceeded");
  });

  test("falls back to decision when reason is missing", () => {
    const preview = makePreview({
      available: false,
      decision: "denied_sponsorship_disabled"
    });
    const result = evaluateBudgetGate(preview);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "denied_sponsorship_disabled");
  });
});

describe("BudgetGate", () => {
  test("a remaining budget enables the fixture action", () => {
    const gate = new BudgetGate();
    const id = gate.beginRequest();
    gate.applyResponse(id, makePreview({ available: true }));
    assert.strictEqual(gate.decision.allowed, true);
  });

  test("an exhausted budget disables it", () => {
    const gate = new BudgetGate();
    const id = gate.beginRequest();
    gate.applyResponse(
      id,
      makePreview({ available: false, decision: "denied_budget_exceeded", reason: "wallet_budget_exceeded" })
    );
    assert.strictEqual(gate.decision.allowed, false);
    assert.strictEqual(gate.decision.reason, "wallet_budget_exceeded");
  });

  test("a policy deny disables it", () => {
    const gate = new BudgetGate();
    const id = gate.beginRequest();
    gate.applyResponse(
      id,
      makePreview({ available: false, decision: "denied_wrong_provider", reason: "unknown_provider" })
    );
    assert.strictEqual(gate.decision.allowed, false);
    assert.strictEqual(gate.decision.reason, "unknown_provider");
  });

  test("an older allow response does not override a newer deny", () => {
    const gate = new BudgetGate();

    // First request: allow
    const firstId = gate.beginRequest();
    // Second request: deny (newer)
    const secondId = gate.beginRequest();

    // The older allow arrives late — it must not re-enable the actions.
    gate.applyResponse(firstId, makePreview({ available: true }));
    assert.strictEqual(gate.decision.allowed, false, "stale allow must not override newer deny");

    // The newer deny arrives and is applied.
    gate.applyResponse(
      secondId,
      makePreview({ available: false, decision: "denied_budget_exceeded", reason: "wallet_budget_exceeded" })
    );
    assert.strictEqual(gate.decision.allowed, false);
    assert.strictEqual(gate.decision.reason, "wallet_budget_exceeded");
  });

  test("an older deny does not override a newer allow", () => {
    const gate = new BudgetGate();

    const firstId = gate.beginRequest();
    const secondId = gate.beginRequest();

    gate.applyResponse(
      firstId,
      makePreview({ available: false, decision: "denied_budget_exceeded", reason: "wallet_budget_exceeded" })
    );
    // Stale deny must not override the newer allow.
    gate.applyResponse(secondId, makePreview({ available: true }));
    assert.strictEqual(gate.decision.allowed, true);
  });

  test("applyError blocks the action and shows the reason", () => {
    const gate = new BudgetGate();
    const id = gate.beginRequest();
    gate.applyError(id, "Grant preview unavailable");
    assert.strictEqual(gate.decision.allowed, false);
    assert.strictEqual(gate.decision.reason, "Grant preview unavailable");
  });

  test("stale error does not override a newer response", () => {
    const gate = new BudgetGate();

    const firstId = gate.beginRequest();
    const secondId = gate.beginRequest();

    gate.applyError(firstId, "Grant preview unavailable");
    gate.applyResponse(secondId, makePreview({ available: true }));
    assert.strictEqual(gate.decision.allowed, true);
  });

  test("reset clears the gate", () => {
    const gate = new BudgetGate();
    const id = gate.beginRequest();
    gate.applyResponse(id, makePreview({ available: true }));
    assert.strictEqual(gate.decision.allowed, true);

    gate.reset();
    assert.strictEqual(gate.decision.allowed, false);
    assert.strictEqual(gate.decision.reason, null);
  });
});
