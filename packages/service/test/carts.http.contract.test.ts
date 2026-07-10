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

	test("POST /carts mints a cart id", async () => {
		const res = await req("POST", "/carts", { currency: "USD" });
		expect(res.status).toBe(201);
		expect(typeof res.body.cartId).toBe("string");
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
