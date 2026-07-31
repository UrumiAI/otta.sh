import { cartStoreContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import {
	makePgCartHarness,
	makeSqliteCartHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// The SAME reusable cart contract (§1 cases 1–8) runs against every DB dialect:
// SQLite always, Postgres only when PG_CONNECTION_STRING is set. The Kysely
// CartStore + inventory adjust/partial-release + guarded-flip expiry are exercised
// end-to-end through the use-cases on real DBs.
afterEach(teardownDialects);

cartStoreContract(makeSqliteCartHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	cartStoreContract(makePgCartHarness, { dialect: "pg" });
});
