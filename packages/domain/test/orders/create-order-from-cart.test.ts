import {
	cents,
	createOrderFromCart,
	currency,
	customerId as brandCustomerId,
	idempotencyKey,
	money,
	type OrderAddressInput,
	productId as brandProductId,
	type ProductCommerceStore,
	sku as brandSku,
} from "@otta-sh/domain";
import { CountingIdGen, FixedClock, InMemoryAddressStore } from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness, SEED_PUBLISHED_AT } from "./fake-harness.js";

const SHIP_TO: OrderAddressInput = {
	name: "Ada Lovelace",
	line1: "12 Analytical Way",
	line2: "Unit 4",
	city: "London",
	region: "LND",
	postalCode: "EC1A 1BB",
	country: "GB",
	email: "ada@example.com",
	phone: "+44 20 7946 0000",
};

function cmd(cartId: string, key = "k-order") {
	return {
		cartId,
		idempotencyKey: idempotencyKey(key),
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
	} as const;
}

describe("createOrderFromCart", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	test("snapshots price+title from cart lines and writes the order_totals stub (Σ line)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 3, kind: "physical" }]);

		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const line = res.order.lines[0]!;
		expect(line.title).toBe("Widget");
		expect(line.unitPrice).toBe(500);
		expect(line.currency).toBe("USD");
		expect(line.quantity).toBe(3);
		expect(line.fulfillmentKind).toBe("physical");
		// order_totals stub: subtotal = total = Σ(unit_price × qty); breakdown 0.
		expect(res.order.totals.subtotal).toBe(1500);
		expect(res.order.totals.total).toBe(1500);
		expect(res.order.totals.discount).toBe(0);
		expect(res.order.totals.tax).toBe(0);
		expect(res.order.state).toBe("pending");
	});

	test("adopts a physical line's reservation via the guarded held→adopted flip (out of the Phase-3 sweep's scope)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const cart = (await h.cartStore.get(cartId))!;
		const reservationId = cart.lines[0]!.reservationId!;
		expect(h.inventory.reservationState(reservationId)).toBe("held");

		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// The reservation is now `adopted` (not `held`) → invisible to the sweep.
		expect(h.inventory.reservationState(reservationId)).toBe("adopted");
		expect(res.order.lines[0]!.reservationId).toBe(reservationId);
		// The cart is flipped out of `active`.
		expect((await h.cartStore.get(cartId))!.state).toBe("checked_out");
	});

	test("a digital line reserves nothing: reservation_id is NULL, no adoption flip", async () => {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const cart = (await h.cartStore.get(cartId))!;
		expect(cart.lines[0]!.reservationId).toBeNull();

		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.lines[0]!.reservationId).toBeNull();
		expect(res.order.lines[0]!.fulfillmentKind).toBe("digital");
	});

	test("a lost/swept hold at adoption time fails creation with RESERVATION_LOST", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const cart = (await h.cartStore.get(cartId))!;
		// Simulate the sweep reaping the hold before adoption: release it.
		await h.inventory.release(cart.lines[0]!.reservationId!);

		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "RESERVATION_LOST" });
	});

	test("a multi-line cart aborts on a later line's RESERVATION_LOST after an earlier line was already adopted: the order row was durably inserted before any line was adopted, and the abort expires it AT ONCE, releasing the earlier line's adopted hold (nothing left for expireOrders)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "A",
			onHand: 10,
		});
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 700,
			title: "B",
			onHand: 10,
		});
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
		]);
		const cart = (await h.cartStore.get(cartId))!;
		const first = cart.lines[0]!.reservationId!;
		const second = cart.lines[1]!.reservationId!;
		// Reap ONLY the second line's hold, so the first adopts then the second aborts.
		await h.inventory.release(second);

		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		// The order can never be paid, so it is abandoned now — exactly as the
		// expiry sweep would abandon it — rather than squatting on the first line's
		// units (and on the cart's fixed checkout key) until the TTL passes.
		const order = await h.orderStore.getByIdempotencyKey(cmd(cartId).idempotencyKey);
		expect(order?.state).toBe("expired");
		expect(h.inventory.reservationState(first)).toBe("released");
		expect(h.inventory.onHand("SKU-1")).toBe(10);
		h.clock.advance(16 * 60 * 1000);
		const { expireOrders } = await import("@otta-sh/domain");
		expect(await expireOrders(h.expireDeps)).toBe(0);
	});

	test("a PHYSICAL line whose cart line carries no reservation (product flipped digital→physical after add-to-cart) fails loudly with RESERVATION_LOST — never an order that would settle with no commit", async () => {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		// The product flips digital → physical between add-to-cart and checkout:
		// the cart line reserved nothing (digital never reserves), but the checkout
		// snapshot now reads productKind='physical'.
		await h.productCommerce.upsert(
			{
				productId: brandProductId("d1"),
				sku: brandSku("DIG-1"),
				price: money(cents(900), currency("USD")),
				title: "Ebook (now boxed)",
				productKind: "physical",
			},
			idempotencyKey("flip-kind"),
		);

		// G3: a physical line with reservationId NULL must fail creation loudly —
		// adoption and settle's commit branch would both silently skip it,
		// producing a paid order that committed no inventory.
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "RESERVATION_LOST" });
	});

	test("a line whose product price currency differs from the cart currency is rejected CURRENCY_MISMATCH — never summed into a foreign-currency total", async () => {
		// Seed a digital product priced in EUR while the cart is USD.
		await h.productCommerce.upsert(
			{
				productId: brandProductId("d-eur"),
				sku: brandSku("DIG-EUR"),
				price: money(cents(900), currency("EUR")),
				title: "Ebook (EUR)",
				productKind: "digital",
			},
			idempotencyKey("seed-eur"),
		);
		await h.productCommerce.activate(
			brandProductId("d-eur"),
			idempotencyKey("publish-eur"),
			SEED_PUBLISHED_AT,
		);
		const cartId = await h.cartWith([
			{ sku: "DIG-EUR", productId: "d-eur", qty: 1, kind: "digital" },
		]);

		// G5: order.currency is stamped from the cart; a EUR line summed into a
		// USD total is money-mixing, not a checkout.
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "CURRENCY_MISMATCH" });
	});

	test("a second checkout of the same cart with a DIFFERENT idempotency key is rejected CART_CHECKED_OUT — no second order is minted", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, "k-tab-1"));
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const reservationId = first.order.lines[0]!.reservationId!;

		// Two tabs, per-click keys (G2): the cart is checked_out, so a DISTINCT key
		// must be rejected by the cart-state fence — never mint a second pending
		// order whose line snapshots a reservation the first order already adopted.
		const second = await createOrderFromCart(h.createDeps, cmd(cartId, "k-tab-2"));
		expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		// The first order's adopted hold is untouched.
		expect(h.inventory.reservationState(reservationId)).toBe("adopted");
	});

	// -- issue #133: a replayed key must belong to THIS cart ----------------------

	test("a key already spent on ANOTHER cart is refused IDEMPOTENCY_KEY_REUSED — never ok:true for an order this cart has nothing to do with", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const oldCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(oldCart, "checkout:old"));
		if (!first.ok) throw new Error(first.reason);

		// A stale tab submits the OLD cart's key while the cookie names a NEW cart.
		const newCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const newReservation = (await h.cartStore.get(newCart))!.lines[0]!.reservationId!;
		const res = await createOrderFromCart(h.createDeps, cmd(newCart, "checkout:old"));

		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		// The new cart is untouched: still active, no order stamped, its hold still held.
		const cart = await h.cartStore.get(newCart);
		expect({ state: cart?.state, orderId: cart?.orderId }).toEqual({
			state: "active",
			orderId: null,
		});
		expect(h.inventory.reservationState(newReservation)).toBe("held");
		// And the key's own cart can still replay it.
		const replay = await createOrderFromCart(h.createDeps, cmd(oldCart, "checkout:old"));
		expect(replay.ok && replay.order.id).toBe(first.order.id);
	});

	test("the mismatch is refused even once the key's order has left pending (a PAID order is still not this cart's)", async () => {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const oldCart = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(oldCart, "checkout:old"));
		if (!first.ok) throw new Error(first.reason);
		await h.orderStore.markPaid(first.order.id);

		const newCart = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(newCart, "checkout:old"));
		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect((await h.cartStore.get(newCart))?.state).toBe("active");
	});

	test("a same-key call for another cart that RACES past the short-circuit is refused after the deduped insert — the foreign order's id is never stamped on this cart", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const oldCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(oldCart, "checkout:old"));
		if (!first.ok) throw new Error(first.reason);

		// The race window: this caller's I1 read ran before the winner's insert
		// landed, so it saw no order — then its own insert is deduped on the key.
		const racing = new Proxy(h.orderStore, {
			get(target, prop) {
				if (prop === "getByIdempotencyKey") return async () => null;
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const newCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const newReservation = (await h.cartStore.get(newCart))!.lines[0]!.reservationId!;
		const res = await createOrderFromCart(
			{ ...h.createDeps, orderStore: racing },
			cmd(newCart, "checkout:old"),
		);

		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		const cart = await h.cartStore.get(newCart);
		expect({ state: cart?.state, orderId: cart?.orderId }).toEqual({
			state: "active",
			orderId: null,
		});
		expect(h.inventory.reservationState(newReservation)).toBe("held");
		// The winner's order and its adopted hold are untouched.
		expect(h.inventory.reservationState(first.order.lines[0]!.reservationId!)).toBe("adopted");
		expect((await h.cartStore.get(oldCart))?.orderId).toBe(first.order.id);
	});

	test("the racing foreign-cart call releases a coupon use IT redeemed — the orphan names an order that was never inserted", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
		await h.couponStore.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: currency("USD"),
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
		// The key's winning order used NO coupon.
		const oldCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(oldCart, "checkout:old"));
		if (!first.ok) throw new Error(first.reason);

		const racing = new Proxy(h.orderStore, {
			get(target, prop) {
				if (prop === "getByIdempotencyKey") return async () => null;
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const newCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(
			{ ...h.createDeps, orderStore: racing },
			{ ...cmd(newCart, "checkout:old"), couponCode: "SAVE5" },
		);

		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
	});

	test("anti-N+1: an N-line cart reads product snapshots via ONE getManyByProductId, never per-line getByProductId", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "A",
			onHand: 10,
		});
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 700,
			title: "B",
			onHand: 10,
		});
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
		]);

		// Spy over the fake store, counting the two snapshot reads. This fails the
		// day the per-cart-line loop is ever reintroduced.
		let getOne = 0;
		let getMany = 0;
		const base = h.productCommerce;
		const spy: ProductCommerceStore = {
			upsert: (input, key) => base.upsert(input, key),
			getByProductId: (id) => {
				getOne++;
				return base.getByProductId(id);
			},
			getManyByProductId: (ids) => {
				getMany++;
				return base.getManyByProductId(ids);
			},
			softDelete: (id, key) => base.softDelete(id, key),
			updateCommerceFields: (input, key, expected) =>
				base.updateCommerceFields(input, key, expected),
			activate: (id, key, t) => base.activate(id, key, t),
			deactivate: (id, key, t) => base.deactivate(id, key, t),
			listCommerceByIds: (ids) => base.listCommerceByIds(ids),
			listProducts: (filter, page) => base.listProducts(filter, page),
			countProducts: (filter) => base.countProducts(filter),
			countByTaxClass: (taxClassId) => base.countByTaxClass(taxClassId),
			upsertVariant: (input, key) => base.upsertVariant(input, key),
			listVariants: (id) => base.listVariants(id),
			updateVariantFields: (input, key, expected) => base.updateVariantFields(input, key, expected),
			deactivateVariant: (id, variantKey, key, t) => base.deactivateVariant(id, variantKey, key, t),
		};

		const res = await createOrderFromCart({ ...h.createDeps, productCommerce: spy }, cmd(cartId));
		expect(res.ok).toBe(true);
		expect(getMany).toBe(1);
		expect(getOne).toBe(0);
	});

	test("is idempotent: replay with same key returns the same order, no double snapshot, no re-adopt", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);

		const first = await createOrderFromCart(h.createDeps, cmd(cartId));
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok || !replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);
		expect(replay.order.lines).toHaveLength(1);
		// Stock decremented once (the original reserve), never re-reserved.
		expect(h.inventory.onHand("SKU-1")).toBe(8);
		expect(h.inventory.reservationState(first.order.lines[0]!.reservationId!)).toBe("adopted");
	});

	// -- issue #132: the cart records the order it became -----------------------

	async function widgetCart(): Promise<string> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		return h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	}

	test("the cart records the CREATED order's id, in the same flip that makes it terminal", async () => {
		const cartId = await widgetCart();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		// Asserted against `res.order.id` — the id of the order the store actually
		// returned — not against the locally minted `freshOrderId` candidate. On
		// this fresh path the two coincide (the insert wins with the candidate id),
		// so this pins the INTENT: the cart must name the persisted order.
		const cart = await h.cartStore.get(cartId);
		expect({ state: cart?.state, orderId: cart?.orderId }).toEqual({
			state: "checked_out",
			orderId: res.order.id,
		});
	});

	test("a SAME-KEY replay returns the same order and does not rewrite the cart's order id", async () => {
		const cartId = await widgetCart();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(replay.ok && replay.order.id).toBe(first.order.id);
		// The replay short-circuits at I1, long before the flip; even if it did
		// reach the flip, the `state='active'` CAS matches 0 rows.
		expect((await h.cartStore.get(cartId))?.orderId).toBe(first.order.id);
	});

	test("a DISTINCT-key second checkout is rejected and leaves the first order's id on the cart", async () => {
		const cartId = await widgetCart();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, "k-tab-1"));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const second = await createOrderFromCart(h.createDeps, cmd(cartId, "k-tab-2"));
		expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect((await h.cartStore.get(cartId))?.orderId).toBe(first.order.id);
	});

	test("an order id on the cart is NOT proof of payment — it is stamped while the order is still pending", async () => {
		const cartId = await widgetCart();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		// `cartStore.checkout()` runs BEFORE `gateway.createIntent()`, so a
		// pending — and later a failed or expired — order has a fully stamped
		// cart. A future reader must never treat `orderId != null` as paid.
		const persisted = await h.orderStore.getById(res.order.id);
		expect(persisted?.state).toBe("pending");
		expect((await h.cartStore.get(cartId))?.orderId).toBe(res.order.id);
	});

	// -- ADR-0009: checkout address capture ------------------------------------

	async function seededCart(): Promise<string> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		return h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	}

	test("captures the submitted ship-to snapshot immutably onto the order (trimmed)", async () => {
		const cartId = await seededCart();
		const res = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			// Leading/trailing whitespace proves the domain trims before snapshotting.
			shippingAddress: { ...SHIP_TO, name: "  Ada Lovelace  " },
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.shippingAddress).toEqual({
			name: "Ada Lovelace",
			line1: "12 Analytical Way",
			line2: "Unit 4",
			city: "London",
			region: "LND",
			postalCode: "EC1A 1BB",
			country: "GB",
			email: "ada@example.com",
			phone: "+44 20 7946 0000",
		});
		// Persisted, not just echoed — a reload returns the frozen snapshot.
		expect((await h.orderStore.getById(res.order.id))?.shippingAddress?.name).toBe("Ada Lovelace");
	});

	test("an order created without a shipping address has shippingAddress null (a store with no zones)", async () => {
		const cartId = await seededCart();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// A PHYSICAL order with no address is accepted in a store with NO zones:
		// nothing prices by it (ADR-0021 Decision 4). With zones it is refused
		// MISSING_SHIPPING_ADDRESS — see create-order-zone-derivation.test.ts.
		expect(res.order.shippingAddress).toBeNull();
	});

	test("rejects a malformed ship-to (empty required field) with INVALID_SHIPPING_ADDRESS — nothing minted", async () => {
		const cartId = await seededCart();
		const res = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			shippingAddress: { ...SHIP_TO, city: "   " }, // required, empty after trim
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("INVALID_SHIPPING_ADDRESS");
		// The checkout aborted before minting: the cart is still active (no order).
		expect((await h.cartStore.get(cartId))?.state).toBe("active");
	});

	test("rejects an over-length ship-to field with INVALID_SHIPPING_ADDRESS", async () => {
		const cartId = await seededCart();
		const res = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			shippingAddress: { ...SHIP_TO, line1: "x".repeat(201) },
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("INVALID_SHIPPING_ADDRESS");
	});

	// A signed-in checkout names its owner, and the ORDER carries it — not only the
	// coupon's per-customer count — so the order is in the shopper's list at once.
	test("a checkout carrying a customerId mints an order that customer owns; without one it is a guest order", async () => {
		const cartId = await seededCart();
		const owner = brandCustomerId("cust-owner");
		const res = await createOrderFromCart(h.createDeps, { ...cmd(cartId), customerId: owner });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.customerId).toBe(owner);
		expect((await h.orderStore.listForCustomer(owner)).map((o) => o.id)).toEqual([res.order.id]);

		const guestCart = await seededCart();
		const guest = await createOrderFromCart(h.createDeps, cmd(guestCart, "k-guest"));
		expect(guest.ok && guest.order.customerId).toBeNull();
	});

	test("the order ship-to is frozen: editing the profile address book afterward never rewrites it", async () => {
		const cartId = await seededCart();
		const custId = brandCustomerId("cust-1");
		// A separate profile address book (ADR-0009 demotes it to prefill/context).
		const addressStore = new InMemoryAddressStore({
			idGen: new CountingIdGen("addr"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		const saved = await addressStore.create(custId, {
			kind: "shipping",
			name: "Ada Lovelace",
			line1: "12 Analytical Way",
			city: "London",
			postalCode: "EC1A 1BB",
			country: "GB",
		});

		const res = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			shippingAddress: SHIP_TO,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const orderId = res.order.id;

		// The buyer later edits their saved profile address (moves house).
		await addressStore.update(custId, saved.id, {
			line1: "99 Somewhere Else",
			city: "Manchester",
			postalCode: "M1 1AA",
		});

		// The order's ship-to is UNCHANGED — a frozen copy, never a live pointer.
		const reloaded = await h.orderStore.getById(orderId);
		expect(reloaded?.shippingAddress?.line1).toBe("12 Analytical Way");
		expect(reloaded?.shippingAddress?.city).toBe("London");
		// And the profile book did move — proving the edit actually happened.
		expect((await addressStore.list(custId))[0]?.line1).toBe("99 Somewhere Else");
	});

	test("a replay of a captured checkout carries the ship-to exactly once (idempotent)", async () => {
		const cartId = await seededCart();
		const first = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			shippingAddress: SHIP_TO,
		});
		const replay = await createOrderFromCart(h.createDeps, {
			...cmd(cartId),
			shippingAddress: SHIP_TO,
		});
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok || !replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);
		expect(replay.order.shippingAddress).toEqual(first.order.shippingAddress);
		expect(replay.order.shippingAddress?.name).toBe("Ada Lovelace");
	});
});

/**
 * The publish gate is a CHECKOUT rule, not only a listing one. A product the
 * merchant unpublished (`active=false`) or deleted (`deletedAt` set, which also
 * closes the gate) must not be sold — including from a cart that already held it
 * before the lifecycle event landed. The refusal is the existing
 * `PRODUCT_NOT_PRICED` token ("this line cannot be ordered"), raised BEFORE any
 * order row, coupon redemption or adoption, so the line's hold is left exactly
 * as it was: still `held`, releasable by the shopper's remove or the TTL sweep.
 */
describe("createOrderFromCart sells only live products (publish gate + tombstone)", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function heldCart(): Promise<{ cartId: string; reservationId: string }> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1400,
			title: "Widget",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const reservationId = (await h.cartStore.get(cartId))!.lines[0]!.reservationId!;
		return { cartId, reservationId };
	}

	async function expectRefusedAndUntouched(cartId: string, reservationId: string): Promise<void> {
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
		// Nothing minted, nothing adopted, the cart still the shopper's to edit.
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey("k-order"))).toBeNull();
		expect(h.inventory.reservationState(reservationId)).toBe("held");
		expect(h.inventory.onHand("SKU-1")).toBe(4);
		const cart = (await h.cartStore.get(cartId))!;
		expect(cart.state).toBe("active");
		expect(cart.orderId).toBeNull();
	}

	test("a live, published, priced product still checks out (the gate is not over-eager)", async () => {
		const { cartId } = await heldCart();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
	});

	test("a cart line whose product was UNPUBLISHED after the add is refused PRODUCT_NOT_PRICED, leaving its hold held", async () => {
		const { cartId, reservationId } = await heldCart();
		await h.productCommerce.deactivate(
			brandProductId("p1"),
			idempotencyKey("unpublish-p1"),
			"2026-07-09T00:00:00.000Z",
		);
		await expectRefusedAndUntouched(cartId, reservationId);
	});

	test("a cart line whose product was DELETED after the add is refused PRODUCT_NOT_PRICED, leaving its hold held", async () => {
		const { cartId, reservationId } = await heldCart();
		await h.productCommerce.softDelete(brandProductId("p1"), idempotencyKey("delete-p1"));
		await expectRefusedAndUntouched(cartId, reservationId);
	});

	test("a priced product that was NEVER published cannot be ordered", async () => {
		await h.productCommerce.upsert(
			{
				productId: brandProductId("d-draft"),
				sku: brandSku("DIG-DRAFT"),
				price: money(cents(900), currency("USD")),
				title: "Draft ebook",
				productKind: "digital",
			},
			idempotencyKey("seed-draft"),
		);
		const cartId = await h.cartWith([
			{ sku: "DIG-DRAFT", productId: "d-draft", qty: 1, kind: "digital" },
		]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
	});

	test("republishing restores the sale: the same cart then checks out", async () => {
		const { cartId } = await heldCart();
		await h.productCommerce.deactivate(
			brandProductId("p1"),
			idempotencyKey("unpublish-p1"),
			"2026-07-09T00:00:00.000Z",
		);
		expect(await createOrderFromCart(h.createDeps, cmd(cartId, "k-1"))).toEqual({
			ok: false,
			reason: "PRODUCT_NOT_PRICED",
		});
		await h.productCommerce.activate(
			brandProductId("p1"),
			idempotencyKey("republish-p1"),
			"2026-07-09T01:00:00.000Z",
		);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, "k-2"));
		expect(res.ok).toBe(true);
	});
});
