import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin order timeline HTTP contract (admin-UX Increment 1, timeline slice):
// wire ⇄ use-case fidelity for GET /admin/orders/:id/timeline against a LIVE
// server backed by Postgres. State changes are driven through the REAL admin
// transition + fulfillment endpoints (so the state-change audit is genuinely
// written inside each guarded flip), a note is appended, and the merged
// chronological timeline is asserted. Guards: internal-token (401 without),
// unknown order (404). A directly-seeded order (no events) proves the
// graceful-degradation path (`stateChangesAudited:false`, partial timeline).

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin order timeline HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function authed(extra: Record<string, string> = {}): Record<string, string> {
		return { "X-Internal-Token": token, "Content-Type": "application/json", ...extra };
	}

	function getTimeline(orderId: string, opts: { token?: string } = { token }): Promise<Response> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/timeline`, { headers });
	}

	test("merges driven state changes, fulfillment, and a note into one chronological timeline", async () => {
		// A paid order, then advance the clock between each write so entries get
		// distinct timestamps (chronological order, not just the id tie-break).
		await server.seedOrder({
			id: "ord-tl",
			state: "paid",
			currency: "USD",
			buyerRef: "buyer@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1500,
		});
		server.advance(60_000);
		const toProcessing = await fetch(`${server.baseUrl}/admin/orders/ord-tl/transition`, {
			method: "POST",
			headers: authed({ "Idempotency-Key": "k-proc" }),
			body: JSON.stringify({ toState: "processing" }),
		});
		expect(toProcessing.status).toBe(200);
		server.advance(60_000);
		const ship = await fetch(`${server.baseUrl}/admin/orders/ord-tl/fulfillment`, {
			method: "POST",
			headers: authed({ "Idempotency-Key": "k-ship" }),
			body: JSON.stringify({ carrier: "UPS", trackingNumber: "1Z-9", recordedBy: "ops@shop" }),
		});
		expect(ship.status).toBe(200);
		server.advance(60_000);
		const note = await fetch(`${server.baseUrl}/admin/orders/ord-tl/notes`, {
			method: "POST",
			headers: authed({ "Idempotency-Key": "k-note" }),
			body: JSON.stringify({ author: "ops", body: "packed and shipped" }),
		});
		expect(note.status).toBe(201);

		const body = await json(await getTimeline("ord-tl"));
		expect(body.ok).toBe(true);
		const timeline = body.timeline as {
			stateChangesAudited: boolean;
			entries: Array<Record<string, unknown>>;
		};
		expect(timeline.stateChangesAudited).toBe(true);
		expect(timeline.entries.map((e) => e.kind)).toEqual([
			"created",
			"state_change", // paid → processing
			"state_change", // processing → shipped
			"fulfillment", // the tracking detail, same instant as the shipped flip
			"note",
		]);
		// The shipped flip carries the recorder as actor; the fulfillment detail
		// carries the tracking.
		expect(timeline.entries[2]).toMatchObject({
			kind: "state_change",
			fromState: "processing",
			toState: "shipped",
			actor: "ops@shop",
		});
		expect(timeline.entries[3]).toMatchObject({
			kind: "fulfillment",
			carrier: "UPS",
			trackingNumber: "1Z-9",
		});
		expect(timeline.entries[4]).toMatchObject({
			kind: "note",
			author: "ops",
			body: "packed and shipped",
		});
	});

	test("a directly-seeded order (no events) degrades to a partial timeline", async () => {
		await server.seedOrder({
			id: "ord-hist",
			state: "paid",
			currency: "USD",
			buyerRef: "buyer@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 500,
		});
		const body = await json(await getTimeline("ord-hist"));
		expect(body.ok).toBe(true);
		const timeline = body.timeline as { stateChangesAudited: boolean; entries: unknown[] };
		// No state_change events were ever recorded for this order — but its creation
		// still anchors the timeline (a useful partial history).
		expect(timeline.stateChangesAudited).toBe(false);
		expect((timeline.entries as Array<{ kind: string }>).map((e) => e.kind)).toEqual(["created"]);
	});

	test("unknown order → 404 ORDER_NOT_FOUND", async () => {
		const res = await getTimeline("does-not-exist");
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401 (the audit read is admin-only)", async () => {
		await server.seedOrder({
			id: "ord-guarded",
			state: "paid",
			currency: "USD",
			buyerRef: "buyer@example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
			totalCents: 100,
		});
		expect((await getTimeline("ord-guarded", {})).status).toBe(401);
	});
});
