/**
 * The domain's entitlement, settings and order-note contracts against the document
 * adapters, on every Node dialect.
 *
 * The contract suites ARE the spec: the same cases the fakes and the SQL adapters
 * run, with no skips and no narrowing. What they exercise here that they cannot
 * exercise against SQL is that three guarantees survive being reassembled out of
 * documents with no transaction between them — grant-once without a UNIQUE
 * `grant_idempotency_key`, a settings mutation ledger without the transaction that
 * bracketed it, and note-once without a UNIQUE `idempotency_key`.
 */
import {
	entitlementStoreContract,
	orderNotesStoreContract,
	settingsStoreContract,
} from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import {
	makeEntitlementHarness,
	makeOrderNotesHarness,
	makeSettingsHarness,
} from "./misc-harness.js";

describeEachDialect("EmdashEntitlementStore", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	entitlementStoreContract(async () => makeEntitlementHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});

describeEachDialect("EmdashSettingsStore", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	settingsStoreContract(async () => makeSettingsHarness(bound.storage), { dialect: ctx.dialect });
});

describeEachDialect("EmdashOrderNotesStore", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	orderNotesStoreContract(async () => makeOrderNotesHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
