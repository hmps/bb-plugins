import assert from "node:assert/strict";
import test from "node:test";
import { parseResetCreditCount } from "../lib/codex-reset-credits.ts";

test("reads available Codex reset credits", () => {
  assert.equal(
    parseResetCreditCount({
      rateLimitResetCredits: { availableCount: 2, credits: [] },
    }),
    2,
  );
  assert.equal(
    parseResetCreditCount({
      rateLimitResetCredits: { availableCount: "3", credits: null },
    }),
    3,
  );
});

test("rejects missing or invalid reset-credit counts", () => {
  assert.equal(parseResetCreditCount({}), null);
  assert.equal(
    parseResetCreditCount({
      rateLimitResetCredits: { availableCount: -1 },
    }),
    null,
  );
  assert.equal(
    parseResetCreditCount({
      rateLimitResetCredits: { availableCount: 1.5 },
    }),
    null,
  );
});
