import { describe, expect, test } from "vitest";
import { customerId } from "../money/ids.js";
import type { AddressStore, CreateAddressInput } from "../ports/address-store.js";

export interface AddressBookHarness {
	store: AddressStore;
}

export interface AddressBookContractOptions {
	dialect: string;
}

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

/**
 * The reusable `AddressStore` behavioral spec (§7): CRUD **and cross-customer
 * isolation** — every method is scoped by `customerId`, so customer A can never
 * see, edit, or delete customer B's rows (headline case 3).
 */
export function addressBookContract(
	makeHarness: () => Promise<AddressBookHarness>,
	opts: AddressBookContractOptions,
): void {
	const A = customerId("cust-a");
	const B = customerId("cust-b");

	describe(`addressBookContract [${opts.dialect}]`, () => {
		test("create then list returns the created address", async () => {
			const { store } = await makeHarness();
			const created = await store.create(A, addr());
			expect(created.customerId).toBe(A);
			expect(created.line2).toBeNull();
			const list = await store.list(A);
			expect(list.map((a) => a.id)).toEqual([created.id]);
		});

		test("list is scoped to the owning customer — B's rows never appear for A", async () => {
			const { store } = await makeHarness();
			await store.create(A, addr({ name: "A One" }));
			await store.create(B, addr({ name: "B One" }));
			const listA = await store.list(A);
			expect(listA).toHaveLength(1);
			expect(listA[0]?.name).toBe("A One");
		});

		test("update is customer-scoped: B cannot touch A's address (returns null)", async () => {
			const { store } = await makeHarness();
			const aAddr = await store.create(A, addr());
			expect(await store.update(B, aAddr.id, { city: "Hijacked" })).toBeNull();
			// A's own update works and persists.
			const updated = await store.update(A, aAddr.id, { city: "Cambridge" });
			expect(updated?.city).toBe("Cambridge");
			expect((await store.list(A))[0]?.city).toBe("Cambridge");
		});

		test("delete is customer-scoped: B cannot delete A's address", async () => {
			const { store } = await makeHarness();
			const aAddr = await store.create(A, addr());
			expect(await store.delete(B, aAddr.id)).toBe(false);
			expect(await store.list(A)).toHaveLength(1);
			expect(await store.delete(A, aAddr.id)).toBe(true);
			expect(await store.list(A)).toHaveLength(0);
		});
	});
}
