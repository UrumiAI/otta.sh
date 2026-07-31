import { productCommerceStoreContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import {
	makePgProductCommerceHarness,
	makeSqliteProductCommerceHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// The SAME reusable contract suite (Phase 1 step 3) runs against every DB
// dialect (step 4): SQLite always, Postgres only when PG_CONNECTION_STRING is
// set.
afterEach(teardownDialects);

productCommerceStoreContract(makeSqliteProductCommerceHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	productCommerceStoreContract(makePgProductCommerceHarness, { dialect: "pg" });
});
