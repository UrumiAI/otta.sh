import { describe, expect, test } from "vitest";
import { customerId, email } from "../money/ids.js";
import { DuplicateCustomerEmailError } from "../customers/errors.js";
import type { CustomerStore } from "../ports/customer-store.js";

export interface CustomerStoreHarness {
	store: CustomerStore;
}

export interface CustomerStoreContractOptions {
	dialect: string;
}

/**
 * The reusable `CustomerStore` behavioral spec (§7): create/get/getByEmail/
 * update, case-insensitive email lookup, and the unique-email constraint.
 */
export function customerStoreContract(
	makeHarness: () => Promise<CustomerStoreHarness>,
	opts: CustomerStoreContractOptions,
): void {
	describe(`customerStoreContract [${opts.dialect}]`, () => {
		test("creates a customer and finds it by email (case-insensitive)", async () => {
			const { store } = await makeHarness();
			const created = await store.create({ email: email("Alice@Example.com") });
			expect(created.email).toBe("alice@example.com");
			expect(created.emailVerifiedAt).toBeNull();
			const byEmail = await store.getByEmail(email("ALICE@EXAMPLE.COM"));
			expect(byEmail?.id).toBe(created.id);
			const byId = await store.get(created.id);
			expect(byId?.email).toBe("alice@example.com");
		});

		test("get / getByEmail return null for an unknown customer", async () => {
			const { store } = await makeHarness();
			expect(await store.getByEmail(email("nobody@example.com"))).toBeNull();
			expect(await store.get(customerId("does-not-exist"))).toBeNull();
		});

		test("a duplicate email is rejected with DuplicateCustomerEmailError", async () => {
			const { store } = await makeHarness();
			await store.create({ email: email("dup@example.com") });
			await expect(store.create({ email: email("DUP@example.com") })).rejects.toBeInstanceOf(
				DuplicateCustomerEmailError,
			);
		});

		test("update patches displayName and emailVerifiedAt", async () => {
			const { store } = await makeHarness();
			const created = await store.create({ email: email("edit@example.com") });
			const updated = await store.update(created.id, {
				displayName: "Edited",
				emailVerifiedAt: "2026-07-10T00:00:00.000Z",
			});
			expect(updated?.displayName).toBe("Edited");
			expect(updated?.emailVerifiedAt).toBe("2026-07-10T00:00:00.000Z");
			expect((await store.get(created.id))?.displayName).toBe("Edited");
		});

		test("update of an unknown customer returns null", async () => {
			const { store } = await makeHarness();
			expect(await store.update(customerId("nope"), { displayName: "x" })).toBeNull();
		});
	});
}
