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
	totals: {
		currency: "USD",
		subtotalCents: 1500,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 0,
		totalCents: 1500,
		appliedCouponCode: null,
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
		if (path?.startsWith("/admin/orders/")) {
			const order = path.includes("/ord-flagged")
				? ORDER_FLAGGED
				: path.includes("/ord-resolved")
					? ORDER_RESOLVED
					: ORDER_1;
			return {
				status: 200,
				body: {
					ok: true,
					order,
					allowedTransitions: ["processing", "completed", "cancelled", "refunded"],
				},
			};
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
		// One transition button per allowedTransition, with confirm on the destructive ones.
		const transitions = allButtons.filter((e) => e.action_id === "orders:transition");
		const toStates = transitions.map((e) => (e.value as { toState: string }).toState);
		expect(toStates.toSorted()).toEqual(["cancelled", "completed", "processing", "refunded"]);
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
		// No resolve form on an already-resolved order, and no alert banner.
		const forms = blocks.filter((b) => b.type === "form");
		expect(
			forms.some(
				(f) =>
					(f.submit as { action_id?: string } | undefined)?.action_id ===
					"orders:resolve-reconciliation",
			),
		).toBe(false);
		expect(blocks.some((b) => b.type === "banner" && b.variant === "alert")).toBe(false);
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
