import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Orders console under the REAL workerd-on-Node sandbox: page_load
// renders the list (forwarding the kv-sourced admin token), the filter form and
// keyset "Load more" re-list, opening an order renders the detail with the
// service-supplied transition buttons, a transition button POSTs the transition
// with an Idempotency-Key + token, and every failure fails CLOSED to a generic
// banner (no raw status/URL leak).

const ORDER_1 = {
	id: "ord-1",
	state: "paid",
	currency: "USD",
	paymentMethod: "stripe",
	buyerRef: "alice@example.com",
	customerId: "cust-a",
	holdExpiresAt: "2026-07-10T00:15:00.000Z",
	createdAt: "2026-07-10T01:00:00.000Z",
	reconciliationFlag: null,
	reconciliationResolution: null,
	fulfillment: null,
	cancellation: null,
	// ADR-0009: the immutable ship-to snapshot captured at checkout.
	shippingAddress: {
		name: "Alice Example",
		line1: "500 Shipping Ln",
		line2: null,
		city: "Portland",
		region: "OR",
		postalCode: "97201",
		country: "US",
		email: "alice@example.com",
		phone: null,
	},
	totals: {
		currency: "USD",
		subtotalCents: 1500,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 0,
		totalCents: 1500,
		appliedCouponCode: null,
		shippingZoneId: "zone-domestic",
	},
	lines: [
		{
			sku: "SKU-1",
			title: "Widget",
			unitPriceCents: 500,
			currency: "USD",
			quantity: 3,
			fulfillmentKind: "physical",
		},
	],
};

// A flagged order (settle lost a hold) awaiting manual reconciliation.
const ORDER_FLAGGED = {
	...ORDER_1,
	id: "ord-flagged",
	reconciliationFlag: "commit lost for reservation res-1",
	reconciliationResolution: null,
};

// An already-resolved order: flag cleared, disposition on file.
const ORDER_RESOLVED = {
	...ORDER_1,
	id: "ord-resolved",
	reconciliationFlag: null,
	reconciliationResolution: {
		outcome: "fulfilled",
		reason: "re-sourced from warehouse B",
		resolvedBy: "ops@shop.test",
		resolvedAt: "2026-07-10T02:00:00.000Z",
	},
};

const SUMMARY_1 = {
	id: "ord-1",
	state: "paid",
	currency: "USD",
	buyerRef: "alice@example.com",
	customerId: "cust-a",
	paymentMethod: "stripe",
	createdAt: "2026-07-10T01:00:00.000Z",
	totalCents: 1500,
	reconciliationFlag: false,
};
const NOTES = [
	{
		id: "note-1",
		orderId: "ord-1",
		author: "alice",
		body: "Customer asked to gift-wrap.",
		createdAt: "2026-07-10T01:05:00.000Z",
	},
	{
		id: "note-2",
		orderId: "ord-1",
		author: "bob",
		body: "Called the customer back.",
		createdAt: "2026-07-10T01:30:00.000Z",
	},
];

// A merged timeline for ord-1: creation, a status change, a note, and a
// fulfillment — the read-only audit surface (admin-UX Increment 1).
const TIMELINE_ORD_1 = {
	orderId: "ord-1",
	stateChangesAudited: true,
	entries: [
		{ kind: "created", at: "2026-07-10T01:00:00.000Z" },
		{
			kind: "state_change",
			at: "2026-07-10T01:10:00.000Z",
			fromState: "pending",
			toState: "paid",
			actor: null,
		},
		{
			kind: "note",
			at: "2026-07-10T01:30:00.000Z",
			author: "bob",
			body: "Called the customer back.",
		},
		{
			kind: "fulfillment",
			at: "2026-07-11T09:00:01.000Z",
			carrier: "UPS",
			trackingNumber: "1Z-999",
			trackingUrl: "https://track/1Z-999",
			shippedAt: "2026-07-11T09:00:00.000Z",
			recordedBy: "ops@shop.test",
		},
	],
};

// A historical order whose transitions predate the audit table — only creation.
const TIMELINE_DEGRADED = {
	orderId: "ord-proc",
	stateChangesAudited: false,
	entries: [{ kind: "created", at: "2026-07-10T01:00:00.000Z" }],
};

const SUMMARY_2 = {
	id: "ord-2",
	state: "shipped",
	currency: "USD",
	buyerRef: "bob@example.com",
	customerId: null,
	paymentMethod: "x402",
	createdAt: "2026-07-11T01:00:00.000Z",
	totalCents: 2000,
	reconciliationFlag: false,
};

// A guest order (no account) and an order whose customer-context read fails.
const ORDER_GUEST = { ...ORDER_1, id: "ord-guest", customerId: null };
// ADR-0009: an order with NO captured ship-to (historical / digital-only) — the
// section renders the honest "no ship-to on file" note, never the profile book.
const ORDER_NO_ADDR = {
	...ORDER_1,
	id: "ord-no-addr",
	shippingAddress: null,
	totals: { ...ORDER_1.totals, shippingZoneId: null },
};
const ORDER_CTX_FAIL = { ...ORDER_1, id: "ord-ctx-fail" };

// A processing order (ready to ship) and a shipped order that already has tracking
// recorded (admin-UX Increment 1 — fulfillment).
const ORDER_PROCESSING = { ...ORDER_1, id: "ord-proc", state: "processing", fulfillment: null };
const ORDER_SHIPPED = {
	...ORDER_1,
	id: "ord-shipped",
	state: "shipped",
	fulfillment: {
		carrier: "UPS",
		trackingNumber: "1Z-999",
		trackingUrl: "https://track/1Z-999",
		shippedAt: "2026-07-11T09:00:00.000Z",
		recordedBy: "ops@shop.test",
		recordedAt: "2026-07-11T09:00:01.000Z",
	},
};

// A cancelled order WITH a recorded reason, and one cancelled via the bare
// transition (no reason on file) — admin-UX Increment 1, "cancel with reason".
const ORDER_CANCELLED = {
	...ORDER_1,
	id: "ord-cancelled",
	state: "cancelled",
	cancellation: {
		reason: "out_of_stock",
		detail: "last unit sold on another channel",
		cancelledBy: "ops@shop.test",
		cancelledAt: "2026-07-11T09:00:01.000Z",
	},
};
const ORDER_CANCELLED_NO_REASON = {
	...ORDER_1,
	id: "ord-cancelled-bare",
	state: "cancelled",
	cancellation: null,
};

/** Customer context for ord-1: a claimed account with an address, a session,
 *  and one other order. TOKEN-FREE by construction (the wire shape has no
 *  credential field). */
const CUSTOMER_CONTEXT_LINKED = {
	identity: {
		customerId: "cust-a",
		buyerRef: "alice@example.com",
		email: "alice@example.com",
		displayName: "Alice Example",
		emailVerifiedAt: "2026-07-09T00:00:00.000Z",
		linkage: "claimed",
	},
	addresses: [
		{
			id: "addr-1",
			kind: "shipping",
			name: "Alice Example",
			line1: "1 Main St",
			line2: null,
			city: "Springfield",
			region: null,
			postalCode: "12345",
			country: "US",
			isDefault: true,
			createdAt: "2026-07-09T00:00:00.000Z",
		},
	],
	sessions: [
		{
			id: "sess-1",
			createdAt: "2026-07-09T00:00:00.000Z",
			expiresAt: "2026-08-08T00:00:00.000Z",
			revokedAt: null,
		},
	],
	orderCount: 3,
	recentOrders: [SUMMARY_2],
};

/** Customer context for a true guest: no account, nothing to list. */
const CUSTOMER_CONTEXT_GUEST = {
	identity: {
		customerId: null,
		buyerRef: "alice@example.com",
		email: null,
		displayName: null,
		emailVerifiedAt: null,
		linkage: "guest",
	},
	addresses: [],
	sessions: [],
	orderCount: 1,
	recentOrders: [],
};

/** A GET responder for the guarded list + detail reads (200 only WITH the admin
 *  token, else 401 — mirroring the service guard). Distinguishes list vs detail
 *  by path, and page1 vs page2 by the `cursor=` query param. */
function makeGetResponder() {
	return (req: {
		url: string;
		headers: Record<string, string | string[] | undefined>;
	}): { status: number; body: unknown } => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const [path, query = ""] = req.url.split("?");
		if (path === "/admin/orders") {
			if (query.includes("cursor=")) {
				// Page 2 (the cursor page): the remainder, no further pages.
				return { status: 200, body: { ok: true, orders: [SUMMARY_2], nextCursor: null } };
			}
			return {
				status: 200,
				body: { ok: true, orders: [SUMMARY_1, SUMMARY_2], nextCursor: "svc-cursor-1" },
			};
		}
		// Order notes read (append order) — must be checked BEFORE the detail branch.
		if (path?.endsWith("/notes")) {
			return { status: 200, body: { ok: true, notes: NOTES } };
		}
		// Order timeline read — also BEFORE the detail branch.
		if (path?.endsWith("/timeline")) {
			const timeline = path.includes("/ord-proc") ? TIMELINE_DEGRADED : TIMELINE_ORD_1;
			return { status: 200, body: { ok: true, timeline } };
		}
		// Customer context read — also BEFORE the detail branch.
		if (path?.endsWith("/customer-context")) {
			if (path.includes("/ord-ctx-fail")) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			if (path.includes("/ord-guest")) {
				return { status: 200, body: { ok: true, context: CUSTOMER_CONTEXT_GUEST } };
			}
			return { status: 200, body: { ok: true, context: CUSTOMER_CONTEXT_LINKED } };
		}
		if (path?.startsWith("/admin/orders/")) {
			const order = path.includes("/ord-no-addr")
				? ORDER_NO_ADDR
				: path.includes("/ord-flagged")
					? ORDER_FLAGGED
					: path.includes("/ord-resolved")
						? ORDER_RESOLVED
						: path.includes("/ord-guest")
							? ORDER_GUEST
							: path.includes("/ord-ctx-fail")
								? ORDER_CTX_FAIL
								: path.includes("/ord-proc")
									? ORDER_PROCESSING
									: path.includes("/ord-shipped")
										? ORDER_SHIPPED
										: path.includes("/ord-cancelled-bare")
											? ORDER_CANCELLED_NO_REASON
											: path.includes("/ord-cancelled")
												? ORDER_CANCELLED
												: ORDER_1;
			// State-appropriate transitions, as the real service derives them from the
			// domain state machine: a processing order's legal targets INCLUDE the bare
			// `shipped` — the PLUGIN is what must steer it away (PR #63 review); a
			// cancelled order (either fixture) is TERMINAL — no legal transitions.
			const allowedTransitions =
				order.state === "cancelled"
					? []
					: order.state === "processing"
						? ["shipped", "cancelled", "refunded"]
						: ["processing", "completed", "cancelled", "refunded"];
			return { status: 200, body: { ok: true, order, allowedTransitions } };
		}
		return { status: 404, body: { error: "unknown" } };
	};
}

function makePostResponder() {
	return (req: {
		url: string;
		headers: Record<string, string | string[] | undefined>;
		body: unknown;
	}): { status: number; body: unknown } => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		if (req.url.includes("/notes")) {
			const b = req.body as { author?: string; body?: string } | undefined;
			return {
				status: 201,
				body: {
					ok: true,
					appended: true,
					note: {
						id: "note-new",
						orderId: "ord-1",
						author: b?.author ?? "",
						body: b?.body ?? "",
						createdAt: "2026-07-10T02:00:00.000Z",
					},
				},
			};
		}
		if (req.url.includes("/resolve-reconciliation")) {
			const b = req.body as
				| { expectedFlag?: string; outcome?: string; reason?: string; resolvedBy?: string }
				| undefined;
			// Compare-and-clear, mirroring the service: a stale expectedFlag (≠ the
			// live flag) is a 409 conflict — never a blind clear.
			if (b?.expectedFlag !== ORDER_FLAGGED.reconciliationFlag) {
				return { status: 409, body: { ok: false, reason: "RECONCILIATION_FLAG_CHANGED" } };
			}
			return {
				status: 200,
				body: {
					ok: true,
					resolved: true,
					order: {
						...ORDER_FLAGGED,
						reconciliationFlag: null,
						reconciliationResolution: {
							outcome: b?.outcome ?? "",
							reason: b?.reason ?? "",
							resolvedBy: b?.resolvedBy ?? "",
							resolvedAt: "2026-07-10T02:00:00.000Z",
						},
					},
				},
			};
		}
		if (req.url.includes("/fulfillment")) {
			const b = req.body as
				| { carrier?: string; trackingNumber?: string; trackingUrl?: string; recordedBy?: string }
				| undefined;
			return {
				status: 200,
				body: {
					ok: true,
					recorded: true,
					order: {
						...ORDER_PROCESSING,
						state: "shipped",
						fulfillment: {
							carrier: b?.carrier ?? "",
							trackingNumber: b?.trackingNumber ?? "",
							trackingUrl: b?.trackingUrl ?? null,
							shippedAt: "2026-07-11T00:00:00.000Z",
							recordedBy: b?.recordedBy ?? "",
							recordedAt: "2026-07-11T00:00:01.000Z",
						},
					},
				},
			};
		}
		if (req.url.includes("/cancel")) {
			const b = req.body as { reason?: string; detail?: string; cancelledBy?: string } | undefined;
			return {
				status: 200,
				body: {
					ok: true,
					cancelled: true,
					order: {
						...ORDER_PROCESSING,
						state: "cancelled",
						cancellation: {
							reason: b?.reason ?? "",
							detail: b?.detail ?? null,
							cancelledBy: b?.cancelledBy ?? "",
							cancelledAt: "2026-07-11T00:00:01.000Z",
						},
					},
				},
			};
		}
		if (req.url.includes("/transition")) {
			const toState = (req.body as { toState?: string } | undefined)?.toState;
			// A request to the state the order is already in ("paid") is a guarded
			// no-op: ok, but transitioned:false (mirrors the domain).
			if (toState === "paid") {
				return { status: 200, body: { ok: true, transitioned: false, order: ORDER_1 } };
			}
			return {
				status: 200,
				body: { ok: true, transitioned: true, order: { ...ORDER_1, state: "processing" } },
			};
		}
		return { status: 404, body: { error: "unknown" } };
	};
}

async function seedToken(sandbox: SandboxHandle, stub: StubCommerceServer, token: string) {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: token },
	});
	stub.requests.length = 0;
}

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(outcome: unknown): Blk[] {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return [];
	const result = (outcome as { result: { blocks?: Blk[] } }).result;
	return result.blocks ?? [];
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe("admin Orders console (workerd sandbox)", () => {
	async function boot(token = "admin-token-xyz"): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		stub.respondWith("POST", makePostResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		if (token.length > 0) await seedToken(sandbox, stub, token);
	}

	test("page_load /orders renders the list and forwards the kv-sourced admin token", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/orders" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Orders")).toBe(true);
		const table = blocks.find((b) => b.type === "table");
		expect(table).toBeDefined();
		expect(((table?.rows ?? []) as unknown[]).length).toBe(2);
		expect(table?.page_action_id).toBe("orders:page");
		// The list GET carried the token from write-only kv.
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/orders"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("filter form_submit re-lists with the status + date window in the GET", async () => {
		await boot();
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:apply-filter",
			values: { status: "paid", from: "2026-07-10", search: "" },
		});
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/orders"));
		expect(listReq).toBeDefined();
		expect(listReq!.url).toContain("states=paid");
		expect(listReq!.url).toContain("from=2026-07-10");
	});

	test("Load more block_action re-lists with the service cursor", async () => {
		await boot();
		const page1 = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/orders" });
		const table = blocksOf(page1).find((b) => b.type === "table");
		const nextCursor = table?.next_cursor as string | undefined;
		expect(typeof nextCursor).toBe("string"); // console-wrapped token
		stub!.requests.length = 0;

		await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "orders:page",
			value: { cursor: nextCursor, sort: null },
		});
		const pagedReq = stub!.requests.find((r) => r.url.startsWith("/admin/orders"));
		expect(pagedReq).toBeDefined();
		// The console unwrapped its token back to the SERVICE cursor for the GET.
		expect(pagedReq!.url).toContain("cursor=svc-cursor-1");
		expect(pagedReq!.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("orders:page with NO cursor value defensively yields the first-page list (not a blank)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "orders:page",
			value: {},
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Orders")).toBe(true);
		expect(blocks.some((b) => b.type === "table")).toBe(true);
	});

	test("open order → detail with line items + transition buttons matching allowedTransitions", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-1")).toBe(true);
		// A back button exists (no dead-end).
		const actions = blocks.filter((b) => b.type === "actions");
		const allButtons = actions.flatMap((a) => (a.elements as Array<Record<string, unknown>>) ?? []);
		expect(allButtons.some((e) => e.action_id === "orders:back")).toBe(true);
		// Line-items table present with the seeded line.
		const tables = blocks.filter((b) => b.type === "table");
		expect(tables.length).toBeGreaterThanOrEqual(1);
		const itemRows = tables.flatMap((t) => (t.rows as Array<Record<string, unknown>>) ?? []);
		expect(itemRows.some((r) => r.sku === "SKU-1")).toBe(true);
		// One transition button per allowedTransition EXCEPT the bare `cancelled` —
		// steered to the Cancel form instead (this slice's steering, mirroring #63's
		// fulfillment steering) — with confirm on the still-bare destructive one.
		const transitions = allButtons.filter((e) => e.action_id === "orders:transition");
		const toStates = transitions.map((e) => (e.value as { toState: string }).toState);
		expect(toStates.toSorted()).toEqual(["completed", "processing", "refunded"]);
		const refund = transitions.find((e) => (e.value as { toState: string }).toState === "refunded");
		expect(refund?.style).toBe("danger");
		expect(refund?.confirm).toBeDefined();
		const processing = transitions.find(
			(e) => (e.value as { toState: string }).toState === "processing",
		);
		expect(processing?.confirm).toBeUndefined(); // non-destructive: no confirm
	});

	test("transition block_action POSTs the transition with Idempotency-Key + token, then re-renders detail", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "orders:transition",
			value: { orderId: "ord-1", toState: "processing" },
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/orders/ord-1/transition");
		expect(post!.headers["idempotency-key"]).toBe("admin-transition:ord-1:processing");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect((post!.body as { toState: string }).toState).toBe("processing");
		// Re-renders the detail view (GET after the POST).
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-1")).toBe(true);
	});

	test("a no-op transition (ok but transitioned:false) re-renders detail with a NON-error notice", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "orders:transition",
			value: { orderId: "ord-1", toState: "paid" }, // already paid ⇒ transitioned:false
		});
		const blocks = blocksOf(outcome);
		// Still the detail view, plus a non-error "No change" banner (not variant:error).
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-1")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner).toBeDefined();
		expect(banner?.variant).not.toBe("error");
		expect(banner?.title).toBe("No change");
	});

	test("open order → detail shows the Notes section, the seeded notes, and an add-note form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		// A "Notes" section header exists.
		expect(blocks.some((b) => b.type === "section" && b.text === "Notes")).toBe(true);
		// The seeded notes appear in a table (append order preserved from the wire).
		const tables = blocks.filter((b) => b.type === "table");
		const noteRows = tables.flatMap((t) => (t.rows as Array<Record<string, unknown>>) ?? []);
		expect(noteRows.some((r) => r.body === "Customer asked to gift-wrap.")).toBe(true);
		expect(noteRows.some((r) => r.body === "Called the customer back.")).toBe(true);
		// An add-note form with author + body fields whose submit fires orders:add-note.
		const forms = blocks.filter((b) => b.type === "form");
		const addForm = forms.find(
			(f) => (f.submit as { action_id?: string } | undefined)?.action_id === "orders:add-note",
		);
		expect(addForm).toBeDefined();
		const fieldIds = ((addForm?.fields ?? []) as Array<{ action_id?: string }>).map(
			(f) => f.action_id,
		);
		expect(fieldIds).toContain("author");
		expect(fieldIds).toContain("body");
		expect(fieldIds).toContain("orderId"); // carries the order id into the stateless submit
	});

	test("open order → detail shows the Timeline section merging state changes, a note, and fulfillment", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		// A "Timeline" section header exists.
		expect(blocks.some((b) => b.type === "section" && b.text === "Timeline")).toBe(true);
		// The merged entries render as a table with when/what/who/detail columns.
		const tables = blocks.filter((b) => b.type === "table");
		const timelineTable = tables.find((t) =>
			((t.columns as Array<{ key?: string }>) ?? []).some((c) => c.key === "what"),
		);
		expect(timelineTable).toBeDefined();
		const rows = (timelineTable?.rows as Array<Record<string, unknown>>) ?? [];
		const whats = rows.map((r) => r.what);
		expect(whats).toContain("Order created");
		expect(whats).toContain("Status → paid");
		expect(whats).toContain("Note added");
		expect(whats).toContain("Fulfillment recorded");
		// The fulfillment row carries its recorder + tracking detail.
		const fulfilRow = rows.find((r) => r.what === "Fulfillment recorded");
		expect(fulfilRow?.who).toBe("ops@shop.test");
		expect(String(fulfilRow?.detail)).toContain("1Z-999");
	});

	test("a historical order (stateChangesAudited:false) shows the partial-timeline caption", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-proc" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Timeline")).toBe(true);
		// The degradation caption is present (state-change history predates the log).
		const contexts = blocks.filter((b) => b.type === "context");
		expect(contexts.some((c) => /predate the audit log/i.test(String(c.text)))).toBe(true);
	});

	test("add-note form_submit POSTs the note with Idempotency-Key + token, then re-renders detail", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:add-note",
			values: { orderId: "ord-1", author: "carol", body: "Packed and shipped." },
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/orders/ord-1/notes");
		expect(post!.headers["idempotency-key"]).toBe("admin-note:ord-1:carol:Packed and shipped.");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect((post!.body as { author: string; body: string }).author).toBe("carol");
		expect((post!.body as { author: string; body: string }).body).toBe("Packed and shipped.");
		// Re-renders the detail view (GET after the POST).
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-1")).toBe(true);
		expect(blocks.some((b) => b.type === "section" && b.text === "Notes")).toBe(true);
	});

	test("add-note with a blank body shows an inline error and makes NO POST", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:add-note",
			values: { orderId: "ord-1", author: "carol", body: "   " },
		});
		// No write left the plugin.
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		// Still the detail view, with an error notice.
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-1")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("Note not added");
	});

	test("open a FLAGGED order → detail shows the needs-reconciliation alert + a resolve form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-flagged" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-flagged")).toBe(true);
		// The prominent alert banner naming what settle detected.
		const alert = blocks.find((b) => b.type === "banner" && b.variant === "alert");
		expect(alert?.title).toBe("Needs reconciliation");
		expect(String(alert?.description)).toContain("commit lost for reservation res-1");
		// A resolve form carrying the order id + outcome/reason/resolvedBy fields.
		const forms = blocks.filter((b) => b.type === "form");
		const resolveForm = forms.find(
			(f) =>
				(f.submit as { action_id?: string } | undefined)?.action_id ===
				"orders:resolve-reconciliation",
		);
		expect(resolveForm).toBeDefined();
		const fieldIds = ((resolveForm?.fields ?? []) as Array<{ action_id?: string }>).map(
			(f) => f.action_id,
		);
		expect(fieldIds).toContain("orderId");
		expect(fieldIds).toContain("expectedFlag"); // the reviewed anomaly rides along
		expect(fieldIds).toContain("outcome");
		expect(fieldIds).toContain("reason");
		expect(fieldIds).toContain("resolvedBy");
		// Blocker-2 copy: the outcome must read as a RECORD, never a money movement —
		// the "refunded" option label and the form context both say so.
		const outcomeField = ((resolveForm?.fields ?? []) as Array<Record<string, unknown>>).find(
			(f) => f.action_id === "outcome",
		);
		const refundedOption = ((outcomeField?.options ?? []) as Array<Record<string, unknown>>).find(
			(opt) => opt.value === "refunded",
		);
		expect(String(refundedOption?.label)).toContain("recorded only");
		expect(String(refundedOption?.label)).toContain("issue the refund separately");
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("does NOT move money"))).toBe(true);
	});

	test("open a RESOLVED order shows the recorded disposition and NO resolve form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-resolved" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-resolved")).toBe(true);
		// The recorded disposition is shown in a "Reconciliation resolved" section.
		expect(blocks.some((b) => b.type === "section" && b.text === "Reconciliation resolved")).toBe(
			true,
		);
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		expect(fieldValues).toContain("Outcome=fulfilled");
		expect(fieldValues).toContain("Resolved by=ops@shop.test");
		// No resolve form on an already-resolved order, and no reconciliation alert
		// banner (the order is still `paid` — legally cancellable — so it DOES carry
		// the unrelated "Cancelling is permanent" alert from the cancellation
		// section below; this assertion is scoped to reconciliation, not "any" alert).
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) =>
					(f.submit as { action_id?: string } | undefined)?.action_id ===
					"orders:resolve-reconciliation",
			),
		).toBe(false);
		expect(
			blocks.some(
				(b) => b.type === "banner" && b.variant === "alert" && b.title === "Needs reconciliation",
			),
		).toBe(false);
	});

	test("resolve form_submit POSTs the disposition (incl. expectedFlag) with Idempotency-Key + token, then re-renders detail", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:resolve-reconciliation",
			values: {
				orderId: "ord-flagged",
				expectedFlag: "commit lost for reservation res-1",
				outcome: "refunded",
				reason: "refunded the buyer",
				resolvedBy: "carol",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/orders/ord-flagged/resolve-reconciliation");
		expect(post!.headers["idempotency-key"]).toBe("admin-resolve-reconciliation:ord-flagged");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		const body = post!.body as {
			expectedFlag: string;
			outcome: string;
			reason: string;
			resolvedBy: string;
		};
		expect(body).toEqual({
			expectedFlag: "commit lost for reservation res-1",
			outcome: "refunded",
			reason: "refunded the buyer",
			resolvedBy: "carol",
		});
		// Re-renders the detail view (GET after the POST).
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-flagged")).toBe(true);
	});

	test("resolve with a STALE expectedFlag (409 conflict) surfaces the reload notice, nothing cleared", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:resolve-reconciliation",
			values: {
				orderId: "ord-flagged",
				expectedFlag: "an older anomaly the admin reviewed", // ≠ the live flag
				outcome: "written_off",
				reason: "reviewed the old anomaly",
				resolvedBy: "carol",
			},
		});
		// The POST fired and the stub answered 409 RECONCILIATION_FLAG_CHANGED.
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(true);
		const blocks = blocksOf(outcome);
		// Still the detail view (re-rendered with the LIVE flag), with the dedicated
		// reload notice — not the generic token-check error.
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-flagged")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("The reconciliation state changed — reload");
		expect(String(banner?.description)).toContain("Nothing was cleared");
	});

	test("resolve with a blank reason shows an inline error and makes NO POST", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:resolve-reconciliation",
			values: { orderId: "ord-flagged", outcome: "fulfilled", reason: "   ", resolvedBy: "carol" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-flagged")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("Not resolved");
	});

	test("open a PROCESSING order → detail shows the record-fulfillment form (ships the order)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-proc" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Fulfillment")).toBe(true);
		const forms = blocks.filter((b) => b.type === "form");
		const fulfilForm = forms.find(
			(f) =>
				(f.submit as { action_id?: string } | undefined)?.action_id === "orders:record-fulfillment",
		);
		expect(fulfilForm).toBeDefined();
		const fieldIds = ((fulfilForm?.fields ?? []) as Array<{ action_id?: string }>).map(
			(f) => f.action_id,
		);
		expect(fieldIds).toEqual([
			"orderId",
			"carrier",
			"trackingNumber",
			"trackingUrl",
			"shippedAt",
			"recordedBy",
		]);
		// The copy is honest that recording ships the order + emails tracking.
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("ships this order"))).toBe(true);
	});

	test("a PROCESSING order offers NO bare Mark-shipped button — shipping is steered to the Fulfillment form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-proc" },
		});
		const blocks = blocksOf(outcome);
		// The service listed `shipped` as a legal target (the stub mirrors the state
		// machine), but the UI must NOT render its one-click button: a tracking-less
		// ship would send the buyer an empty shipped email.
		const transitionButtons = blocks
			.filter((b) => b.type === "actions")
			.flatMap((b) => (b.elements as Array<Record<string, unknown>>) ?? [])
			.filter((e) => e.action_id === "orders:transition");
		const toStates = transitionButtons.map((e) => (e.value as { toState: string }).toState);
		expect(toStates).not.toContain("shipped");
		// `cancelled` is ALSO steered (this slice) to the Cancel form above; only
		// `refunded` remains a bare one-click button.
		expect(toStates.toSorted()).toEqual(["refunded"]);
		// The steering hints point at the Fulfillment form and the Cancel form,
		// both present.
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("use the Fulfillment form above"))).toBe(true);
		expect(contexts.some((t) => t.includes("use the Cancel form above"))).toBe(true);
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) =>
					(f.submit as { action_id?: string } | undefined)?.action_id ===
					"orders:record-fulfillment",
			),
		).toBe(true);
	});

	test("record-fulfillment with a non-http(s) tracking URL shows an inline error and makes NO POST", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:record-fulfillment",
			values: {
				orderId: "ord-proc",
				carrier: "UPS",
				trackingNumber: "1Z-1",
				trackingUrl: "javascript:alert(1)",
				recordedBy: "carol",
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("Not shipped");
		expect(String(banner?.description)).toContain("http://");
	});

	test("open a SHIPPED order with tracking → shows the recorded fulfillment, NO form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-shipped" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Fulfillment")).toBe(true);
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		expect(fieldValues).toContain("Carrier=UPS");
		expect(fieldValues).toContain("Tracking number=1Z-999");
		// No record form on an already-fulfilled order.
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) =>
					(f.submit as { action_id?: string } | undefined)?.action_id ===
					"orders:record-fulfillment",
			),
		).toBe(false);
	});

	test("record-fulfillment form_submit POSTs tracking with Idempotency-Key + token, then re-renders detail", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:record-fulfillment",
			values: {
				orderId: "ord-proc",
				carrier: "UPS",
				trackingNumber: "1Z-777",
				trackingUrl: "https://track/1Z-777",
				shippedAt: "2026-07-11",
				recordedBy: "carol",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/orders/ord-proc/fulfillment");
		expect(post!.headers["idempotency-key"]).toBe("admin-record-fulfillment:ord-proc");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		const body = post!.body as Record<string, string>;
		expect(body.carrier).toBe("UPS");
		expect(body.trackingNumber).toBe("1Z-777");
		expect(body.trackingUrl).toBe("https://track/1Z-777");
		// A bare date is padded to a full UTC datetime the service accepts.
		expect(body.shippedAt).toBe("2026-07-11T00:00:00.000Z");
		expect(body.recordedBy).toBe("carol");
		// Re-renders the detail view (GET after the POST) with a success notice.
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-proc")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner?.title).toBe("Order shipped");
	});

	test("record-fulfillment with a blank carrier shows an inline error and makes NO POST", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:record-fulfillment",
			values: { orderId: "ord-proc", carrier: "  ", trackingNumber: "1Z-1", recordedBy: "carol" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("Not shipped");
	});

	test("open a cancellable (paid) order → detail shows the danger-styled Cancel form, no bare Mark-cancelled button", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Cancellation")).toBe(true);
		const alert = blocks.find((b) => b.type === "banner" && b.variant === "alert");
		expect(alert?.title).toBe("Cancelling is permanent");
		const forms = blocks.filter((b) => b.type === "form");
		const cancelForm = forms.find(
			(f) => (f.submit as { action_id?: string } | undefined)?.action_id === "orders:cancel",
		);
		expect(cancelForm).toBeDefined();
		const fieldIds = ((cancelForm?.fields ?? []) as Array<{ action_id?: string }>).map(
			(f) => f.action_id,
		);
		expect(fieldIds).toEqual(["orderId", "reason", "detail", "cancelledBy"]);
		// No bare "Mark cancelled" button anywhere in the actions.
		const transitionButtons = blocks
			.filter((b) => b.type === "actions")
			.flatMap((b) => (b.elements as Array<Record<string, unknown>>) ?? [])
			.filter((e) => e.action_id === "orders:transition");
		expect(transitionButtons.map((e) => (e.value as { toState: string }).toState)).not.toContain(
			"cancelled",
		);
	});

	test("cancel form_submit POSTs the reason with Idempotency-Key + token, then re-renders detail with a success notice", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:cancel",
			values: {
				orderId: "ord-proc",
				reason: "out_of_stock",
				detail: "last unit sold on another channel",
				cancelledBy: "carol",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/orders/ord-proc/cancel");
		expect(post!.headers["idempotency-key"]).toBe("admin-cancel:ord-proc");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		const body = post!.body as Record<string, string>;
		expect(body.reason).toBe("out_of_stock");
		expect(body.detail).toBe("last unit sold on another channel");
		expect(body.cancelledBy).toBe("carol");
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-proc")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner?.title).toBe("Order cancelled");
	});

	test("cancel with a blank cancelledBy shows an inline error and makes NO POST", async () => {
		await boot();
		stub!.requests.length = 0;
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:cancel",
			values: { orderId: "ord-proc", reason: "customer_request", cancelledBy: "  " },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner?.title).toBe("Not cancelled");
	});

	test("open a CANCELLED order WITH a recorded reason → shows it read-only, no Cancel form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-cancelled" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Cancellation")).toBe(true);
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		expect(fieldValues).toContain("Reason=out_of_stock");
		expect(fieldValues).toContain("Detail=last unit sold on another channel");
		expect(fieldValues).toContain("Cancelled by=ops@shop.test");
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) => (f.submit as { action_id?: string } | undefined)?.action_id === "orders:cancel",
			),
		).toBe(false);
	});

	test("open a CANCELLED order cancelled WITHOUT a recorded reason (bare transition) → honest note, no Cancel form", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-cancelled-bare" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Cancellation")).toBe(true);
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("no reason was recorded"))).toBe(true);
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) => (f.submit as { action_id?: string } | undefined)?.action_id === "orders:cancel",
			),
		).toBe(false);
	});

	test("open order → detail shows the Customer section: identity, address book (with ship-to disclaimer), sessions, other orders — token-free", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Customer")).toBe(true);
		// Identity fields: the resolved account email + the union order count.
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		expect(fieldValues).toContain("Email=alice@example.com");
		expect(fieldValues).toContain("Name=Alice Example");
		expect(fieldValues).toContain("Account=cust-a");
		expect(fieldValues).toContain("Total orders=3");
		// The profile address book is labeled prefill/context only (ADR-0009) — the
		// order's own ship-to is the authoritative destination, shown separately.
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("prefill/context only"))).toBe(true);
		expect(contexts.some((t) => t.includes("shown above under “Shipping address”"))).toBe(true);
		// Address, session, and other-order rows all render.
		const rows = blocks
			.filter((b) => b.type === "table")
			.flatMap((t) => (t.rows as Array<Record<string, unknown>>) ?? []);
		expect(rows.some((r) => String(r.address ?? "").includes("1 Main St"))).toBe(true);
		expect(rows.some((r) => r.createdAt === "2026-07-09T00:00:00.000Z")).toBe(true); // session
		expect(rows.some((r) => r.id === "ord-2")).toBe(true); // other recent order
		// NOTHING token-like reaches the rendered blocks (the wire shape is
		// token-free; belt-and-braces that no credential material leaked through).
		expect(JSON.stringify(blocks)).not.toMatch(/token/i);
	});

	test("ADR-0009: a captured ship-to renders the Shipping address section with the country/zone juxtaposition", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-1" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Shipping address")).toBe(true);
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		// The frozen address fields render, and the display-only country/zone pair
		// sit side by side (no matching — just the two facts).
		expect(fieldValues.some((v) => v.includes("500 Shipping Ln"))).toBe(true);
		expect(fieldValues).toContain("Country=US");
		expect(fieldValues).toContain("Chosen shipping zone=zone-domestic");
	});

	test("ADR-0009: an order with NO captured ship-to renders the honest 'no ship-to on file' note", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-no-addr" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "section" && b.text === "Shipping address")).toBe(true);
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("No shipping address captured"))).toBe(true);
	});

	test("open a GUEST order → honest guest labeling, empty address/session surfaces (not an error)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-guest" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-guest")).toBe(true);
		const fieldValues = blocks
			.filter((b) => b.type === "fields")
			.flatMap((b) => (b.fields as Array<{ label?: string; value?: string }>) ?? [])
			.map((f) => `${String(f.label)}=${String(f.value)}`);
		expect(fieldValues).toContain("Account=Guest — no account");
		expect(fieldValues).toContain("Total orders=1");
		// The empty states explain themselves rather than looking like a bug.
		const tables = blocks.filter((b) => b.type === "table");
		const emptyTexts = tables.map((t) => String(t.empty_text ?? ""));
		expect(emptyTexts.some((t) => t.includes("guests have no address book"))).toBe(true);
		expect(emptyTexts.some((t) => t.includes("guests never sign in"))).toBe(true);
	});

	test("a FAILING customer-context read degrades to an explicit 'unavailable' section — the detail view still renders", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: "ord-ctx-fail" },
		});
		const blocks = blocksOf(outcome);
		// The detail view survives: header, line items, and notes all present.
		expect(blocks.some((b) => b.type === "header" && b.text === "Order ord-ctx-fail")).toBe(true);
		expect(blocks.some((b) => b.type === "section" && b.text === "Line items")).toBe(true);
		expect(blocks.some((b) => b.type === "section" && b.text === "Notes")).toBe(true);
		// The Customer section is present with an EXPLICIT unavailable body —
		// never silently omitted, never a fail-closed banner for the whole page.
		expect(blocks.some((b) => b.type === "section" && b.text === "Customer")).toBe(true);
		const contexts = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(contexts.some((t) => t.includes("Customer context unavailable"))).toBe(true);
		expect(blocks.some((b) => b.type === "banner" && b.variant === "error")).toBe(false);
	});

	test("NO-TOKEN page_load /orders fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		await boot(""); // do NOT seed a token → guarded list answers 401
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/orders" });
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		// em-dash-correct banner: renders a body (title + description), not the
		// legacy `text` shape that renders empty in production.
		expect(banner?.title).toBeDefined();
		expect(banner?.description).toBeDefined();
		const text = `${String(banner?.title)} ${String(banner?.description)}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401/);
	});
});
