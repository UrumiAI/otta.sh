/**
 * The behavioural spec of `entitlements/download` (issue #376, increment 2),
 * written once and run by two tiers: the route handler called in-process, and
 * the same route inside the workerd-on-Node sandbox (CLAUDE.md: a plugin route
 * is exercised against the sandbox, not trusted in-process mode alone).
 *
 * WHAT IT PINS. The route answers `{authorized: true, sku, asset}` only when the
 * whole delivery gate holds, re-read on every call: an ACTIVE grant for the
 * named order and sku, an order still in a state whose money was kept, a live
 * product that is `digital`, and a stored descriptor whose key is bound to that
 * product. Every other outcome that depends on stored data is the ONE answer
 * `{authorized: false, reason: "NOT_FOUND"}` — asserted with `toEqual`, so two
 * refusals that differed by so much as a field would fail here. A malformed
 * input is the typed `INVALID_INPUT`, which depends on the input's shape alone.
 *
 * The fixtures go through the same `@otta-sh/store-emdash` adapters the plugin
 * composes, and the grant mirrors key for key what `settleOrder` writes on a paid
 * digital line (`ent:{order}:{sku}`). Several cases then put the order or the
 * product in a state the ordinary flows would have paired with a revocation —
 * refunded with its grant still active, flipped to physical with its file still
 * attached — because those are exactly the crashes and races the gate is the
 * backstop for (increment 1's PR, "The increment-2 delivery gate is MANDATORY").
 *
 * Ids are unique per case under the tier's namespace: the sandbox's document
 * store is shared by every sandbox suite in the process.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type DownloadAsset,
	type OrderState,
} from "@otta-sh/domain";
import {
	EmdashEntitlementStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashProductCommerceStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { beforeAll, describe, expect, test } from "vitest";

export interface DownloadRouteTier {
	/** Labels the `describe`. */
	readonly name: string;
	/** A prefix no other suite writes under. */
	readonly ns: string;
	/** The document store the route reads — the fixtures are written into it. */
	storage(): StorageAccess;
	/** Call `entitlements/download` and return the route's own answer. */
	invoke(input: unknown): Promise<unknown>;
	/** A real session bearer for `email`, as the theme's cookie layer holds it. */
	loginSession(email: string): Promise<string>;
}

/** A well-formed ULID for the server-minted key's tail. */
const ULID = "01J9ZQ3V8K4M2N6P7R8S9T0VWX";

const NOT_FOUND = { authorized: false, reason: "NOT_FOUND" };
const INVALID_INPUT = { authorized: false, reason: "INVALID_INPUT" };

/** Every order state, each with the answer the gate must give. A state added to
 *  `OrderState` and not listed here fails typecheck, not just a test. */
const DELIVERABLE: Record<OrderState, boolean> = {
	paid: true,
	processing: true,
	shipped: true,
	delivered: true,
	completed: true,
	pending: false,
	failed: false,
	expired: false,
	cancelled: false,
	refunded: false,
};

export function downloadRouteContract(tier: DownloadRouteTier): void {
	describe(`entitlements/download delivery gate (${tier.name})`, () => {
		let orders: EmdashOrderStore;
		let entitlements: EmdashEntitlementStore;
		let products: EmdashProductCommerceStore;

		beforeAll(() => {
			const storage = tier.storage();
			orders = new EmdashOrderStore({
				storage,
				inventory: new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock }),
				idGen: uuidIdGen,
				clock: systemClock,
			});
			entitlements = new EmdashEntitlementStore({ storage, idGen: uuidIdGen, clock: systemClock });
			products = new EmdashProductCommerceStore({ storage, clock: systemClock });
		});

		const ids = (slug: string) => {
			const productId = `prod-${tier.ns}-${slug}`;
			return {
				orderId: `order-${tier.ns}-${slug}`,
				productId,
				sku: `SKU-${tier.ns}-${slug}`,
				buyer: `${tier.ns}-${slug}@example.test`,
				asset: {
					key: `dl/${productId}/${ULID}`,
					filename: "guide.pdf",
					contentType: "application/pdf",
					size: 2048,
				} satisfies DownloadAsset,
			};
		};
		type Ids = ReturnType<typeof ids>;

		/** A digital product, priced and sku'd, carrying `asset` (or none). */
		async function seedProduct(f: Ids, asset: DownloadAsset | null = f.asset): Promise<void> {
			const row = await products.upsert(
				{
					productId: toProductId(f.productId),
					sku: toSku(f.sku),
					price: money(cents(900), currency("USD")),
					productKind: "digital",
				},
				idempotencyKey(`seed-${f.productId}`),
			);
			if (asset === null) return;
			// The store's edit, not the admin use-case: the use-case would refuse a key
			// bound to another product, and one case needs exactly that row on disk.
			const res = await products.updateCommerceFields(
				{ productId: toProductId(f.productId), downloadAsset: asset },
				idempotencyKey(`asset-${f.productId}`),
				row.updatedAt.toISOString(),
			);
			if (!res.ok) throw new Error(`seed: asset not attached (${JSON.stringify(res)})`);
		}

		/** A one-line digital order for `f.sku` under `f.buyer`, still `pending`. */
		async function seedOrder(f: Ids): Promise<void> {
			await orders.createFromCart({
				orderId: toOrderId(f.orderId),
				cartId: null,
				currency: currency("USD"),
				idempotencyKey: idempotencyKey(`seed-${f.orderId}`),
				holdExpiresAt: "2099-01-01T00:00:00.000Z",
				buyerRef: f.buyer,
				paymentMethod: "stripe",
				lines: [
					{
						productId: toProductId(f.productId),
						sku: toSku(f.sku),
						title: "Digital Guide",
						unitPrice: cents(900),
						currency: currency("USD"),
						quantity: 1,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: cents(900), total: cents(900), currency: currency("USD") },
			});
		}

		/** The grant `settleOrder` writes for a paid digital line. */
		async function grant(f: Ids): Promise<void> {
			await entitlements.grant({
				orderId: toOrderId(f.orderId),
				productId: toProductId(f.productId),
				sku: toSku(f.sku),
				buyerRef: f.buyer,
				source: "order_paid",
				grantIdempotencyKey: idempotencyKey(`ent:${f.orderId}:${f.sku}`),
			});
		}

		/** Product, order, payment and grant: a buyer entitled to `f.asset`. */
		async function seedPaid(slug: string): Promise<Ids> {
			const f = ids(slug);
			await seedProduct(f);
			await seedOrder(f);
			await orders.markPaid(toOrderId(f.orderId));
			await grant(f);
			return f;
		}

		/** Move the order WITHOUT the revocation the real flows pair with it. */
		async function flip(f: Ids, fromState: OrderState, toState: OrderState): Promise<void> {
			const res = await orders.transition({
				orderId: toOrderId(f.orderId),
				fromState,
				toState,
				idempotencyKey: idempotencyKey(`flip-${f.orderId}-${toState}`),
				enqueueEmail: false,
			});
			if (!res.transitioned) throw new Error(`seed: ${fromState} → ${toState} not applied`);
		}

		describe("authorized", () => {
			test("an entitled buyer on a paid order gets the stored descriptor — and nothing else", async () => {
				const f = await seedPaid("ok");
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual({
					authorized: true,
					sku: f.sku,
					asset: f.asset,
				});
			});

			test("a stored digest rides along; the answer carries exactly the five descriptor fields", async () => {
				const f = ids("digest");
				const withDigest = { ...f.asset, sha256: "ab".repeat(32) };
				await seedProduct(f, withDigest);
				await seedOrder(f);
				await orders.markPaid(toOrderId(f.orderId));
				await grant(f);

				const answer = (await tier.invoke({ orderId: f.orderId, sku: f.sku })) as {
					asset?: Record<string, unknown>;
				};
				expect(answer).toEqual({ authorized: true, sku: f.sku, asset: withDigest });
				expect(Object.keys(answer.asset ?? {}).toSorted()).toEqual([
					"contentType",
					"filename",
					"key",
					"sha256",
					"size",
				]);
			});

			test("a key or path named by the caller is ignored: the stored key is the only one answered", async () => {
				const f = await seedPaid("caller-key");
				const answer = await tier.invoke({
					orderId: f.orderId,
					sku: f.sku,
					key: `dl/prod-someone-else/${ULID}`,
					path: "../../etc/passwd",
					asset: { key: "attacker" },
				});
				expect(answer).toEqual({ authorized: true, sku: f.sku, asset: f.asset });
			});

			test("a stranger's session alongside a valid orderId does not shadow the capability (ADR-0011)", async () => {
				const f = await seedPaid("cap-stranger");
				const stranger = await tier.loginSession(`${tier.ns}-cap-stranger-other@example.test`);
				expect(
					await tier.invoke({ orderId: f.orderId, sku: f.sku, sessionToken: stranger }),
				).toEqual({ authorized: true, sku: f.sku, asset: f.asset });
			});
		});

		describe("one indistinguishable NOT_FOUND", () => {
			test("no such order", async () => {
				const f = ids("no-order");
				await seedProduct(f);
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("an unpaid order (no grant), and a paid order asked for a sku it never bought", async () => {
				const unpaid = ids("unpaid");
				await seedProduct(unpaid);
				await seedOrder(unpaid);
				expect(await tier.invoke({ orderId: unpaid.orderId, sku: unpaid.sku })).toEqual(NOT_FOUND);

				const paid = await seedPaid("wrong-sku");
				expect(await tier.invoke({ orderId: paid.orderId, sku: `${paid.sku}-OTHER` })).toEqual(
					NOT_FOUND,
				);
			});

			test("a revoked entitlement", async () => {
				const f = await seedPaid("revoked");
				await entitlements.revokeByOrder(toOrderId(f.orderId));
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("a product flipped to physical with its file still attached (the integrator upsert)", async () => {
				const f = await seedPaid("physical");
				await products.upsert(
					{ productId: toProductId(f.productId), productKind: "physical" },
					idempotencyKey(`flip-physical-${f.productId}`),
				);
				expect((await products.getByProductId(toProductId(f.productId)))?.downloadAsset).toEqual(
					f.asset,
				);
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("a digital product with no file attached", async () => {
				const f = ids("no-file");
				await seedProduct(f, null);
				await seedOrder(f);
				await orders.markPaid(toOrderId(f.orderId));
				await grant(f);
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("a stored key bound to ANOTHER product is never served", async () => {
				const f = ids("foreign-key");
				await seedProduct(f, { ...f.asset, key: `dl/prod-${tier.ns}-elsewhere/${ULID}` });
				await seedOrder(f);
				await orders.markPaid(toOrderId(f.orderId));
				await grant(f);
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("a product row that is gone", async () => {
				const f = ids("no-product");
				await seedOrder(f);
				await orders.markPaid(toOrderId(f.orderId));
				await grant(f);
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
			});

			test("a session for another email cannot borrow someone else's order", async () => {
				// The session's owner IS entitled to this sku — through their own order.
				const mine = await seedPaid("borrow-mine");
				const session = await tier.loginSession(mine.buyer);
				// Someone else's order for the same product: never paid, so no grant.
				const theirs = { ...ids("borrow-theirs"), productId: mine.productId, sku: mine.sku };
				await seedOrder(theirs);

				expect(
					await tier.invoke({ orderId: theirs.orderId, sku: mine.sku, sessionToken: session }),
				).toEqual(NOT_FOUND);
			});
		});

		describe("the order must be in a deliverable state, whatever its grant says", () => {
			const reachable: Array<[OrderState, OrderState[]]> = [
				["paid", []],
				["processing", ["processing"]],
				["shipped", ["processing", "shipped"]],
				["delivered", ["processing", "shipped", "delivered"]],
				["completed", ["completed"]],
				["refunded", ["refunded"]],
				["cancelled", ["cancelled"]],
			];
			test.each(reachable)("a %s order (grant still active)", async (state, path) => {
				const f = await seedPaid(`state-${state}`);
				let from: OrderState = "paid";
				for (const to of path) {
					await flip(f, from, to);
					from = to;
				}
				expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(
					DELIVERABLE[state] ? { authorized: true, sku: f.sku, asset: f.asset } : NOT_FOUND,
				);
			});

			// A grant on an order that never kept its money: the settle-vs-expiry race.
			test.each(["pending", "expired", "failed"] as const)(
				"a %s order carrying a grant",
				async (state) => {
					expect(DELIVERABLE[state]).toBe(false);
					const f = ids(`state-${state}`);
					await seedProduct(f);
					await seedOrder(f);
					if (state !== "pending") await flip(f, "pending", state);
					await grant(f);
					expect(await tier.invoke({ orderId: f.orderId, sku: f.sku })).toEqual(NOT_FOUND);
				},
			);
		});

		describe("malformed input is the typed INVALID_INPUT", () => {
			test.each<[string, Record<string, unknown>]>([
				["no sku", { orderId: "order-x" }],
				["no orderId", { sku: "SKU-x" }],
				["a session but no orderId", { sku: "SKU-x", sessionToken: "anything" }],
				["an empty sku", { orderId: "order-x", sku: "" }],
				["an empty orderId", { orderId: "", sku: "SKU-x" }],
				["a non-string sku", { orderId: "order-x", sku: 7 }],
				["a non-string orderId", { orderId: { $ne: null }, sku: "SKU-x" }],
				["a sku over 200 characters", { orderId: "order-x", sku: "S".repeat(201) }],
				["an orderId over 200 characters", { orderId: "o".repeat(201), sku: "SKU-x" }],
				["a NUL in the sku", { orderId: "order-x", sku: "SKU\u0000x" }],
				["a NUL in the orderId", { orderId: "order\u0000x", sku: "SKU-x" }],
			])("%s", async (_label, input) => {
				expect(await tier.invoke(input)).toEqual(INVALID_INPUT);
			});

			test("a raw buyerRef is not a scope: the plugin never forwards an email (#33)", async () => {
				const f = await seedPaid("buyerref");
				expect(await tier.invoke({ buyerRef: f.buyer, sku: f.sku })).toEqual(INVALID_INPUT);
			});
		});
	});
}
