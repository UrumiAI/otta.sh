import { credentialVerifierContract } from "@urumi/domain/testing";
import { afterEach, describe } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgVerifierHarness,
	makeSqliteVerifierHarness,
	teardownCustomers,
} from "./customer-harness.js";

afterEach(teardownCustomers);

credentialVerifierContract(makeSqliteVerifierHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	credentialVerifierContract(makePgVerifierHarness, { dialect: "pg" });
});
