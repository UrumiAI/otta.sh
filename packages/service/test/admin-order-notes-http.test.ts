import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin order-notes HTTP contract (admin-UX Increment 0): wire ⇄ port fidelity
// for POST/GET /admin/orders/:id/notes against a LIVE server backed by Postgres.
// Append-only; server clock is advanced between appends so created_at ordering is
// exercised (not just the id tie-break). Guards: internal-token (both verbs),
// the X-Service-Token write gate (POST only), validation (empty body → 400),
// unknown order (→ 404), and idempotent replay via Idempotency-Key.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin order notes HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		await server.seedOrder({
			id: "ord-1",
			state: "paid",
			currency: "USD",
			buyerRef: "alice@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1000,
		});
	});
	afterEach(async () => {
		await server.stop();
	});

	function getNotes(orderId: string, opts: { token?: string } = { token }): Promise<Response> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/notes`, { headers });
	}

	function postNote(
		orderId: string,
		body: { author?: string; body?: string },
		opts: { token?: string | null; idempotencyKey?: string; serviceToken?: string } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const tk = opts.token === undefined ? token : opts.token;
		if (tk !== null) headers["X-Internal-Token"] = tk;
		if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
		if (opts.serviceToken !== undefined) headers["X-Service-Token"] = opts.serviceToken;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/notes`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	test("POST appends a note (201, appended:true) and GET lists it", async () => {
		const res = await postNote("ord-1", { author: "alice", body: "gift wrap please" });
		expect(res.status).toBe(201);
		const posted = await json(res);
		expect(posted.appended).toBe(true);
		const note = posted.note as Record<string, unknown>;
		expect(note).toMatchObject({ orderId: "ord-1", author: "alice", body: "gift wrap please" });
		expect(typeof note.id).toBe("string");
		expect(note.createdAt).toBe("2026-07-10T00:00:00.000Z");

		const listed = await json(await getNotes("ord-1"));
		expect(listed.ok).toBe(true);
		const notes = listed.notes as Array<Record<string, unknown>>;
		expect(notes.map((n) => n.body)).toEqual(["gift wrap please"]);
	});

	test("GET lists notes in append order (chronological, server clock advanced between appends)", async () => {
		await postNote("ord-1", { author: "a", body: "first" });
		server.advance(1000);
		await postNote("ord-1", { author: "b", body: "second" });
		server.advance(1000);
		await postNote("ord-1", { author: "c", body: "third" });
		const notes = (await json(await getNotes("ord-1"))).notes as Array<Record<string, unknown>>;
		expect(notes.map((n) => n.body)).toEqual(["first", "second", "third"]);
	});

	test("trims author + body server-side (domain validation)", async () => {
		const posted = await json(
			await postNote("ord-1", { author: "  bob  ", body: "  call back  " }),
		);
		expect((posted.note as Record<string, unknown>).author).toBe("bob");
		expect((posted.note as Record<string, unknown>).body).toBe("call back");
	});

	test("replay with the same Idempotency-Key appends once (appended:false, list stays length 1)", async () => {
		const first = await json(
			await postNote("ord-1", { author: "alice", body: "once" }, { idempotencyKey: "note-key-1" }),
		);
		expect(first.appended).toBe(true);
		const replay = await json(
			await postNote(
				"ord-1",
				{ author: "alice", body: "a different body ignored" },
				{ idempotencyKey: "note-key-1" },
			),
		);
		expect(replay.appended).toBe(false);
		expect((replay.note as Record<string, unknown>).id).toBe(
			(first.note as Record<string, unknown>).id,
		);
		const notes = (await json(await getNotes("ord-1"))).notes as unknown[];
		expect(notes).toHaveLength(1);
	});

	test("empty body → 400 (domain rejects a blank note)", async () => {
		const res = await postNote("ord-1", { author: "alice", body: "   " });
		expect(res.status).toBe(400);
	});

	test("note on an unknown order → 404", async () => {
		const res = await postNote("does-not-exist", { author: "alice", body: "hi" });
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401 on both GET and POST", async () => {
		expect((await getNotes("ord-1", {})).status).toBe(401);
		expect((await postNote("ord-1", { author: "a", body: "b" }, { token: null })).status).toBe(401);
	});

	test("write gate: with a service token set, POST needs X-Service-Token (401 without, 201 with)", async () => {
		const gated = await startTestServer({ serviceToken: "svc-secret" });
		try {
			const gatedToken = gated.internalToken as string;
			await gated.seedOrder({
				id: "ord-g",
				state: "paid",
				currency: "USD",
				buyerRef: "g@example.com",
				createdAt: "2026-07-10T00:00:00.000Z",
				totalCents: 500,
			});
			const common = { "content-type": "application/json", "X-Internal-Token": gatedToken };
			// Missing X-Service-Token ⇒ blocked by the write gate.
			const blocked = await fetch(`${gated.baseUrl}/admin/orders/ord-g/notes`, {
				method: "POST",
				headers: common,
				body: JSON.stringify({ author: "a", body: "b" }),
			});
			expect(blocked.status).toBe(401);
			// With the service token ⇒ appends.
			const ok = await fetch(`${gated.baseUrl}/admin/orders/ord-g/notes`, {
				method: "POST",
				headers: { ...common, "X-Service-Token": "svc-secret" },
				body: JSON.stringify({ author: "a", body: "b" }),
			});
			expect(ok.status).toBe(201);
			// GET is a read — gate-exempt, so it works with only the internal token.
			const listed = await fetch(`${gated.baseUrl}/admin/orders/ord-g/notes`, {
				headers: { "X-Internal-Token": gatedToken },
			});
			expect(listed.status).toBe(200);
		} finally {
			await gated.stop();
		}
	});
});
