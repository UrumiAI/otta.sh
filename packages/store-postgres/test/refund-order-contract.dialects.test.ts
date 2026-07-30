import { refundOrderContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgRefundOrderHarness,
	makeSqliteRefundOrderHarness,
	teardownOrderFlow,
} from "./order-harness.js";

// The refunds spec (ADR-0008) on the real adapters. SQLite verifies the DDL + the
// ceiling-guarded ledger write + the full-refund flip compose; Postgres runs the
// same spec AND the concurrency races (see refund-race.pg.test.ts — SQLite
// serializes writes, so it can't race).

afterEach(teardownOrderFlow);

refundOrderContract(makeSqliteRefundOrderHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	refundOrderContract(makePgRefundOrderHarness, { dialect: "pg" });
});
