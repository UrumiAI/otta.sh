import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

interface JsonResponse {
	status: number;
	body: Record<string, unknown>;
}

describe.skipIf(PG === undefined)("HTTP inventory contract [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function post(
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	function reserve(sku: string, qty: number, key: string): Promise<JsonResponse> {
		return post("/inventory/reserve", { sku, qty }, { "Idempotency-Key": key });
	}

	test("reserve within stock returns 200 { ok: true, reservationId }", async () => {
		await server.seed("SKU-1", 5);
		const res = await reserve("SKU-1", 2, "k1");
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(typeof res.body.reservationId).toBe("string");
		expect(await server.onHand("SKU-1")).toBe(3);
	});

	test("reserve beyond stock returns 200 { ok: false, reason: OUT_OF_STOCK } — no status-code-as-logic", async () => {
		await server.seed("SKU-2", 1);
		const res = await reserve("SKU-2", 5, "k2");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(await server.onHand("SKU-2")).toBe(1);
	});

	test("replay with the same Idempotency-Key returns the same reservationId and decrements once", async () => {
		await server.seed("SKU-3", 5);
		const first = await reserve("SKU-3", 2, "k3");
		const replay = await reserve("SKU-3", 2, "k3");
		expect(first.body.ok).toBe(true);
		expect(replay.body).toEqual(first.body);
		expect(await server.onHand("SKU-3")).toBe(3);
	});

	test("commit finalizes the hold; release returns stock", async () => {
		await server.seed("SKU-4", 5);
		const a = await reserve("SKU-4", 2, "k4a");
		const b = await reserve("SKU-4", 1, "k4b");
		expect(await server.onHand("SKU-4")).toBe(2);

		const commit = await post("/inventory/commit", { reservationId: a.body.reservationId });
		expect(commit.status).toBe(200);
		expect(await server.onHand("SKU-4")).toBe(2); // commit does not restock

		const release = await post("/inventory/release", { reservationId: b.body.reservationId });
		expect(release.status).toBe(200);
		expect(await server.onHand("SKU-4")).toBe(3); // release returns the held stock
	});

	test("schema-invalid body returns 400", async () => {
		const res = await post("/inventory/reserve", { sku: "", qty: -1 }, { "Idempotency-Key": "kx" });
		expect(res.status).toBe(400);
	});

	test("missing Idempotency-Key header returns 400", async () => {
		const res = await post("/inventory/reserve", { sku: "SKU-1", qty: 1 });
		expect(res.status).toBe(400);
	});
});
