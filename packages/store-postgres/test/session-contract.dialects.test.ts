import { sessionContract } from "@otta-sh/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgSessionHarness,
	makeSqliteSessionHarness,
	teardownCustomers,
} from "./customer-harness.js";

afterEach(teardownCustomers);

sessionContract(makeSqliteSessionHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	sessionContract(makePgSessionHarness, { dialect: "pg" });
});
