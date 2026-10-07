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
import { idempotencyKey, orderId } from "@otta-sh/domain";
import {
	entitlementStoreContract,
	orderNotesStoreContract,
	settingsStoreContract,
} from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { collectionOf, ORDER_NOTES_COLLECTION, type OrderNoteDoc } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { barrierCall, isClaimWrite, onId, withCollection } from "./helpers/fault-injection.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import {
	makeEntitlementHarness,
	makeMiscHarness,
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

	// Idempotency under concurrency (Postgres-required, like the no-oversell race),
	// carried over from the deleted `@otta-sh/store-postgres` suite of the same name:
	// N concurrent appends carrying the SAME idempotency key must leave EXACTLY ONE
	// note. The SQL's guard was an `idempotency_key` UNIQUE plus `ON CONFLICT DO
	// NOTHING`; here the key IS the document id, so the once-only is the storage
	// table's primary key and `append` is one create-if-absent — the loser's
	// compare-and-set is refused, it retries, reads the committed note back and
	// returns it with `appended: false`. `better-sqlite3` serializes writes in one
	// process, so this is a real race only on Postgres.
	//
	// The COLLISION is pinned by a barrier rather than left to `Promise.all`, and
	// that is load-bearing: `pg.Pool` opens connections lazily, so the first caller
	// gets the warm one and its create-if-absent commits ~20 ms before any peer's
	// pre-read even returns. Every peer then finds the committed note and takes the
	// replay branch, so nothing ever reaches the loser path this case exists to
	// prove — the version of this test without the barrier stayed GREEN with the
	// loser path deleted from the store. `barrierCall` holds all N create-if-absent
	// writes until every one has arrived (which means every one read no note), then
	// releases them into the real repository at once. See `helpers/fault-injection.ts`.
	test.runIf(ctx.canRace)(
		"concurrent appends with one idempotency_key insert exactly once (no duplicates)",
		async () => {
			const key = idempotencyKey("race-key");
			const N = 8;
			const barrier = barrierCall(
				collectionOf<OrderNoteDoc>(bound.storage, ORDER_NOTES_COLLECTION),
				onId(key, isClaimWrite),
				N,
			);
			const h = makeMiscHarness(bound.storage, {
				storageForStore: withCollection(bound.storage, ORDER_NOTES_COLLECTION, barrier.collection),
			});
			const results = await Promise.all(
				Array.from({ length: N }, () =>
					h.orderNotesStore.append({
						orderId: orderId("ord-race"),
						author: "concurrent",
						body: "exactly one",
						idempotencyKey: key,
					}),
				),
			);
			// All N really did contend: each one read no note and then tried to create it.
			expect(barrier.arrived()).toBe(N);
			// Exactly one caller performed the insert; the rest observed the replay.
			expect(results.filter((r) => r.appended)).toHaveLength(1);
			// All callers agree on the one stored note id.
			const ids = new Set(results.map((r) => r.note.id));
			expect(ids.size).toBe(1);
			// And the collection holds a single note for the order — through the port,
			// and as documents, so a second note under a different id would be caught.
			const notes = await h.orderNotesStore.listForOrder(orderId("ord-race"));
			expect(notes).toHaveLength(1);
			expect(notes[0]?.body).toBe("exactly one");
			expect(await h.notes.count()).toBe(1);
		},
		120_000,
	);
});
