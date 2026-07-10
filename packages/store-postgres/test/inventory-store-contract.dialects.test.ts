import { inventoryStoreContract } from "@urumi/domain/testing";
import { afterEach, describe } from "vitest";
import {
	makePgHarness,
	makeSqliteHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// The SAME reusable contract suite (§0.3) runs against every DB dialect (§0.4):
// SQLite always, Postgres only when PG_CONNECTION_STRING is set.
afterEach(teardownDialects);

inventoryStoreContract(makeSqliteHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	inventoryStoreContract(makePgHarness, { dialect: "pg" });
});
