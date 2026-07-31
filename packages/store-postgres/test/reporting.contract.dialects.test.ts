import { reportingStoreContract } from "@otta-sh/domain/testing";
import { afterEach } from "vitest";
import {
	makePgReportingHarness,
	makeSqliteReportingHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// Phase 7 §7 Step 3: the shared ReportingStore contract on BOTH dialects —
// SQLite always, Postgres when PG_CONNECTION_STRING is set (CI).
afterEach(teardownDialects);

reportingStoreContract(makeSqliteReportingHarness, { dialect: "sqlite" });
if (PG_ENABLED) reportingStoreContract(makePgReportingHarness, { dialect: "postgres" });
