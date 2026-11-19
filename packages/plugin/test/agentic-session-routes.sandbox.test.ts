/**
 * ADR-0047 — the agentic session routes under the REAL workerd sandbox, against
 * the real document store: NOT_FOUND while the store has not opted in; with it on,
 * create / get / update / complete / cancel, the typed messages for refused lines
 * and a refused coupon, idempotent replay, and the trusted network key.
 */
import {
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	collectionOf,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AGENTIC_ROUTES } from "../src/agentic/routes.js";
import {
	AGENT_ADDRESS,
	agenticFixture,
	call,
	saveAgentic,
	seedAgenticStore,
} from "./helpers/agentic-sandbox.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const F = agenticFixture("asr");
const [MUG, BOWL] = F.products;

let handle: SandboxHandle;
let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await storageBridge());
	handle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
	await seedAgenticStore(storage, F);
}, 300_000);

afterAll(async () => {
	await handle?.close();
});

function body(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		idempotencyKey: key,
		lines: [
			{ productId: MUG.id, quantity: 2 },
			{ productId: BOWL.id, sku: BOWL.sku, quantity: 1 },
		],
		destination: AGENT_ADDRESS,
		shippingMethodId: F.methodId,
		...extra,
	};
}

describe("agentic routes, switched off (the default)", () => {
	test("every route answers NOT_FOUND and writes nothing", async () => {
		const sessions = collectionOf(storage, AGENT_SESSIONS_COLLECTION);
		const before = await sessions.count({});
		for (const route of AGENTIC_ROUTES) {
			expect(await call(handle, route, body("off-1")), route).toEqual({
				ok: false,
				error: "NOT_FOUND",
			});
		}
		expect(await sessions.count({})).toBe(before);
	});
});

describe("agentic routes, switched on", () => {
	beforeAll(async () => {
		await saveAgentic(handle, true);
	});
	afterAll(async () => {
		await saveAgentic(handle, false);
	});

	test("status says so", async () => {
		expect(await call(handle, "agentic/status", {})).toEqual({ ok: true, enabled: true });
	});

	test("create: a cart built and quoted by the store's own code; secrets once; never the cart id", async () => {
		const created = await call(handle, "agentic/session/create", body("create-1"));
		expect(created).toMatchObject({ ok: true, noStore: true, replayed: false, messages: [] });
		const session = created["session"] as Record<string, unknown>;
		expect(session).toMatchObject({
			status: "requires_escalation",
			currency: "USD",
			lines: [
				{ productId: MUG.id, sku: MUG.sku, quantity: 2 },
				{ productId: BOWL.id, sku: BOWL.sku, quantity: 1 },
			],
			shippingMethodId: F.methodId,
			handedOff: false,
		});
		expect(session).not.toHaveProperty("cartId");
		// 2 × 15.00 + 22.50 = 52.50; shipping 5.99; 10% tax on both = 5.85.
		expect(session["quote"]).toMatchObject({
			currency: "USD",
			subtotal: 5250,
			discount: 0,
			fulfillment: 599,
			tax: 585,
			total: 6434,
		});
		expect(created["orderSecret"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(created["handoffToken"]).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// The same key and body replays the same answer, secret and link included.
		const replay = await call(handle, "agentic/session/create", body("create-1"));
		expect(replay).toMatchObject({ ok: true, replayed: true });
		expect((replay["session"] as { id: string }).id).toBe(session["id"]);
		expect(replay["orderSecret"]).toBe(created["orderSecret"]);
		// A different body under the key is refused.
		expect(
			await call(handle, "agentic/session/create", body("create-1", { couponCode: "OTHER" })),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
	});

	test("refused lines and a refused coupon are typed messages; the quote is made without them", async () => {
		const created = await call(handle, "agentic/session/create", {
			idempotencyKey: "create-msgs",
			lines: [
				{ productId: MUG.id, quantity: 1 },
				{ productId: "prod-asr-missing", quantity: 1 },
				{ productId: BOWL.id, sku: "SKU-WRONG", quantity: 1 },
			],
			couponCode: "NO-SUCH-CODE",
		});
		expect(created["ok"]).toBe(true);
		expect(created["messages"]).toEqual([
			{ code: "PRODUCT_UNAVAILABLE", path: "lines[1]" },
			{ code: "SKU_MISMATCH", path: "lines[2]" },
			{ code: "COUPON_NOT_FOUND", path: "couponCode" },
		]);
		const session = created["session"] as Record<string, unknown>;
		expect(session["lines"]).toEqual([{ productId: MUG.id, sku: MUG.sku, quantity: 1 }]);
		// No destination: shipping and tax are not calculated, so there is no total.
		expect(session["quote"]).toMatchObject({
			subtotal: 1500,
			fulfillment: null,
			tax: null,
			total: null,
		});
	});

	test("the network key is the request's, never the body's: no client address is UNAVAILABLE", async () => {
		expect(
			await call(handle, "agentic/session/create", body("create-nonet"), { headers: {} }),
		).toEqual({ ok: false, error: "UNAVAILABLE" });
		expect(await call(handle, "agentic/session/create", { idempotencyKey: "" })).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
	});

	test("get answers the session and its live link (no-store); an unknown id is SESSION_NOT_FOUND", async () => {
		const created = await call(handle, "agentic/session/create", body("create-get"));
		const id = (created["session"] as { id: string }).id;
		const got = await call(handle, "agentic/session/get", { sessionId: id });
		expect(got).toMatchObject({ ok: true, noStore: true, handoffToken: created["handoffToken"] });
		expect((got["session"] as { id: string }).id).toBe(id);
		expect(
			await call(handle, "agentic/session/get", { sessionId: "cs_AAAAAAAAAAAAAAAAAAAAAA" }),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
	});

	test("update replaces the content and re-quotes; complete answers the link; cancel ends it", async () => {
		const created = await call(handle, "agentic/session/create", body("create-upd"));
		const id = (created["session"] as { id: string }).id;
		const updated = await call(handle, "agentic/session/update", {
			sessionId: id,
			...body("update-1", {
				lines: [{ productId: BOWL.id, quantity: 2 }],
				couponCode: F.couponCode,
			}),
		});
		expect(updated).toMatchObject({ ok: true, replayed: false, messages: [] });
		// 2 × 22.50 = 45.00 − 5.00 + 5.99 shipping; 10% tax on 40.00 + 5.99 = 4.60.
		expect((updated["session"] as Record<string, unknown>)["quote"]).toMatchObject({
			subtotal: 4500,
			discount: 500,
			fulfillment: 599,
			tax: 460,
			total: 5059,
		});
		const completed = await call(handle, "agentic/session/complete", {
			sessionId: id,
			idempotencyKey: "complete-1",
		});
		expect(completed).toMatchObject({ ok: true, handoffToken: created["handoffToken"] });

		const canceled = await call(handle, "agentic/session/cancel", {
			sessionId: id,
			idempotencyKey: "cancel-1",
		});
		expect((canceled["session"] as { status: string }).status).toBe("canceled");
		// The link is dead: redeeming it is refused and writes nothing.
		const links = collectionOf(storage, AGENT_SESSION_LINKS_COLLECTION);
		const linkCount = await links.count({});
		expect(
			await call(handle, "agentic/handoff/redeem", { token: created["handoffToken"] }),
		).toEqual({ ok: false, reason: "HANDOFF_CANCELED" });
		expect(await links.count({})).toBe(linkCount);
		expect(
			await call(handle, "agentic/session/update", { sessionId: id, ...body("update-2") }),
		).toEqual({ ok: false, reason: "SESSION_CLOSED" });
	});
});
