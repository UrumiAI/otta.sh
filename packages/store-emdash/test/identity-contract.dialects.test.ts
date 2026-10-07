/**
 * The domain's four identity contracts against the document adapters, on every
 * Node dialect.
 *
 * The contract suites ARE the spec: the same cases the fake and the SQL adapter
 * run, with no skips and no narrowing. What they exercise here that they cannot
 * exercise against SQL is that four guarantees survive being reassembled out of
 * documents with no transaction between them — email uniqueness without a UNIQUE
 * constraint, cross-customer address isolation without a `WHERE … AND customer_id`,
 * a single-use magic link without a guarded `UPDATE`, and a per-address cap that
 * the SQL's count-then-insert could exceed under concurrency.
 */
import {
	addressBookContract,
	credentialVerifierContract,
	customerStoreContract,
	sessionContract,
} from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import {
	makeAddressHarness,
	makeCustomerHarness,
	makeSessionHarness,
	makeVerifierHarness,
} from "./identity-harness.js";

describeEachDialect("EmdashCustomerStore", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	customerStoreContract(async () => makeCustomerHarness(bound.storage), { dialect: ctx.dialect });
});

describeEachDialect("EmdashAddressStore", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	addressBookContract(async () => makeAddressHarness(bound.storage), { dialect: ctx.dialect });
});

describeEachDialect("EmdashSessionStore", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	sessionContract(async () => makeSessionHarness(bound.storage), { dialect: ctx.dialect });
});

describeEachDialect("EmdashCredentialVerifier", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	credentialVerifierContract(async () => makeVerifierHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
