import { customerStoreContract } from "@urumi/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgCustomerHarness,
	makeSqliteCustomerHarness,
	teardownCustomers,
} from "./customer-harness.js";

afterEach(teardownCustomers);

customerStoreContract(makeSqliteCustomerHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	customerStoreContract(makePgCustomerHarness, { dialect: "pg" });
});
