import { entitlementStoreContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgEntitlementHarness,
	makeSqliteEntitlementHarness,
	teardownOrderFlow,
} from "./order-harness.js";

afterEach(teardownOrderFlow);

entitlementStoreContract(makeSqliteEntitlementHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	entitlementStoreContract(makePgEntitlementHarness, { dialect: "pg" });
});
