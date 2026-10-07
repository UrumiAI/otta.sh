/**
 * What the identity document model does that no port contract asks about — the
 * consequences of embedding the address book in the customer aggregate and of the
 * foreign key the SQL never had.
 *
 * Each case pins a behaviour the SQL schema produced for free and that only a
 * deliberate choice reproduces here: an address book for an unregistered customer,
 * the registration that adopts it, the litter it leaves when its last address goes,
 * and the ordering the embedded list is read back in.
 */
import { customerId, email, type CreateAddressInput } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { collectionOf, CUSTOMERS_COLLECTION, type CustomerDoc } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import { makeIdentityHarness } from "./identity-harness.js";

function addr(overrides: Partial<CreateAddressInput> = {}): CreateAddressInput {
	return {
		kind: "shipping",
		name: "Ada Lovelace",
		line1: "1 Analytical Way",
		city: "London",
		postalCode: "EC1",
		country: "GB",
		...overrides,
	};
}

describeEachDialect("identity document model", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);
	const harness = () => makeIdentityHarness(bound.storage);

	test("an address book exists for a customer nobody registered, and is invisible to the customer reads", async () => {
		const h = harness();
		const stranger = customerId("cust-1");
		const created = await h.addressStore.create(stranger, addr());
		// The address is real and reachable by its owner…
		expect((await h.addressStore.list(stranger)).map((a) => a.id)).toEqual([created.id]);
		// …and no account exists under that id, exactly as the missing `customers` row
		// answered in SQL.
		expect(await h.customerStore.get(stranger)).toBeNull();
		expect(await h.customerStore.update(stranger, { displayName: "nope" })).toBeNull();
	});

	test("registering that customer id ADOPTS the address-only document rather than colliding", async () => {
		const h = harness();
		// The harness's id source mints `cust-1` first, so the registration below lands
		// on the id the address book already wrote under — the one interleaving where
		// adoption is reachable through the ports alone.
		const stranger = customerId("cust-1");
		const existing = await h.addressStore.create(stranger, addr({ name: "Before" }));
		const registered = await h.customerStore.create({ email: email("adopt@example.com") });

		expect(registered.id).toBe(stranger);
		expect(await h.customerStore.get(stranger)).toMatchObject({ email: "adopt@example.com" });
		// The addresses survived the adoption: overwriting the document would have
		// silently emptied a live address book.
		expect((await h.addressStore.list(stranger)).map((a) => a.id)).toEqual([existing.id]);
	});

	test("an address-only document is deleted with its last address; a registered one stays", async () => {
		const h = harness();
		const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
		const stranger = customerId("nobody");
		const onlyAddress = await h.addressStore.create(stranger, addr());
		expect(await h.addressStore.delete(stranger, onlyAddress.id)).toBe(true);
		// No litter: a customer id that was only ever an address book leaves nothing.
		expect(await customers.get(stranger)).toBeNull();

		const registered = await h.customerStore.create({ email: email("keeps@example.com") });
		const theirs = await h.addressStore.create(registered.id, addr());
		expect(await h.addressStore.delete(registered.id, theirs.id)).toBe(true);
		// The account is not litter, so its document stays even with an empty book.
		expect(await customers.get(registered.id)).not.toBeNull();
		expect(await h.customerStore.get(registered.id)).not.toBeNull();
	});

	test("the embedded book reads back in creation order, and a cross-customer id is never in it", async () => {
		const h = harness();
		const a = customerId("cust-a");
		const b = customerId("cust-b");
		const first = await h.addressStore.create(a, addr({ name: "First" }));
		h.advance(10);
		const second = await h.addressStore.create(a, addr({ name: "Second" }));
		const foreign = await h.addressStore.create(b, addr({ name: "B's" }));

		expect((await h.addressStore.list(a)).map((x) => x.id)).toEqual([first.id, second.id]);
		// The ownership check is on the address INSIDE the caller's document, so B's id
		// is simply not there — there is no collection it could be reached from.
		expect(await h.addressStore.update(a, foreign.id, { city: "Hijacked" })).toBeNull();
		expect(await h.addressStore.delete(a, foreign.id)).toBe(false);
		expect((await h.addressStore.list(b)).map((x) => x.name)).toEqual(["B's"]);
	});

	test("a session summary carries no credential material and cannot be reached by anything but the hash", async () => {
		const h = harness();
		const owner = customerId("cust-session");
		const session = await h.sessionStore.create(owner);
		const [summary] = await h.sessionStore.listForCustomer(owner);

		// The document id is the token's hash, and the summary's id is a different
		// identifier entirely — so an admin surface can name a session without ever
		// holding one.
		expect(summary?.id).toBeDefined();
		expect(summary?.id).not.toBe(session.token);
		const stored = await h.sessions.query({ where: { customerId: owner } });
		expect(stored.items).toHaveLength(1);
		const [row] = stored.items;
		expect(row?.id).not.toBe(session.token);
		expect(JSON.stringify(row?.data)).not.toContain(session.token);
		expect(row?.data.sessionId).toBe(summary?.id);
	});
});
