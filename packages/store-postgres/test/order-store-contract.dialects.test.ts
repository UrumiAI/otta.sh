import { orderStoreContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderStoreHarness,
	makeSqliteOrderStoreHarness,
	teardownOrderFlow,
} from "./order-harness.js";

afterEach(teardownOrderFlow);

orderStoreContract(makeSqliteOrderStoreHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderStoreContract(makePgOrderStoreHarness, { dialect: "pg" });
});
