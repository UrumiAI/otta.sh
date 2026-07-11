import { addressBookContract } from "@urumi/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgAddressHarness,
	makeSqliteAddressHarness,
	teardownCustomers,
} from "./customer-harness.js";

afterEach(teardownCustomers);

addressBookContract(makeSqliteAddressHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	addressBookContract(makePgAddressHarness, { dialect: "pg" });
});
