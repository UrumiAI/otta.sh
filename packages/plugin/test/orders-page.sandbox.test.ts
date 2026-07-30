import { afterEach, describe, expect, test } from "vitest";
import { decodeCarrier, encodeCarrier } from "../src/admin/scaffold/carrier.js";
import {
	accessories,
	blocksOf,
	columnLabels,
	columnsOf,
	confirmOf,
	buttons,
	contextTexts,
	field,
	fieldEntries,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	panel,
	panelLabels,
	tableRows,
	tableWithId,
	valueOf,
	type LooseBlock,
} from "./helpers/blocks.js";
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

// ADR-0008: an x402-paid order — refunds are RECORD-ONLY (refundable:false).
const ORDER_X402 = { ...ORDER_1, id: "ord-x402", paymentMethod: "x402" };
// Nothing left to refund — DA-7 withholds the refund control entirely.
const ORDER_FULLY_REFUNDED = { ...ORDER_1, id: "ord-refunded", state: "refunded" };
// DA-6's hazard: the SERVICE offers a state this plugin's closed `ORDER_STATES`
// does not contain. A button for it would carry an action id the admin-route
// dispatcher never registered, and `admin-route.ts` falls through an unknown id to
// `{blocks: []}` — a blank console.
const ORDER_UNKNOWN_STATE = { ...ORDER_1, id: "ord-unknown" };

// Refunds summaries (ADR-0008). Default: a Stripe order with money remaining
// refundable ⇒ refundable:true, so the refund form appears with a REAL-refund
// label. X402: record-only.
const REFUNDS_DEFAULT = {
	refunds: [
		{
			id: "rf-1",
			orderId: "ord-1",
			amountCents: 500,
			currency: "USD",
			kind: "gateway",
			gateway: "stripe",
			refundRef: "re_seed",
			reason: "one item returned",
			refundedBy: "ops@shop.test",
			createdAt: "2026-07-12T00:00:00.000Z",
		},
	],
	currency: "USD",
	capturedTotalCents: 1500,
	refundedTotalCents: 500,
	ceilingCents: 1500,
	remainingCents: 1000,
	paymentMethod: "stripe",
	refundable: true,
};
const REFUNDS_FULL = {
	refunds: [
		{
			id: "rf-full",
			orderId: "ord-refunded",
			amountCents: 1500,
			currency: "USD",
			kind: "gateway",
			gateway: "stripe",
			refundRef: "re_full",
			reason: null,
			refundedBy: "ops@shop.test",
			createdAt: "2026-07-12T00:00:00.000Z",
		},
	],
	currency: "USD",
	capturedTotalCents: 1500,
	refundedTotalCents: 1500,
	ceilingCents: 1500,
	remainingCents: 0,
	paymentMethod: "stripe",
	refundable: true,
};
const REFUNDS_X402 = {
	refunds: [],
	currency: "USD",
	capturedTotalCents: 1500,
	refundedTotalCents: 0,
	ceilingCents: 1500,
	remainingCents: 1500,
	paymentMethod: "x402",
	refundable: false,
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
/** Per-test switch for the LIST read, so the two zero-row branches (E-2's `empty`
 *  block when unfiltered, `empty_text` when filtered) are both reachable. */
let listRows: "two" | "none" = "two";

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
			if (listRows === "none") {
				return { status: 200, body: { ok: true, orders: [], nextCursor: null } };
			}
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
		// Order refunds read (ADR-0008) — also BEFORE the detail branch.
		if (path?.endsWith("/refunds")) {
			const summary = path.includes("/ord-x402")
				? REFUNDS_X402
				: path.includes("/ord-refunded")
					? REFUNDS_FULL
					: REFUNDS_DEFAULT;
			return { status: 200, body: { ok: true, ...summary } };
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
												: path.includes("/ord-x402")
													? ORDER_X402
													: path.includes("/ord-refunded")
														? ORDER_FULLY_REFUNDED
														: path.includes("/ord-unknown")
															? ORDER_UNKNOWN_STATE
															: ORDER_1;
			// State-appropriate transitions, as the real service derives them from the
			// domain state machine: a processing order's legal targets INCLUDE the bare
			// `shipped` — the PLUGIN is what must steer it away (PR #63 review); a
			// cancelled order (either fixture) is TERMINAL — no legal transitions.
			const allowedTransitions =
				order.id === "ord-unknown"
					? // A state outside the plugin's closed ORDER_STATES (DA-6).
						["teleported", "completed"]
					: order.state === "cancelled"
						? []
						: order.state === "refunded"
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
		if (req.url.includes("/refund")) {
			const b = req.body as
				| { amountCents?: number; currency?: string; reason?: string; refundedBy?: string }
				| undefined;
			const amount = b?.amountCents ?? 0;
			const isX402 = req.url.includes("/ord-x402");
			const remaining = isX402 ? 1500 : 1000; // matches the REFUNDS_* fixtures
			if (amount > remaining) {
				return { status: 409, body: { ok: false, reason: "REFUND_EXCEEDS_TOTAL" } };
			}
			const fullyRefunded = amount === remaining;
			return {
				status: 200,
				body: {
					ok: true,
					recorded: true,
					duplicate: false,
					fullyRefunded,
					refund: {
						id: "rf-new",
						orderId: isX402 ? "ord-x402" : "ord-1",
						amountCents: amount,
						currency: b?.currency ?? "USD",
						kind: isX402 ? "manual" : "gateway",
						gateway: isX402 ? "x402" : "stripe",
						refundRef: isX402 ? null : "re_new",
						reason: b?.reason ?? null,
						refundedBy: b?.refundedBy ?? "",
						createdAt: "2026-07-12T01:00:00.000Z",
					},
					order: { ...(isX402 ? ORDER_X402 : ORDER_1), state: fullyRefunded ? "refunded" : "paid" },
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

function buttonWith(blocks: LooseBlock[], actionId: string): Record<string, unknown> | undefined {
	return buttons(blocks).find((e) => e.action_id === actionId);
}

/** The states the DA-6 transition block offers, read back out of its DERIVED
 *  per-state action ids (`orders:transition-<state>`). */
function transitionStates(blocks: LooseBlock[]): string[] {
	return buttons(blocks)
		.filter((e) => String(e.action_id).startsWith("orders:transition-"))
		.map((e) => String(e.action_id).replace("orders:transition-", ""));
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
	listRows = "two";
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

	/** Render the list. */
	async function list(): Promise<LooseBlock[]> {
		return blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/orders" }));
	}

	/** Render an order's detail through the "Open order" picker. */
	async function open(orderId: string): Promise<LooseBlock[]> {
		return blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:open",
				values: { orderId },
			}),
		);
	}

	/**
	 * Submit a form the way em-dash does: `values` PLUS the `block_id` the form
	 * carried, which is where every id and watermark now rides (F-2, B-1). Driving
	 * it any other way would test a wire shape the renderer never sends.
	 */
	async function submitForm(
		blocks: LooseBlock[],
		submitActionId: string,
		values: Record<string, unknown>,
	): Promise<LooseBlock[]> {
		const form = formFor(blocks, submitActionId);
		expect(form, `no form submitting ${submitActionId}`).toBeDefined();
		return blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: submitActionId,
				values,
				block_id: form!.block_id,
			}),
		);
	}

	/** Click a button the way em-dash does: `action_id` + `value`, and NO
	 *  `block_id` — a button echoes none (B-1). */
	async function click(button: Record<string, unknown> | undefined): Promise<LooseBlock[]> {
		expect(button, "no such button").toBeDefined();
		return blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: button!.action_id,
				value: button!.value,
			}),
		);
	}

	// -- §11.1 the list ---------------------------------------------------------

	test("page_load /orders renders §11.1's block order: header, one context, the COLLAPSED filter panel, then the data", async () => {
		await boot();
		const blocks = await list();
		expect(findBlocks(blocks, "header").map((b) => b.text)).toEqual(["Orders"]);
		// P-1: only these may precede the primary table, in this order.
		expect(blocks.map((b) => b.type)).toEqual([
			"header",
			"context",
			"accordion", // the filter panel — collapsed (L-2: 4 fields)
			"table", // THE DATA
			"form", // the drill-in picker (L-7), which sits BELOW it (P-4)
		]);
		// The page-level context is ≤140 (§1) and no longer claims to be view-only.
		const pageContext = String(blocks[1]?.text);
		expect(pageContext.length).toBeLessThanOrEqual(140);
		expect(pageContext).not.toContain("View-only");
		// The filter form is INSIDE the accordion — the exact nesting that made every
		// flat top-level search stop asserting (R-25, §15).
		expect(findBlocks(blocks, "form")).toHaveLength(2);
		expect(blocks.filter((b) => b.type === "form")).toHaveLength(1);
		const table = tableWithId(blocks, "orders:list");
		expect(((table?.rows ?? []) as unknown[]).length).toBe(2);
		expect(table?.page_action_id).toBe("orders:page");
		// No `sortable` anywhere (T-3): it renders a clickable ▲/▼ that sorts nothing
		// and silently drops the operator's filter.
		for (const t of findBlocks(blocks, "table")) {
			for (const col of (t.columns ?? []) as Array<Record<string, unknown>>) {
				expect(col.sortable).toBeUndefined();
			}
		}
		// No `Currency` column (M-2) — the formatted string carries it.
		expect(columnLabels(table)).toEqual(["Order #", "Placed", "Status", "Customer", "Total"]);
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/orders"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test('the UNFILTERED filter panel reads exactly `Filters`, is closed, and its status select resolves to the word `any` — never `""` (L-3, L-4, F-6a)', async () => {
		await boot();
		const blocks = await list();
		const filters = group(blocks, "orders:filters");
		expect(filters?.label).toBe("Filters");
		expect(filters?.default_open).not.toBe(true); // L-4: always closed
		// No summary section and no `Clear filters` when nothing is active (L-6).
		expect(findBlocks(blocks, "section")).toEqual([]);
		expect(accessories(blocks)).toEqual([]);
		const form = formFor(blocks, "orders:apply-filter");
		expect(fieldIds(form)).toEqual(["status", "from", "to", "search"]);
		const status = field(form, "status");
		expect(status?.initial_value).toBe("any");
		const values = ((status?.options ?? []) as Array<{ value: string }>).map((o) => o.value);
		expect(values).toContain("any");
		expect(values).not.toContain(""); // R-17a: `""` renders a BLANK trigger
		// F-2: no field is labelled with an internal name, anywhere on the screen.
		for (const f of findBlocks(blocks, "form").flatMap(
			(fm) => (fm.fields ?? []) as Array<Record<string, unknown>>,
		)) {
			expect(String(f.label)).not.toMatch(/^(orderId|currency|nonce|expectedFlag|Scope|Order)$/);
		}
	});

	test("WITH A FILTER APPLIED the label carries a COUNT (never values), the section carries the values plus `Clear filters`, and the accordion key is unchanged while the form's key changes (L-3, L-6, B-7)", async () => {
		await boot();
		const before = await list();
		const beforeFormId = formFor(before, "orders:apply-filter")?.block_id;

		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:apply-filter",
				values: { status: "paid", from: "2026-07-10", to: "", search: "" },
				block_id: beforeFormId,
			}),
		);
		// L-3: a COUNT in the label — one part per AUTHORED field, so status + from
		// is two, not one "last 30 days".
		expect(group(blocks, "orders:filters")?.label).toBe("Filters (2 active)");
		expect(group(blocks, "orders:filters")?.default_open).not.toBe(true);
		// L-6: the values live in the section below, joined " · ".
		const section = findBlock(blocks, "section");
		expect(section?.text).toBe("status: paid · from: 2026-07-10");
		const clear = section?.accessory as Record<string, unknown> | undefined;
		expect(clear?.label).toBe("Clear filters");
		expect(clear?.action_id).toBe("orders:apply-filter");
		// B-1: the path rides in `button.value` — a button echoes no `block_id`.
		expect(Object.keys(valueOf(clear))).toContain("__path");
		// B-7, both halves: the ACCORDION's key is stable across the apply (or the
		// panel would slam shut on an operator who filters constantly)…
		expect(group(blocks, "orders:filters")?.block_id).toBe(
			group(before, "orders:filters")?.block_id,
		);
		// …while the FORM's key changed, because its prefilled values did (B-3a).
		// Inside a container the form is index 0 forever, so this is the ONLY thing
		// that remounts it and makes the new `initial_value`s visible.
		const afterFormId = formFor(blocks, "orders:apply-filter")?.block_id;
		expect(afterFormId).not.toBe(beforeFormId);
		expect(field(formFor(blocks, "orders:apply-filter"), "status")?.initial_value).toBe("paid");
		// And the filter actually reached the service.
		const listReq = stub!.requests.find((r) => r.url.includes("states=paid"));
		expect(listReq!.url).toContain("from=2026-07-10");
	});

	test("`Clear filters` drops the summary section AND changes the form's key back, while the accordion's key stays put (B-3a — the bug a stable-everything filter has)", async () => {
		await boot();
		const unfiltered = await list();
		const unfilteredFormId = formFor(unfiltered, "orders:apply-filter")?.block_id;
		const filtered = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:apply-filter",
				values: { status: "paid" },
				block_id: unfilteredFormId,
			}),
		);
		const clear = findBlock(filtered, "section")?.accessory as Record<string, unknown>;

		const cleared = await click(clear);
		expect(findBlocks(cleared, "section")).toEqual([]);
		expect(group(cleared, "orders:filters")?.label).toBe("Filters");
		expect(group(cleared, "orders:filters")?.block_id).toBe(
			group(filtered, "orders:filters")?.block_id,
		);
		// The form's key differs from the FILTERED one and matches the default —
		// which is what actually clears the mounted fields.
		const clearedFormId = formFor(cleared, "orders:apply-filter")?.block_id;
		expect(clearedFormId).not.toBe(formFor(filtered, "orders:apply-filter")?.block_id);
		expect(clearedFormId).toBe(unfilteredFormId);
		expect(field(formFor(cleared, "orders:apply-filter"), "status")?.initial_value).toBe("any");
	});

	test("UNFILTERED zero rows renders one real `empty` block and OMITS the table (E-2); filtered-to-zero keeps the table's `empty_text`", async () => {
		await boot();
		listRows = "none";
		const unfiltered = await list();
		const empty = findBlock(unfiltered, "empty");
		expect(empty?.title).toBe("No orders yet");
		expect(String(empty?.description).length).toBeLessThanOrEqual(200);
		// The table is REPLACED, not rendered empty.
		expect(findBlocks(unfiltered, "table")).toEqual([]);
		// E-2: no create action — orders are not created in the admin, and an empty
		// `actions` array is omitted rather than emitted.
		expect(empty?.actions).toBeUndefined();
		// The drill-in picker is omitted at 0 rows (L-7).
		expect(formFor(unfiltered, "orders:open")).toBeUndefined();

		const filtered = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:apply-filter",
				values: { status: "paid" },
				block_id: formFor(unfiltered, "orders:apply-filter")?.block_id,
			}),
		);
		// A filtered-to-zero list is NOT an `empty` block: the operator's next act is
		// changing the filter, which is right there.
		expect(findBlocks(filtered, "empty")).toEqual([]);
		expect(tableWithId(filtered, "orders:list")?.empty_text).toBe("No orders match these filters.");
	});

	test("the drill-in picker is a combobox whose option VALUE is the id and whose label never contains one (L-7, X-22)", async () => {
		await boot();
		const blocks = await list();
		const form = formFor(blocks, "orders:open");
		const picker = field(form, "orderId");
		expect(picker?.type).toBe("combobox"); // >8 rows per page, and it never prefills
		expect(picker?.initial_value).toBe("none"); // F-6a: a real option, never blank
		const options = (picker?.options ?? []) as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: "none", label: "Choose an order…" });
		const row = options.find((o) => o.value === "ord-1");
		expect(row?.label).toBe("cust-a · $15.00 · paid");
		expect(row?.label).not.toContain("ord-1");
	});

	test("picking the L-7 `none` sentinel re-renders the list unchanged rather than drilling nowhere", async () => {
		await boot();
		const blocks = await open("none");
		expect(findBlocks(blocks, "header").map((b) => b.text)).toEqual(["Orders"]);
		expect(tableWithId(blocks, "orders:list")).toBeDefined();
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
		const table = tableWithId(await list(), "orders:list");
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
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:page",
				value: {},
			}),
		);
		expect(findBlocks(blocks, "header").some((b) => b.text === "Orders")).toBe(true);
		expect(tableWithId(blocks, "orders:list")).toBeDefined();
	});

	test("NO-TOKEN page_load /orders fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		await boot(""); // do NOT seed a token → guarded list answers 401
		const blocks = await list();
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		// em-dash-correct banner: renders a body (title + description), not the
		// legacy `text` shape that renders empty in production.
		expect(banner?.title).toBeDefined();
		expect(banner?.description).toBeDefined();
		const text = `${String(banner?.title)} ${String(banner?.description)}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401/);
	});

	// -- §11.2 the detail skeleton ---------------------------------------------

	test("the detail is five blocks outside the tabs plus FOUR constant task-named panels at default_tab 0 (D-1..D-4)", async () => {
		await boot();
		const blocks = await open("ord-1");
		expect(blocks.map((b) => b.type)).toEqual(["header", "actions", "fields", "tab"]);
		expect(findBlocks(blocks, "header").map((b) => b.text)).toEqual([
			"Order ord-1", // M-10: the uuid appears exactly ONCE
			"Line items", // the ONE header permitted inside a panel (P-2)
		]);
		const tab = findBlock(blocks, "tab");
		expect(tab?.block_id).toBe("orders:ord-1:tabs"); // stable (B-4)
		expect(tab?.default_tab).toBe(0); // ALWAYS (D-4)
		expect(panelLabels(blocks)).toEqual(["Order", "Fulfilment", "Money", "History"]);
		// A back button exists (no dead-end).
		expect(buttonWith(blocks, "orders:back")).toBeDefined();
		// The identity strip: 6 entries in 3 row-major PAIRS, with Total on it.
		const identity = findBlocks(blocks, "fields").find((f) => f.block_id === "orders:identity");
		const labels = ((identity?.fields ?? []) as Array<{ label: string }>).map((f) => f.label);
		expect(labels).toEqual([
			"Status",
			"Total",
			"Placed (UTC)",
			"Payment",
			"Customer",
			"Reconciliation",
		]);
		// M-6/X-13: an absolute UTC timestamp is trimmed to seconds.
		expect(fieldEntries(blocks)).toContain("Placed (UTC)=2026-07-10T01:00:00Z");
		expect(JSON.stringify(identity)).not.toMatch(/\.\d{3}Z/);
	});

	test("D-5: exactly ONE group is open per rendered response, and WHICH one is computed from the record state (X-18)", async () => {
		await boot();
		// rank 1 — flagged and unresolved.
		expect(openGroupIds(await open("ord-flagged"))).toEqual(["orders:ord-flagged:reconcile"]);
		// rank 2 — order state ∈ {paid, processing}.
		expect(openGroupIds(await open("ord-1"))).toEqual(["orders:ord-1:fulfilment"]);
		expect(openGroupIds(await open("ord-proc"))).toEqual(["orders:ord-proc:fulfilment"]);
		// rank 4 — nothing is open. Every destructive group is closed ALWAYS.
		expect(openGroupIds(await open("ord-cancelled"))).toEqual([]);
		expect(openGroupIds(await open("ord-refunded"))).toEqual([]);
	});

	test('the whole detail is free of carrier dropdowns, nonces and `""` option values — the plumbing moved into `block_id` (F-2, F-2a, F-3)', async () => {
		await boot();
		for (const id of ["ord-1", "ord-proc", "ord-flagged", "ord-cancelled", "ord-x402"]) {
			const blocks = await open(id);
			const forms = findBlocks(blocks, "form");
			expect(forms.length).toBeGreaterThan(0);
			for (const form of forms) {
				// X-17: every form's `block_id` is a CARRIER token, not hand-rolled.
				expect(String(form.block_id)).toContain(":u1.");
				for (const f of (form.fields ?? []) as Array<Record<string, unknown>>) {
					// F-3: not one single-option select survives.
					if (Array.isArray(f.options)) {
						expect((f.options as unknown[]).length).toBeGreaterThan(1);
						for (const o of f.options as Array<{ value: string }>) {
							expect(o.value).not.toBe(""); // R-17a / X-23
						}
						expect(f.initial_value).toBeDefined();
						expect((f.options as Array<{ value: string }>).map((o) => o.value)).toContain(
							f.initial_value,
						);
					}
					// X-1: no internal vocabulary reaches a label.
					expect(String(f.label)).not.toMatch(
						/^(orderId|currency|nonce|expectedFlag|expectedAmountCents|Scope|Order)$/,
					);
				}
			}
			// X-28: no nonce or idempotency key anywhere in the rendered tree.
			expect(JSON.stringify(blocks)).not.toMatch(/nonce|idempotency/i);
			// X-6/X-15: no `divider`, no `columns`, no `chart`.
			for (const t of ["divider", "columns", "chart"]) {
				expect(findBlocks(blocks, t)).toEqual([]);
			}
			// T-8: no sub-table in a leaf detail may page — a load-more click at leaf
			// depth blanks the page.
			for (const t of findBlocks(blocks, "table")) {
				expect(t.next_cursor).toBeUndefined();
				expect(t.page_action_id).toBe("orders:page");
			}
			// X-31: at most two banners at the TOP level (accordion ones don't count).
			expect(blocks.filter((b) => b.type === "banner").length).toBeLessThanOrEqual(2);
		}
	});

	// -- panel "Order" ---------------------------------------------------------

	test("the Order panel carries line items, the M-5 snapshot line, and the totals ladder as a TWO-COLUMN TABLE (M-4)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const orderPanel = panel(blocks, "Order");
		const lines = tableWithId(orderPanel, "orders:lines");
		expect(columnLabels(lines)).toEqual(["SKU", "Title", "Qty", "Unit price", "Line total"]);
		expect(tableRows([lines!])[0]).toEqual({
			sku: "SKU-1",
			title: "Widget",
			quantity: 3,
			unitPrice: "$5.00",
			lineTotal: "$15.00", // integer math on minor units, then formatted (M-1)
		});
		expect(contextTexts(orderPanel).some((t) => t.includes("what the buyer paid"))).toBe(true);
		// M-4: the ladder is a table so it READS DOWNWARD — `fields` is row-major
		// `grid-cols-2` (R-3), where five lines can never do that.
		const totals = tableWithId(orderPanel, "orders:totals");
		expect(columnLabels(totals)).toEqual(["Line", "Amount"]);
		expect(totals?.rows).toEqual([
			{ line: "Subtotal", amount: "$15.00" },
			{ line: "Discount", amount: "$0.00" },
			{ line: "Shipping", amount: "$0.00" },
			{ line: "Tax", amount: "$0.00" },
			{ line: "Total", amount: "$15.00" },
		]);
		expect(totals?.empty_text).toBeUndefined(); // the ladder always has five rows
	});

	test("the Customer group's LABEL carries the answer (D-6), and its body keeps identity, addresses, sessions and other orders — token-free", async () => {
		await boot();
		const blocks = await open("ord-1");
		const customer = group(blocks, "orders:ord-1:customer");
		expect(customer?.label).toBe("Customer — alice@example.com");
		expect(String(customer?.label).length).toBeLessThanOrEqual(60);
		expect(customer?.default_open).toBe(false);
		const body = groupBlocks(blocks, "orders:ord-1:customer");
		const values = fieldEntries(body);
		expect(values).toContain("Email=alice@example.com");
		expect(values).toContain("Name=Alice Example");
		expect(values).toContain("Account=cust-a");
		expect(values).toContain("Orders placed=3");
		// The three secondary collections are their own closed sub-groups, resolved
		// by `block_id` because their labels carry live counts (D-6).
		expect(group(blocks, "orders:ord-1:addresses")?.label).toBe("Saved addresses (1)");
		expect(group(blocks, "orders:ord-1:sessions")?.label).toBe("Sign-in sessions (1)");
		expect(group(blocks, "orders:ord-1:other-orders")?.label).toBe("Other orders (1)");
		expect(
			tableRows(groupBlocks(blocks, "orders:ord-1:addresses")).some((r) =>
				String(r.address ?? "").includes("1 Main St"),
			),
		).toBe(true);
		expect(tableRows(groupBlocks(blocks, "orders:ord-1:other-orders"))[0]?.id).toBe("ord-2");
		// The profile book is still labelled context-only (ADR-0009), in ≤200 chars.
		const disclaimer = contextTexts(groupBlocks(blocks, "orders:ord-1:addresses"));
		expect(disclaimer.some((t) => t.includes("context only"))).toBe(true);
		expect(disclaimer.every((t) => t.length <= 200)).toBe(true);
		// T-5: `Kind` is no longer badged — shipping/billing is a property, not
		// lifecycle state, and every badge renders identically (R-6).
		const addressTable = tableWithId(blocks, "orders:ord-1:addresses:table");
		expect(columnsOf(addressTable).filter((c) => c.format === "badge")).toEqual([]);
		// NOTHING token-like reaches the rendered blocks.
		expect(JSON.stringify(blocks)).not.toMatch(/token/i);
	});

	test("a GUEST order collapses three empty collections into ONE sentence and renders no empty sub-groups at all (D-7, P-3)", async () => {
		await boot();
		const blocks = await open("ord-guest");
		expect(group(blocks, "orders:ord-guest:customer")?.label).toBe(
			"Customer — alice@example.com (guest)",
		);
		expect(fieldEntries(blocks)).toContain("Account=Guest — no account");
		expect(fieldEntries(blocks)).toContain("Orders placed=1");
		expect(contextTexts(blocks)).toContain(
			"Guest checkout — no account, no saved addresses, no sign-in history.",
		);
		// The three heading+empty-table pairs are GONE, not rendered empty.
		expect(group(blocks, "orders:ord-guest:addresses")).toBeUndefined();
		expect(group(blocks, "orders:ord-guest:sessions")).toBeUndefined();
		expect(group(blocks, "orders:ord-guest:other-orders")).toBeUndefined();
	});

	test("a FAILING customer-context read degrades to a `context` line inside its own group — never a banner, never a failed screen (E-1, E-3)", async () => {
		await boot();
		const blocks = await open("ord-ctx-fail");
		// The detail survives in full.
		expect(findBlocks(blocks, "header").some((b) => b.text === "Order ord-ctx-fail")).toBe(true);
		expect(tableWithId(blocks, "orders:lines")).toBeDefined();
		expect(group(blocks, "orders:ord-ctx-fail:notes")).toBeDefined();
		// The group is present with an EXPLICIT unavailable body.
		const body = groupBlocks(blocks, "orders:ord-ctx-fail:customer");
		expect(contextTexts(body).some((t) => t.includes("Customer context unavailable"))).toBe(true);
		expect(findBlocks(blocks, "banner").some((b) => b.variant === "error")).toBe(false);
	});

	// -- panel "Fulfilment" ----------------------------------------------------

	test("ADR-0009: a captured ship-to is its own group with the address SPLIT across fields and the country/zone juxtaposition", async () => {
		await boot();
		const blocks = await open("ord-1");
		const ship = group(panel(blocks, "Fulfilment"), "orders:ord-1:ship");
		expect(ship?.label).toBe("Shipping address — US");
		const values = fieldEntries([ship!]);
		// §1: split into fields, never one long joined value the renderer truncates.
		expect(values).toContain("Address line 1=500 Shipping Ln");
		expect(values).toContain("City=Portland");
		expect(values).toContain("Postal code=97201");
		expect(values).toContain("Country=US");
		expect(values).toContain("Chosen shipping zone=zone-domestic");
	});

	test("ADR-0009: an order with NO captured ship-to gets ONE honest context line and no group (D-7)", async () => {
		await boot();
		const blocks = await open("ord-no-addr");
		expect(group(blocks, "orders:ord-no-addr:ship")).toBeUndefined();
		expect(
			contextTexts(panel(blocks, "Fulfilment")).some((t) =>
				t.includes("No shipping address captured"),
			),
		).toBe(true);
	});

	test("a PROCESSING order's Fulfilment group holds the record form — FIVE visible fields, the order id in the carrier (F-2)", async () => {
		await boot();
		const blocks = await open("ord-proc");
		const fulfilment = group(panel(blocks, "Fulfilment"), "orders:ord-proc:fulfilment");
		expect(fulfilment?.label).toBe("Fulfilment");
		expect(fulfilment?.default_open).toBe(true); // D-5 rank 2
		const form = formFor([fulfilment!], "orders:record-fulfillment");
		expect(fieldIds(form)).toEqual([
			"carrier",
			"trackingNumber",
			"trackingUrl",
			"shippedAt",
			"recordedBy",
		]);
		// The order id and the state watermark ride invisibly (B-3).
		expect(decodeCarrier(form?.block_id)).toMatchObject({
			orderId: "ord-proc",
			state: "processing",
		});
		expect(String(form?.submit && (form.submit as { label: string }).label)).toBe(
			"Record fulfilment & ship",
		);
		const contexts = contextTexts([fulfilment!]);
		expect(contexts.some((t) => t.includes("Recording ships this order"))).toBe(true);
		expect(contexts.every((t) => t.length <= 200)).toBe(true);
	});

	test("a PROCESSING order offers NO bare Mark-shipped and NO bare Mark-cancelled — each withheld with one `context` line and no control (DA-7)", async () => {
		await boot();
		const blocks = await open("ord-proc");
		expect(transitionStates(blocks)).toEqual(["refunded"]);
		const contexts = contextTexts(panel(blocks, "Fulfilment"));
		expect(contexts.some((t) => t.includes("no bare “Mark shipped”"))).toBe(true);
		expect(contexts.some((t) => t.includes("no bare “Mark cancelled”"))).toBe(true);
		expect(formFor(blocks, "orders:record-fulfillment")).toBeDefined();
	});

	test("a SHIPPED order with tracking shows the recorded fulfilment read-only, no form", async () => {
		await boot();
		const blocks = await open("ord-shipped");
		const fulfilment = group(blocks, "orders:ord-shipped:fulfilment");
		expect(fulfilment?.label).toBe("Fulfilment — UPS 1Z-999"); // D-6
		const values = fieldEntries([fulfilment!]);
		expect(values).toContain("Carrier=UPS");
		expect(values).toContain("Tracking number=1Z-999");
		expect(values).toContain("Shipped (UTC)=2026-07-11T09:00:00Z"); // no milliseconds
		expect(formFor(blocks, "orders:record-fulfillment")).toBeUndefined();
	});

	test("record-fulfillment form_submit POSTs tracking with Idempotency-Key + token, reading the order id from the CARRIER", async () => {
		await boot();
		const blocks = await open("ord-proc");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:record-fulfillment", {
			carrier: "UPS",
			trackingNumber: "1Z-777",
			trackingUrl: "https://track/1Z-777",
			shippedAt: "2026-07-11",
			recordedBy: "carol",
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-proc/fulfillment");
		expect(post!.headers["idempotency-key"]).toBe("admin-record-fulfillment:ord-proc");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		const body = post!.body as Record<string, string>;
		expect(body.carrier).toBe("UPS");
		expect(body.trackingNumber).toBe("1Z-777");
		expect(body.trackingUrl).toBe("https://track/1Z-777");
		expect(body.shippedAt).toBe("2026-07-11T00:00:00.000Z"); // bare date → full UTC
		expect(body.recordedBy).toBe("carol");
		expect(findBlocks(after, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Order shipped",
		);
	});

	test("record-fulfillment with a blank carrier or a non-http(s) tracking URL shows an inline error and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-proc");
		stub!.requests.length = 0;
		const blank = await submitForm(blocks, "orders:record-fulfillment", {
			carrier: "  ",
			trackingNumber: "1Z-1",
			recordedBy: "carol",
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(blank, "banner").find((b) => b.variant === "error")?.title).toBe(
			"Not shipped",
		);

		const bad = await submitForm(blocks, "orders:record-fulfillment", {
			carrier: "UPS",
			trackingNumber: "1Z-1",
			trackingUrl: "javascript:alert(1)",
			recordedBy: "carol",
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(bad, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("Not shipped");
		expect(String(banner?.description)).toContain("http://");
	});

	// -- DA-6 transitions ------------------------------------------------------

	test("DA-6: transitions are ONE `actions` block with DISTINCT per-state ids derived from ORDER_STATES — the React-key collision that forced one block per button is gone", async () => {
		await boot();
		const blocks = await open("ord-1");
		const actionBlocks = findBlocks(blocks, "actions").filter((b) =>
			((b.elements ?? []) as Array<Record<string, unknown>>).some((e) =>
				String(e.action_id).startsWith("orders:transition-"),
			),
		);
		expect(actionBlocks).toHaveLength(1);
		expect(actionBlocks[0]?.block_id).toBe("orders:transitions");
		expect(transitionStates(blocks).toSorted()).toEqual(["completed", "processing", "refunded"]);
		// R-13: within EVERY actions block, no two siblings share an `action_id`.
		for (const b of findBlocks(blocks, "actions")) {
			const ids = ((b.elements ?? []) as Array<Record<string, unknown>>).map((e) => e.action_id);
			expect(new Set(ids).size).toBe(ids.length);
		}
		// DA-5: only the irreversible move is danger, and it carries a confirm.
		const refunded = buttonWith(blocks, "orders:transition-refunded");
		expect(refunded?.style).toBe("danger");
		expect(refunded?.confirm).toBeDefined();
		expect(buttonWith(blocks, "orders:transition-processing")?.confirm).toBeUndefined();
	});

	test("DA-6: a service-offered state OUTSIDE the plugin's closed ORDER_STATES renders NO button and no blank page", async () => {
		await boot();
		const blocks = await open("ord-unknown");
		// The stub offered `teleported` + `completed`; only the known one renders.
		expect(transitionStates(blocks)).toEqual(["completed"]);
		expect(JSON.stringify(blocks)).not.toContain("teleported");
		// And the page is a real detail, not the `{blocks: []}` dead-end.
		expect(findBlocks(blocks, "header").some((b) => b.text === "Order ord-unknown")).toBe(true);
	});

	test("a transition button POSTs with a content-derived Idempotency-Key and re-renders the detail", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await click(buttonWith(blocks, "orders:transition-processing"));
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-1/transition");
		expect(post!.headers["idempotency-key"]).toBe("admin-transition:ord-1:processing");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect((post!.body as { toState: string }).toState).toBe("processing");
		expect(findBlocks(after, "header").some((b) => b.text === "Order ord-1")).toBe(true);
	});

	test("a no-op transition (ok but transitioned:false) re-renders the detail with a NON-error notice", async () => {
		await boot();
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:transition-paid", // already paid ⇒ transitioned:false
				value: { orderId: "ord-1", toState: "paid" },
			}),
		);
		expect(findBlocks(after, "header").some((b) => b.text === "Order ord-1")).toBe(true);
		const banner = findBlock(after, "banner");
		expect(banner?.variant).not.toBe("error");
		expect(banner?.title).toBe("No change");
	});

	// -- reconciliation --------------------------------------------------------

	test("a FLAGGED order shows the alert banner OUTSIDE the tabs (D-1) and the resolve form inside a Fulfilment group opened by D-5 rank 1", async () => {
		await boot();
		const blocks = await open("ord-flagged");
		// The banner is a TOP-LEVEL block: a state demanding action must never sit
		// where a tab can hide it.
		const alert = blocks.filter((b) => b.type === "banner").find((b) => b.variant === "alert");
		expect(alert?.title).toBe("Needs reconciliation");
		expect(String(alert?.description)).toContain("commit lost for reservation res-1");
		expect(String(alert?.description).length).toBeLessThanOrEqual(240);
		expect(fieldEntries(blocks)).toContain("Reconciliation=⚠ Needs reconciliation");

		const reconcile = group(panel(blocks, "Fulfilment"), "orders:ord-flagged:reconcile");
		expect(reconcile?.label).toBe("Resolve reconciliation");
		expect(reconcile?.default_open).toBe(true);
		const form = formFor([reconcile!], "orders:resolve-reconciliation");
		// THREE visible fields: the order id and the reviewed anomaly moved into the
		// carrier (they were two `select`s labelled `orderId` and `expectedFlag`).
		expect(fieldIds(form)).toEqual(["outcome", "reason", "resolvedBy"]);
		expect(decodeCarrier(form?.block_id)).toMatchObject({
			orderId: "ord-flagged",
			expectedFlag: "commit lost for reservation res-1",
		});
		// The disposition copy still reads as a RECORD, never a money movement.
		const refundedOption = (
			(field(form, "outcome")?.options ?? []) as Array<Record<string, unknown>>
		).find((o) => o.value === "refunded");
		expect(String(refundedOption?.label)).toContain("records the disposition");
		expect(String(refundedOption?.label)).toContain("Refunds");
		expect(contextTexts([reconcile!]).some((t) => t.includes("moves no money"))).toBe(true);
	});

	test("a RESOLVED order shows the recorded disposition read-only, closed, and NO resolve form", async () => {
		await boot();
		const blocks = await open("ord-resolved");
		const reconcile = group(blocks, "orders:ord-resolved:reconcile");
		expect(reconcile?.label).toBe("Reconciliation — resolved (fulfilled)");
		expect(reconcile?.default_open).toBe(false);
		const values = fieldEntries([reconcile!]);
		expect(values).toContain("Outcome=fulfilled");
		expect(values).toContain("Resolved by=ops@shop.test");
		expect(values).toContain("Resolved (UTC)=2026-07-10T02:00:00Z");
		expect(formFor(blocks, "orders:resolve-reconciliation")).toBeUndefined();
		expect(
			findBlocks(blocks, "banner").some(
				(b) => b.variant === "alert" && b.title === "Needs reconciliation",
			),
		).toBe(false);
		expect(fieldEntries(blocks)).toContain("Reconciliation=Resolved (fulfilled)");
	});

	test("resolve form_submit POSTs the disposition WITH the carried expectedFlag, and a STALE one surfaces the reload notice with nothing cleared", async () => {
		await boot();
		const blocks = await open("ord-flagged");
		stub!.requests.length = 0;
		await submitForm(blocks, "orders:resolve-reconciliation", {
			outcome: "refunded",
			reason: "refunded the buyer",
			resolvedBy: "carol",
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-flagged/resolve-reconciliation");
		expect(post!.headers["idempotency-key"]).toBe("admin-resolve-reconciliation:ord-flagged");
		expect(post!.body).toEqual({
			expectedFlag: "commit lost for reservation res-1",
			outcome: "refunded",
			reason: "refunded the buyer",
			resolvedBy: "carol",
		});

		// A STALE carried flag (an anomaly the admin reviewed before a new one landed)
		// is a 409 from the compare-and-clear, and gets its own copy.
		stub!.requests.length = 0;
		const stale = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:resolve-reconciliation",
				values: { outcome: "written_off", reason: "reviewed the old one", resolvedBy: "carol" },
				block_id: encodeCarrier("orders:reconcile", {
					orderId: "ord-flagged",
					expectedFlag: "an older anomaly the admin reviewed",
				}),
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(true);
		const banner = findBlocks(stale, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("The reconciliation state changed — reload");
		expect(String(banner?.description)).toContain("Nothing was cleared");
	});

	test("resolve with a blank reason shows an inline error and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-flagged");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:resolve-reconciliation", {
			outcome: "fulfilled",
			reason: "   ",
			resolvedBy: "carol",
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
			"Not resolved",
		);
	});

	// -- DA-2b / DA-3 cancellation --------------------------------------------

	test("DA-2b: a cancellable order offers ONE danger button PER REASON, each with a confirm NAMING that reason — and no form submit can cancel (DA-1)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const cancel = group(panel(blocks, "Fulfilment"), "orders:ord-1:cancel");
		expect(cancel?.label).toBe("Cancel order");
		expect(cancel?.default_open).toBe(false); // ALWAYS, for anything destructive
		const reasonButtons = buttons([cancel!]).filter((e) =>
			String(e.action_id).startsWith("orders:cancel-"),
		);
		expect(reasonButtons.map((e) => e.action_id)).toEqual([
			"orders:cancel-customer_request",
			"orders:cancel-fraud_suspected",
			"orders:cancel-out_of_stock",
			"orders:cancel-pricing_error",
			"orders:cancel-other",
		]);
		for (const b of reasonButtons) {
			expect(b.style).toBe("danger");
			const confirm = confirmOf(b);
			expect(String(confirm.text).length).toBeLessThanOrEqual(200);
			expect(String(confirm.title).length).toBeLessThanOrEqual(60);
			expect(confirm.confirm).toBe("Yes, cancel the order");
			expect(confirm.deny).toBe("Keep the order");
			// The watermark the operator saw rides in `value` (DA-3a).
			expect(b.value).toMatchObject({ orderId: "ord-1", state: "paid" });
		}
		expect(String(confirmOf(reasonButtons[2]).text)).toContain("Out of stock");
		// DA-1: nothing on this screen cancels via a form submit.
		expect(formFor(blocks, "orders:cancel")).toBeUndefined();
		// And no bare Mark-cancelled transition (this slice's steering).
		expect(transitionStates(blocks)).not.toContain("cancelled");
		// The irreversibility banner sits INSIDE the group, so §2 does not count it.
		expect(findBlocks([cancel!], "banner")[0]?.title).toBe("Cancelling is permanent");
	});

	test("DA-2b: clicking a reason button re-reads the order, then POSTs with the content-derived key", async () => {
		await boot();
		const blocks = await open("ord-proc");
		stub!.requests.length = 0;
		const after = await click(buttonWith(blocks, "orders:cancel-out_of_stock"));
		// DA-3a: the re-read happens BEFORE the write.
		const reads = stub!.requests.filter((r) => r.method === "GET");
		expect(reads.length).toBeGreaterThan(0);
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-proc/cancel");
		expect(post!.headers["idempotency-key"]).toBe("admin-cancel:ord-proc");
		expect((post!.body as Record<string, string>).reason).toBe("out_of_stock");
		expect(findBlocks(after, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Order cancelled",
		);
	});

	test("DA-3a: a cancel whose observed state no longer matches applies NOTHING and names both states", async () => {
		await boot();
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:cancel-out_of_stock",
				// `ord-1` is `paid`; the operator staged this while it read `pending`.
				value: { orderId: "ord-1", reason: "out_of_stock", state: "pending" },
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("The order changed — nothing was cancelled");
		expect(String(banner?.description)).toContain("pending");
		expect(String(banner?.description)).toContain("paid");
	});

	test("DA-3: `Review cancellation` stages the free text — the group gets a CHANGED block_id AND default_open true, and one danger confirm appears (B-6, X-29)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const noteForm = formFor(blocks, "orders:cancel-review");
		expect(group(blocks, "orders:ord-1:cancel-note")?.default_open).toBe(false);
		stub!.requests.length = 0;
		const staged = await submitForm(blocks, "orders:cancel-review", {
			reason: "other",
			detail: "chargeback risk flagged",
			cancelledBy: "carol",
		});
		// A `-review` writes NOTHING.
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		// BOTH halves of the force-open. Only the id half and the whole thing snaps
		// shut on the operator, hiding the confirm they just asked for.
		expect(group(staged, "orders:ord-1:cancel")).toBeUndefined();
		const review = group(staged, "orders:ord-1:cancel:review");
		expect(review?.default_open).toBe(true);
		expect(openGroupIds(staged)).toEqual(["orders:ord-1:cancel:review"]);
		// THE SAME FORM, remounted with the staged values — there is no "Change
		// details" action and no `fields` echo of the payload.
		const restaged = formFor([review!], "orders:cancel-review");
		expect(field(restaged, "reason")?.initial_value).toBe("other");
		expect(field(restaged, "detail")?.initial_value).toBe("chargeback risk flagged");
		expect(field(restaged, "cancelledBy")?.initial_value).toBe("carol");
		expect(restaged?.block_id).not.toBe(noteForm?.block_id); // prefill ⇒ new key (B-3a)
		// Exactly one danger confirm, carrying the staged payload and the watermark.
		const confirm = buttonWith(staged, "orders:cancel");
		expect(confirm?.style).toBe("danger");
		expect(confirm?.value).toMatchObject({
			orderId: "ord-1",
			reason: "other",
			detail: "chargeback risk flagged",
			cancelledBy: "carol",
			state: "paid",
		});
		// The DA-2b reason buttons are gone in state 2 — one refund/cancel control
		// at a time.
		expect(buttonWith(staged, "orders:cancel-out_of_stock")).toBeUndefined();

		// Confirming writes, carrying the detail through.
		const after = await click(confirm);
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-1/cancel");
		expect((post!.body as Record<string, string>).detail).toBe("chargeback risk flagged");
		expect(findBlocks(after, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Order cancelled",
		);
	});

	test("cancel review with a blank `Cancelled by` shows an inline error, stages nothing and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:cancel-review", {
			reason: "customer_request",
			cancelledBy: "  ",
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
			"Not cancelled",
		);
		expect(group(after, "orders:ord-1:cancel:review")).toBeUndefined();
	});

	test("an already-cancelled order shows the recorded reason read-only; one cancelled WITHOUT a reason says so honestly — neither offers a control", async () => {
		await boot();
		const withReason = await open("ord-cancelled");
		const recorded = group(withReason, "orders:ord-cancelled:cancel");
		expect(recorded?.label).toBe("Cancelled — out_of_stock"); // D-6
		const values = fieldEntries([recorded!]);
		expect(values).toContain("Reason=out_of_stock");
		expect(values).toContain("Detail=last unit sold on another channel");
		expect(values).toContain("Cancelled by=ops@shop.test");
		expect(values).toContain("Cancelled (UTC)=2026-07-11T09:00:01Z");
		expect(
			buttons(withReason).filter((e) => String(e.action_id).startsWith("orders:cancel")),
		).toEqual([]);

		const bare = await open("ord-cancelled-bare");
		const group2 = group(bare, "orders:ord-cancelled-bare:cancel");
		expect(group2?.label).toBe("Cancellation — no reason recorded");
		expect(contextTexts([group2!]).some((t) => t.includes("no reason was recorded"))).toBe(true);
		expect(buttons(bare).filter((e) => String(e.action_id).startsWith("orders:cancel"))).toEqual(
			[],
		);
	});

	// -- panel "Money": refunds (ADR-0008 + DA-2b/DA-3/DA-3a/F-2a) -------------

	test("the Money panel holds the derived totals, the refunds group's D-6 label, a `meter` with a MANDATORY custom_value, and the ledger", async () => {
		await boot();
		const blocks = await open("ord-1");
		const money = panel(blocks, "Money");
		expect(fieldEntries(money)).toEqual([
			"Captured=$15.00",
			"Refunded=$5.00",
			"Remaining=$10.00",
			"Refunds recorded=1 refund",
		]);
		// P-3: `Payment` is on the identity strip and is NOT repeated here.
		expect(fieldEntries(money).some((v) => v.startsWith("Payment="))).toBe(false);
		const refunds = group(money, "orders:ord-1:refunds");
		expect(refunds?.label).toBe("Refunds — $5.00 of $15.00 refunded"); // D-6
		expect(refunds?.default_open).toBe(false);
		// M-8: `meter` has no currency, so `custom_value` is mandatory over money.
		const meter = findBlock([refunds!], "meter");
		expect(meter?.value).toBe(500);
		expect(meter?.max).toBe(1500);
		expect(meter?.custom_value).toBe("$5.00 of $15.00");
		const ledger = tableWithId(blocks, "orders:ord-1:refunds:table");
		expect(columnLabels(ledger)).toEqual(["Amount", "Kind", "Provider ref", "By", "When"]);
		expect(contextTexts([refunds!]).some((t) => t.includes("REAL refund through Stripe"))).toBe(
			true,
		);
		expect(contextTexts([refunds!]).every((t) => t.length <= 200)).toBe(true);
	});

	test("DA-2b: the majority path is ONE danger button for the full remaining balance, carrying the amount AND the observed watermark (F-2a)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const full = buttonWith(blocks, "orders:refund");
		expect(full?.label).toBe("Refund $10.00 (full remaining)");
		expect(full?.style).toBe("danger");
		expect(full?.value).toMatchObject({
			orderId: "ord-1",
			amountCents: "1000", // money crosses as its integer minor-unit STRING (B-2)
			refundedSoFarCents: "500", // the watermark the operator SAW
			currency: "USD",
		});
		const confirm = confirmOf(full);
		expect(confirm.title).toBe("Refund $10.00?");
		expect(confirm.text).toBe(
			"Refund $10.00 to cust-a? This sends the money back through Stripe and cannot be reversed.",
		);
		expect(String(confirm.text).length).toBeLessThanOrEqual(200);
		expect(confirm.confirm).toBe("Yes, refund $10.00");
		// DA-1: no form submit can refund.
		expect(formFor(blocks, "orders:refund")).toBeUndefined();
	});

	test("the DA-3 partial-refund form has THREE visible fields and carries the order id, currency and watermark — the `nonce` select is DELETED, not relocated (F-2a)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const partial = group(blocks, "orders:ord-1:refund-partial");
		expect(partial?.label).toBe("Refund a different amount");
		expect(partial?.default_open).toBe(false);
		const form = formFor([partial!], "orders:refund-review");
		expect(fieldIds(form)).toEqual(["amount", "reason", "refundedBy"]);
		expect(decodeCarrier(form?.block_id)).toMatchObject({
			orderId: "ord-1",
			currency: "USD",
			refundedSoFar: "500",
		});
		expect(Object.keys(decodeCarrier(form?.block_id) ?? {})).not.toContain("nonce");
		// M-3: money input is TEXT, defaulted to the full remaining.
		expect(field(form, "amount")?.type).toBe("text_input");
		expect(field(form, "amount")?.initial_value).toBe("10.00");
		expect(field(form, "amount")?.label).toBe("Refund amount (USD)");
	});

	test("DA-3: `Review refund` stages the amount — the refunds group carries `:review` AND default_open true, with exactly one danger confirm and no rival refund control (B-6, X-18, X-29)", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const staged = await submitForm(blocks, "orders:refund-review", {
			amount: "4.00",
			reason: "damaged",
			refundedBy: "carol",
		});
		// A `-review` writes NOTHING.
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(group(staged, "orders:ord-1:refunds")).toBeUndefined();
		const review = group(staged, "orders:ord-1:refunds:review");
		expect(review?.default_open).toBe(true);
		expect(openGroupIds(staged)).toEqual(["orders:ord-1:refunds:review"]);
		// THE SAME FORM remounted with the staged amount.
		const restaged = formFor([review!], "orders:refund-review");
		expect(field(restaged, "amount")?.initial_value).toBe("4.00");
		expect(field(restaged, "refundedBy")?.initial_value).toBe("carol");
		// Exactly one refund button, and it is the confirm — the DA-2b full-remaining
		// button and the nested partial accordion are both gone in state 2.
		const refundButtons = buttons(staged).filter((e) => e.action_id === "orders:refund");
		expect(refundButtons).toHaveLength(1);
		expect(refundButtons[0]?.label).toBe("Refund $4.00");
		expect(refundButtons[0]?.value).toMatchObject({
			orderId: "ord-1",
			amountCents: "400",
			refundedSoFarCents: "500",
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(group(staged, "orders:ord-1:refund-partial")).toBeUndefined();
		// The ledger stays visible beside it — the confirm text tells them to check it.
		expect(tableWithId(staged, "orders:ord-1:refunds:table")).toBeDefined();
	});

	test("F-2a: the refund key is `admin-refund:<order>:<amount>:<watermark>` — content plus the OBSERVED watermark, never a nonce", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await click(buttonWith(blocks, "orders:refund"));
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-1/refund");
		// remaining 1000, refunded-so-far 500 — both from what was RENDERED.
		expect(post!.headers["idempotency-key"]).toBe("admin-refund:ord-1:1000:500");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.body).toEqual({
			amountCents: 1000, // integer minor units, no float
			currency: "USD",
			refundedBy: "admin",
		});
		expect(findBlocks(after, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Refund complete",
		);
	});

	test("F-2a: the SAME button clicked twice derives the SAME key (a double-click dedupes) and the replay renders `Already refunded`", async () => {
		await boot();
		const blocks = await open("ord-1");
		const full = buttonWith(blocks, "orders:refund");
		stub!.requests.length = 0;
		await click(full);
		const firstKey = stub!.requests.find((r) => r.method === "POST")!.headers["idempotency-key"];

		// The stub answers the replay as the domain does: ok + duplicate, ledger
		// unchanged. (Reachable today — `refundOrder` resolves by KEY ALONE with no
		// amount comparison, which is why the key must be content-derived.)
		stub!.respondWith("POST", (req) => {
			if (req.url.includes("/refund")) {
				return {
					status: 200,
					body: { ok: true, recorded: false, duplicate: true, fullyRefunded: false },
				};
			}
			return { status: 404, body: { error: "unknown" } };
		});
		stub!.requests.length = 0;
		const replay = await click(full);
		const secondKey = stub!.requests.find((r) => r.method === "POST")!.headers["idempotency-key"];
		expect(secondKey).toBe(firstKey);
		expect(findBlocks(replay, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Already refunded",
		);
	});

	test("DA-3a: a refund whose observed watermark no longer matches the ledger applies NOTHING and names both figures", async () => {
		await boot();
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:refund",
				// Operator A staged the full $15.00 when nothing had been refunded;
				// operator B then refunded $5.00, so the ledger's watermark is now 500.
				value: {
					orderId: "ord-1",
					amountCents: "1500",
					refundedSoFarCents: "0",
					currency: "USD",
					reason: "",
					refundedBy: "carol",
				},
			}),
		);
		// The re-read happened; the write did NOT.
		expect(stub!.requests.some((r) => r.method === "GET")).toBe(true);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(String(banner?.description)).toContain("$15.00 was staged");
		expect(String(banner?.description)).toContain("$10.00 now remains refundable");
		expect(String(banner?.description).length).toBeLessThanOrEqual(240);
	});

	test("refund review with a blank or zero amount stages nothing and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		for (const amount of ["  ", "0", "abc"]) {
			const after = await submitForm(blocks, "orders:refund-review", {
				amount,
				refundedBy: "carol",
			});
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
				"Not refunded",
			);
			expect(group(after, "orders:ord-1:refunds:review")).toBeUndefined();
		}
	});

	test("an over-refund (409 REFUND_EXCEEDS_TOTAL) surfaces the amount-too-high notice with nothing changed and no status leak", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const staged = await submitForm(blocks, "orders:refund-review", {
			amount: "99.99", // 9999 > remaining 1000
			refundedBy: "carol",
		});
		const after = await click(buttonWith(staged, "orders:refund"));
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(true);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("Amount too high");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/|409/);
	});

	test("DA-7: with nothing left to refund there is NO refund control at all, just one line saying why", async () => {
		await boot();
		const blocks = await open("ord-refunded");
		const refunds = group(blocks, "orders:ord-refunded:refunds");
		expect(refunds?.label).toBe("Refunds — $15.00 of $15.00 refunded");
		expect(contextTexts([refunds!])).toContain("Fully refunded — nothing left to refund.");
		expect(buttonWith(blocks, "orders:refund")).toBeUndefined();
		expect(formFor(blocks, "orders:refund-review")).toBeUndefined();
		expect(group(blocks, "orders:ord-refunded:refund-partial")).toBeUndefined();
	});

	test("an x402 order is RECORD-ONLY, and says so honestly in ≤200 chars (ADR-0008)", async () => {
		await boot();
		const blocks = await open("ord-x402");
		const refunds = group(blocks, "orders:ord-x402:refunds");
		const capability = contextTexts([refunds!]).find((t) => t.includes("RECORD-ONLY"));
		expect(capability).toContain("on-chain (x402)");
		expect(capability!.length).toBeLessThanOrEqual(200);
		// The confirm names the record-only consequence rather than a money movement.
		expect(String(confirmOf(buttonWith(blocks, "orders:refund")).text)).toContain(
			"it does not move money",
		);
		// An empty ledger is not rendered as an empty table (P-3).
		expect(tableWithId(blocks, "orders:ord-x402:refunds:table")).toBeUndefined();
	});

	test("a FAILING refunds read degrades the whole Money panel to one `context` line (E-1)", async () => {
		await boot();
		stub!.respondWith("GET", (req) => {
			if (req.url.includes("/refunds")) return { status: 500, body: { ok: false } };
			return makeGetResponder()(req);
		});
		const blocks = await open("ord-1");
		const money = panel(blocks, "Money");
		expect(money.map((b) => b.type)).toEqual(["context"]);
		expect(String(money[0]?.text)).toContain("Refunds are unavailable right now");
		expect(findBlocks(blocks, "banner").some((b) => b.variant === "error")).toBe(false);
	});

	// -- panel "History" -------------------------------------------------------

	test("the History panel holds the timeline table plus a Notes group whose label carries the count (D-6)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const history = panel(blocks, "History");
		const timeline = tableWithId(history, "orders:timeline");
		expect(columnLabels(timeline)).toEqual(["When", "Event", "Who", "Detail"]);
		const whats = tableRows([timeline!]).map((r) => r.what);
		expect(whats).toContain("Order created");
		expect(whats).toContain("Status → paid");
		expect(whats).toContain("Note added");
		expect(whats).toContain("Fulfilment recorded");
		const fulfilRow = tableRows([timeline!]).find((r) => r.what === "Fulfilment recorded");
		expect(fulfilRow?.who).toBe("ops@shop.test");
		expect(String(fulfilRow?.detail)).toContain("1Z-999");
		expect(contextTexts(history).some((t) => t.includes("audit log"))).toBe(true);

		const notes = group(history, "orders:ord-1:notes");
		expect(notes?.label).toBe("Notes (2)");
		expect(notes?.default_open).toBe(false);
		const noteRows = tableRows([notes!]);
		expect(noteRows.some((r) => r.body === "Customer asked to gift-wrap.")).toBe(true);
		expect(noteRows.some((r) => r.body === "Called the customer back.")).toBe(true);
	});

	test("a historical order (stateChangesAudited:false) keeps its partial-timeline caption in ≤200 chars", async () => {
		await boot();
		const history = panel(await open("ord-proc"), "History");
		const contexts = contextTexts(history);
		expect(contexts.some((t) => /predate the audit log/i.test(t))).toBe(true);
		expect(contexts.every((t) => t.length <= 200)).toBe(true);
	});

	test("a FAILING timeline read degrades to a `context` line and keeps the Notes group (E-1, E-3)", async () => {
		await boot();
		stub!.respondWith("GET", (req) => {
			if (req.url.includes("/timeline")) return { status: 500, body: { ok: false } };
			return makeGetResponder()(req);
		});
		const blocks = await open("ord-1");
		const history = panel(blocks, "History");
		expect(tableWithId(history, "orders:timeline")).toBeUndefined();
		expect(contextTexts(history).some((t) => t.includes("Timeline unavailable"))).toBe(true);
		expect(group(history, "orders:ord-1:notes")).toBeDefined();
	});

	test("the add-note form is TWO fields in F-1's order (what changes, then attribution) with the order id in the carrier", async () => {
		await boot();
		const blocks = await open("ord-1");
		const form = formFor(panel(blocks, "History"), "orders:add-note");
		expect(fieldIds(form)).toEqual(["body", "author"]);
		expect(field(form, "body")?.multiline).toBe(true); // F-6: free text over one line
		expect(decodeCarrier(form?.block_id)).toMatchObject({ orderId: "ord-1" });
		expect(fieldIds(form)).not.toContain("orderId");
	});

	test("add-note form_submit POSTs the note with a content-derived Idempotency-Key + token", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:add-note", {
			author: "carol",
			body: "Packed and shipped.",
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-1/notes");
		expect(post!.headers["idempotency-key"]).toBe("admin-note:ord-1:carol:Packed and shipped.");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect((post!.body as { author: string; body: string }).author).toBe("carol");
		expect(findBlocks(after, "header").some((b) => b.text === "Order ord-1")).toBe(true);
		expect(group(after, "orders:ord-1:notes")).toBeDefined();
	});

	test("add-note with a blank body shows an inline error and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:add-note", { author: "carol", body: "   " });
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(after, "header").some((b) => b.text === "Order ord-1")).toBe(true);
		expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
			"Note not added",
		);
	});

	// -- DA-3b: an undecodable payload never silently redirects -----------------

	test("DA-3b: an action whose payload cannot be read renders an `error` notice on a working screen, never a silent bounce to the list", async () => {
		await boot();
		for (const interaction of [
			{ type: "block_action", action_id: "orders:refund", value: { nope: 1 } },
			{ type: "block_action", action_id: "orders:cancel-out_of_stock", value: {} },
			{ type: "block_action", action_id: "orders:transition-processing", value: {} },
			{ type: "form_submit", action_id: "orders:add-note", values: { body: "x", author: "y" } },
			{ type: "form_submit", action_id: "orders:refund-review", values: { amount: "1.00" } },
		]) {
			stub!.requests.length = 0;
			const blocks = blocksOf(await sandbox!.invokeRoute("admin", interaction));
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
			expect(banner, `no error banner for ${interaction.action_id}`).toBeDefined();
			expect(String(banner?.description)).toContain("Nothing was changed");
			// And the operator still has a usable screen.
			expect(findBlocks(blocks, "header").length).toBeGreaterThan(0);
			expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/|\d{3}$/);
		}
	});

	test("the banned slogan appears in no rendered string on either level (X-20)", async () => {
		await boot();
		const rendered = JSON.stringify([await list(), await open("ord-1"), await open("ord-proc")]);
		expect(rendered.toLowerCase()).not.toMatch(/oversell|oversold|overselling/);
	});
});
