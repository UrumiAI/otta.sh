import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
}

// D1 — the cart behavioral cases against a LIVE Postgres-backed test server, so
// the wire ⇄ port fidelity cannot drift. `Idempotency-Key` header → domain key;
// OUT_OF_STOCK is a typed 200 body, never a status code.
describe.skipIf(PG === undefined)("HTTP cart contract [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function req(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}${path}`, {
			method,
			headers: { "content-type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function newCart(): Promise<string> {
		const res = await req("POST", "/carts", {});
		expect(res.status).toBe(201);
		return res.body.cartId as string;
	}

	function addLine(cartId: string, sku: string, qty: number, key: string): Promise<JsonResponse> {
		return req("POST", `/carts/${cartId}/lines`, { sku, qty }, { "Idempotency-Key": key });
	}

	function addLineWithProduct(
		cartId: string,
		sku: string,
		productId: string,
		qty: number,
		key: string,
	): Promise<JsonResponse> {
		return req(
			"POST",
			`/carts/${cartId}/lines`,
			{ sku, productId, qty },
			{ "Idempotency-Key": key },
		);
	}

	// -- Variant helpers: the two-writer split, over the wire -----------------
	// A size is DECLARED by the CMS sync (name + presence, nothing commercial)
	// and PRICED by the admin (sku + price, under a compare-and-set). These
	// helpers keep that split visible in every test below, because a helper that
	// merged them would quietly make the tests pass through a door the product
	// does not have.

	const CWM = "2026-08-08T00:00:00.000Z";

	async function declareVariant(
		productId: string,
		variantKey: string,
		title: string,
		contentUpdatedAt: string = CWM,
	): Promise<JsonResponse> {
		return req(
			"PUT",
			`/products/${productId}/variants/${variantKey}`,
			{ title, contentUpdatedAt },
			{ "Idempotency-Key": `declare-${productId}-${variantKey}-${contentUpdatedAt}` },
		);
	}

	async function priceVariant(
		productId: string,
		variantKey: string,
		skuValue: string,
		amount: number,
		expectedUpdatedAt: string,
	): Promise<JsonResponse> {
		return req(
			"PATCH",
			`/products/${productId}/variants/${variantKey}`,
			{ sku: skuValue, price: { amount, currency: "USD" }, expectedUpdatedAt },
			{ "Idempotency-Key": `price-${productId}-${variantKey}` },
		);
	}

	/** Declare a size, price it, and stock it — the full "live sellable unit"
	 *  state a cart add is entitled to resolve against. */
	async function liveVariant(
		productId: string,
		variantKey: string,
		skuValue: string,
		amount: number,
		onHand: number,
	): Promise<void> {
		const declared = await declareVariant(productId, variantKey, variantKey);
		expect(declared.status).toBe(200);
		const priced = await priceVariant(
			productId,
			variantKey,
			skuValue,
			amount,
			declared.body.updatedAt as string,
		);
		expect(priced.status).toBe(200);
		// The edit seeds the sku's inventory row at zero; give it real units.
		await server.seed(skuValue, onHand);
	}

	// SECURITY (issue #80 review): the client supplies `sku` and `productId`
	// independently; the service must reconcile them against the trusted catalog
	// so a caller cannot pair product A's productId (from which checkout takes
	// price/title/entitlement) with product B's sku (a different good). When a
	// product_commerce row exists it is authoritative — its sku MUST equal the
	// submitted sku, else the add is rejected (SKU_MISMATCH) and never persisted.
	test("add with a productId/sku pair that DISAGREES with the catalog is rejected (SKU_MISMATCH), no line, un-orderable", async () => {
		await server.seedProduct({
			productId: "prod-cheap",
			sku: "SKU-CHEAP",
			priceCents: 100,
			title: "Cheap",
			kind: "physical",
			onHand: 10,
		});
		await server.seedProduct({
			productId: "prod-pricey",
			sku: "SKU-PRICEY",
			priceCents: 100000,
			title: "Pricey",
			kind: "physical",
			onHand: 10,
		});
		const cartId = await newCart();

		// Attack: product A's (cheap) productId paired with product B's (pricey) sku.
		const add = await addLineWithProduct(cartId, "SKU-PRICEY", "prod-cheap", 1, "k-mismatch");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "SKU_MISMATCH" });

		// The line was NOT persisted, so the cart cannot reach a priced checkout.
		const get = await req("GET", `/carts/${cartId}`);
		const cart = get.body.cart as { lines: unknown[] };
		expect(cart.lines).toHaveLength(0);

		const quote = await req("POST", "/checkout/quote", { cartId });
		expect(quote.status).toBe(409);
		expect(quote.body.reason).toBe("CART_EMPTY");
	});

	test("add with a MATCHING productId/sku pair is accepted and reflects productId on the line", async () => {
		await server.seedProduct({
			productId: "prod-match",
			sku: "SKU-MATCH",
			priceCents: 1500,
			title: "Match",
			kind: "physical",
			onHand: 10,
		});
		const cartId = await newCart();
		const add = await addLineWithProduct(cartId, "SKU-MATCH", "prod-match", 2, "k-match");
		expect(add.status).toBe(200);
		expect(add.body.ok).toBe(true);
		expect((add.body.line as Record<string, unknown>).productId).toBe("prod-match");
	});

	// -- The add endpoint's SKU guard ----------------------------------------
	// The rule, stated once: an add that names a product must RESOLVE its sku to
	// a live, priced sellable unit OF THAT PRODUCT — the product's own row, or
	// one of its live variants. Everything below is a case of that one sentence,
	// and each case is one an attacker or a stale client can actually send.

	test("a productId with NO commerce row no longer waves an arbitrary sku through", async () => {
		// Previously "harmless" — the line was unorderable, so it was allowed. It
		// is still unorderable, and it still reserves real stock against a sku the
		// named product has never been shown to own, so it is now refused.
		await server.seed("SKU-UNOWNED", 7);
		const cartId = await newCart();

		const add = await addLineWithProduct(cartId, "SKU-UNOWNED", "prod-never-synced", 3, "k-norow");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		// Nothing reserved: the guard runs before the domain's add, so a refusal
		// costs no units at all.
		expect(await server.onHand("SKU-UNOWNED")).toBe(7);
	});

	test("a soft-deleted product cannot lend its sku to a cart line", async () => {
		await server.seedProduct({
			productId: "prod-gone",
			sku: "SKU-GONE",
			priceCents: 900,
			title: "Gone",
			kind: "physical",
			onHand: 5,
		});
		const del = await req("DELETE", "/products/prod-gone/commerce", undefined, {
			"Idempotency-Key": "del-gone",
		});
		expect(del.status).toBe(200);

		const cartId = await newCart();
		const add = await addLineWithProduct(cartId, "SKU-GONE", "prod-gone", 1, "k-gone");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		expect(await server.onHand("SKU-GONE")).toBe(5);
	});

	test("a LIVE variant's sku is addable against its own product, and reserves the VARIANT's stock", async () => {
		await server.seedProduct({
			productId: "prod-tee",
			sku: "SKU-TEE",
			priceCents: 2000,
			title: "Tee",
			kind: "physical",
			onHand: 4,
		});
		await liveVariant("prod-tee", "large", "SKU-TEE-L", 2500, 6);
		const cartId = await newCart();

		const add = await addLineWithProduct(cartId, "SKU-TEE-L", "prod-tee", 2, "k-variant");
		expect(add.status).toBe(200);
		expect(add.body.ok).toBe(true);
		const line = add.body.line as Record<string, unknown>;
		expect(line.sku).toBe("SKU-TEE-L");
		expect(line.productId).toBe("prod-tee");
		// Stock moved on the SIZE, and the product's own sku was untouched: one
		// row per sellable unit is the whole point of the model.
		expect(await server.onHand("SKU-TEE-L")).toBe(4);
		expect(await server.onHand("SKU-TEE")).toBe(4);
	});

	test("one product cannot borrow ANOTHER product's variant sku", async () => {
		await server.seedProduct({
			productId: "prod-plain",
			sku: "SKU-PLAIN",
			priceCents: 500,
			title: "Plain",
			kind: "physical",
			onHand: 3,
		});
		await server.seedProduct({
			productId: "prod-fancy",
			sku: "SKU-FANCY",
			priceCents: 99000,
			title: "Fancy",
			kind: "physical",
			onHand: 3,
		});
		await liveVariant("prod-fancy", "xl", "SKU-FANCY-XL", 99000, 3);
		const cartId = await newCart();

		// The #80 attack, one level down: the cheap product's id paired with the
		// expensive product's SIZE.
		const add = await addLineWithProduct(cartId, "SKU-FANCY-XL", "prod-plain", 1, "k-crossvar");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		expect(await server.onHand("SKU-FANCY-XL")).toBe(3);
	});

	test("an ORPHANED variant's sku is dead to the cart, though the row keeps sku, price and stock", async () => {
		await server.seedProduct({
			productId: "prod-orph",
			sku: "SKU-ORPH",
			priceCents: 1000,
			title: "Orph",
			kind: "physical",
			onHand: 2,
		});
		await liveVariant("prod-orph", "small", "SKU-ORPH-S", 1200, 9);

		// The CMS dropped the repeater row. Deactivation, never deletion.
		const drop = await req(
			"POST",
			"/products/prod-orph/variants/small/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-orph-small" },
		);
		expect(drop.status).toBe(200);

		const cartId = await newCart();
		const add = await addLineWithProduct(cartId, "SKU-ORPH-S", "prod-orph", 1, "k-orphaned");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		// The units are retained — that is what "deactivate, never delete" means —
		// they are simply no longer sellable through this sku.
		expect(await server.onHand("SKU-ORPH-S")).toBe(9);

		const list = await req("GET", "/products/prod-orph/variants");
		const variants = list.body.variants as Array<Record<string, unknown>>;
		expect(variants).toHaveLength(1);
		expect(variants[0]?.orphanedAt).not.toBeNull();
		expect(variants[0]?.sku).toBe("SKU-ORPH-S");
		expect(variants[0]?.price).toEqual({ amount: 1200, currency: "USD" });
	});

	test("an UNPRICED variant fails legibly as unpriced — never a line priced at the row above it", async () => {
		await server.seedProduct({
			productId: "prod-unpriced",
			sku: "SKU-UP",
			priceCents: 100,
			title: "Unpriced parent",
			kind: "physical",
			onHand: 5,
		});
		// Declared and given a sku, but never priced: the state a resurrect leaves
		// behind when it clears a price whose currency no longer holds.
		const declared = await declareVariant("prod-unpriced", "medium", "Medium");
		expect(declared.status).toBe(200);
		const skued = await req(
			"PATCH",
			"/products/prod-unpriced/variants/medium",
			{ sku: "SKU-UP-M", expectedUpdatedAt: declared.body.updatedAt as string },
			{ "Idempotency-Key": "sku-only-medium" },
		);
		expect(skued.status).toBe(200);
		expect(skued.body.price).toBeNull();
		await server.seed("SKU-UP-M", 4);

		const cartId = await newCart();
		const add = await addLineWithProduct(cartId, "SKU-UP-M", "prod-unpriced", 1, "k-unpriced");
		expect(add.status).toBe(409);
		expect(add.body).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
		// Emphatically NOT charged the parent's 100: no line exists at all.
		expect(await server.onHand("SKU-UP-M")).toBe(4);
		const get = await req("GET", `/carts/${cartId}`);
		expect((get.body.cart as { lines: unknown[] }).lines).toHaveLength(0);
	});

	test("a REPLAYED rejected add is rejected identically — never half-applied on the retry", async () => {
		await server.seedProduct({
			productId: "prod-replay",
			sku: "SKU-REPLAY",
			priceCents: 700,
			title: "Replay",
			kind: "physical",
			onHand: 6,
		});
		await server.seed("SKU-ELSEWHERE", 6);
		const cartId = await newCart();

		const first = await addLineWithProduct(cartId, "SKU-ELSEWHERE", "prod-replay", 1, "k-replay");
		const replay = await addLineWithProduct(cartId, "SKU-ELSEWHERE", "prod-replay", 1, "k-replay");
		expect(first.status).toBe(409);
		expect(replay.status).toBe(first.status);
		expect(replay.body).toEqual(first.body);
		// The guard refuses BEFORE the idempotency key ever reaches the domain, so
		// there is no half-applied first attempt for the replay to complete.
		expect(await server.onHand("SKU-ELSEWHERE")).toBe(6);
		const get = await req("GET", `/carts/${cartId}`);
		expect((get.body.cart as { lines: unknown[] }).lines).toHaveLength(0);
	});

	// THE BARE-ADD RULE, pinned so the decision is a test rather than a memory.
	// An add that names NO product is left exactly as it was, and this is why:
	// `ProductCommerceStore` has no by-sku lookup — every read on it is keyed by
	// productId — so "which live sellable unit holds this sku" is a question the
	// guard cannot ask, and refusing every bare add would break the raw
	// reservation primitive without closing a spoof. It closes no spoof because
	// the line is UNORDERABLE BY CONSTRUCTION: both checkout paths reject a null
	// productId before they price anything, so it can confer neither a price nor
	// an entitlement. Closing the remainder honestly needs a by-sku resolver on
	// the port, and inventing one from the admin list's case-insensitive search
	// would resolve "sku-a" onto "SKU-A" and would not see variants at all.
	test("a BARE add still reserves, and is still unorderable — the line can confer no price", async () => {
		await server.seed("SKU-BARE", 5);
		const cartId = await newCart();

		const add = await addLine(cartId, "SKU-BARE", 2, "k-bare");
		expect(add.status).toBe(200);
		expect((add.body.line as Record<string, unknown>).productId).toBeNull();
		expect(await server.onHand("SKU-BARE")).toBe(3);

		const quote = await req("POST", "/checkout/quote", { cartId });
		expect(quote.status).toBe(409);
		expect(quote.body.reason).toBe("PRODUCT_NOT_PRICED");
	});

	test("POST /carts mints a cart id", async () => {
		const res = await req("POST", "/carts", { currency: "USD" });
		expect(res.status).toBe(201);
		expect(typeof res.body.cartId).toBe("string");
	});

	// Issue #136 (and #132's wire half): `serializeCart` is where these fields are
	// PRODUCED, and nothing downstream validates the cart body at runtime — the
	// plugin's `#cartResult` blind-casts once `isCartEnvelope` has seen an `ok`
	// key. So a silently dropped field compiles clean, arrives `undefined`, and
	// `isCartTerminal(undefined)` reads a terminal cart as live (#110, again,
	// with the whole suite green). Pin PRESENCE, not just the value: a bare
	// `toBeNull()` passes on an absent key too.
	test("GET /carts/:id emits BOTH `state` and `orderId` — presence is the assertion (#136/#132)", async () => {
		const cartId = await newCart();
		const get = await req("GET", `/carts/${cartId}`);
		expect(get.status).toBe(200);
		const cart = get.body.cart as Record<string, unknown>;
		expect(cart).toHaveProperty("state");
		expect(cart).toHaveProperty("orderId");
		expect(cart.state).toBe("active");
		// A cart that never checked out names no order. The non-null case lives in
		// `checkout-intent.http.pg.test.ts`, where an order actually exists.
		expect(cart.orderId).toBeNull();
	});

	test("add reserves stock and returns the line; GET reflects it", async () => {
		await server.seed("SKU-A", 5);
		const cartId = await newCart();
		const add = await addLine(cartId, "SKU-A", 2, "k-a");
		expect(add.status).toBe(200);
		expect(add.body.ok).toBe(true);
		expect(await server.onHand("SKU-A")).toBe(3);

		const get = await req("GET", `/carts/${cartId}`);
		expect(get.status).toBe(200);
		const cart = get.body.cart as { lines: Array<Record<string, unknown>> };
		expect(cart.lines).toHaveLength(1);
		expect(cart.lines[0]?.qty).toBe(2);
		// A cart line snapshots no price (Phase 3).
		expect(cart.lines[0]).not.toHaveProperty("price");
		expect(cart.lines[0]).not.toHaveProperty("unitPriceCents");
	});

	test("add beyond stock is a 200 typed OUT_OF_STOCK body, no line", async () => {
		await server.seed("SKU-B", 1);
		const cartId = await newCart();
		const add = await addLine(cartId, "SKU-B", 5, "k-b");
		expect(add.status).toBe(200);
		expect(add.body).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(await server.onHand("SKU-B")).toBe(1);
		const get = await req("GET", `/carts/${cartId}`);
		expect((get.body.cart as { lines: unknown[] }).lines).toHaveLength(0);
	});

	test("add is idempotent under a replayed Idempotency-Key (one decrement)", async () => {
		await server.seed("SKU-C", 5);
		const cartId = await newCart();
		const first = await addLine(cartId, "SKU-C", 2, "k-c");
		const replay = await addLine(cartId, "SKU-C", 2, "k-c");
		expect(first.body).toEqual(replay.body);
		expect(await server.onHand("SKU-C")).toBe(3);
	});

	test("PATCH increases via delta-reserve; decreases partial-release", async () => {
		await server.seed("SKU-D", 5);
		const cartId = await newCart();
		const add = await addLine(cartId, "SKU-D", 2, "k-d1");
		const lineId = (add.body.line as { lineId: string }).lineId;

		const up = await req(
			"PATCH",
			`/carts/${cartId}/lines/${lineId}`,
			{ qty: 4 },
			{ "Idempotency-Key": "k-d2" },
		);
		expect(up.status).toBe(200);
		expect(await server.onHand("SKU-D")).toBe(1);

		const down = await req(
			"PATCH",
			`/carts/${cartId}/lines/${lineId}`,
			{ qty: 1 },
			{ "Idempotency-Key": "k-d3" },
		);
		expect(down.status).toBe(200);
		expect(await server.onHand("SKU-D")).toBe(4);
	});

	test("PATCH increase beyond stock is a 200 typed OUT_OF_STOCK, line unchanged", async () => {
		await server.seed("SKU-E", 3);
		const cartId = await newCart();
		const add = await addLine(cartId, "SKU-E", 2, "k-e1");
		const lineId = (add.body.line as { lineId: string }).lineId;
		const up = await req(
			"PATCH",
			`/carts/${cartId}/lines/${lineId}`,
			{ qty: 5 },
			{ "Idempotency-Key": "k-e2" },
		);
		expect(up.status).toBe(200);
		expect(up.body).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(await server.onHand("SKU-E")).toBe(1);
	});

	test("DELETE releases the whole reservation; double-delete is a no-op", async () => {
		await server.seed("SKU-F", 5);
		const cartId = await newCart();
		const add = await addLine(cartId, "SKU-F", 2, "k-f1");
		const lineId = (add.body.line as { lineId: string }).lineId;

		const del = await req("DELETE", `/carts/${cartId}/lines/${lineId}`, undefined, {
			"Idempotency-Key": "k-f2",
		});
		expect(del.status).toBe(200);
		expect(await server.onHand("SKU-F")).toBe(5);

		const again = await req("DELETE", `/carts/${cartId}/lines/${lineId}`, undefined, {
			"Idempotency-Key": "k-f3",
		});
		expect(again.status).toBe(200);
		expect(await server.onHand("SKU-F")).toBe(5);
	});

	test("GET on an expired hold lazily releases it (stock returns)", async () => {
		await server.seed("SKU-G", 5);
		const cartId = await newCart();
		await addLine(cartId, "SKU-G", 2, "k-g");
		expect(await server.onHand("SKU-G")).toBe(3);

		server.advance(16 * 60 * 1000);
		const get = await req("GET", `/carts/${cartId}`);
		expect((get.body.cart as { lines: unknown[] }).lines).toHaveLength(0);
		expect(await server.onHand("SKU-G")).toBe(5);
	});

	test("GET on an unknown cart is 404; add missing Idempotency-Key is 400", async () => {
		const notFound = await req("GET", "/carts/does-not-exist");
		expect(notFound.status).toBe(404);
		expect(notFound.body).toEqual({ ok: false, reason: "CART_NOT_FOUND" });

		const cartId = await newCart();
		const noKey = await req("POST", `/carts/${cartId}/lines`, { sku: "SKU-A", qty: 1 });
		expect(noKey.status).toBe(400);
	});
});
