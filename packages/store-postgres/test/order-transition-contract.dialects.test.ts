import { orderTransitionContract } from "@urumi/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderTransitionHarness,
	makeSqliteOrderTransitionHarness,
	teardownOrderFlow,
} from "./order-harness.js";

// The order state-machine + exactly-once-email spec on the real adapters. The
// forced-rollback atomicity case (§5) runs here (both dialects support real
// transactions) — the fake harness skips it (no transaction to roll back).

afterEach(teardownOrderFlow);

orderTransitionContract(makeSqliteOrderTransitionHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderTransitionContract(makePgOrderTransitionHarness, { dialect: "pg" });
});
