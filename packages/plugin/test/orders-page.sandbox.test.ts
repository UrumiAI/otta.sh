import { afterEach, describe, expect, test } from "vitest";
import { ORDER_STATE_MACHINE } from "@otta-sh/domain";
import { decodeCarrier, encodeCarrier } from "../src/admin/scaffold/carrier.js";
import { decodeListCursor } from "../src/admin/scaffold/nav.js";
import {
	SHORT_ID_CONFIRM_LEN,
	SHORT_ID_MIN,
	shortIdFixed,
	shortIdsFor,
} from "../src/admin/scaffold/short-id.js";
import { assertBlockContract } from "./helpers/block-contract.js";
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

/**
 * THE LIST FIXTURES ARE UUID-SHAPED ON PURPOSE (D4 / the UUID display rule).
 *
 * Every OTHER fixture in this file uses a readable synthetic id (`ord-1`,
 * `ord-x402`) because the assertion around it is about a record STATE, and a
 * name that says which state reads better in a failure message. The list is the
 * exception: the picker's short-id rule is a claim about the shape of a real
 * order id — 36 characters, no human structure, indistinguishable from its
 * neighbours until several characters in — and `ord-1`/`ord-2` diverge at
 * character 5 of 5, which makes "shortest UNIQUE prefix" vacuous (the prefix
 * would BE the whole id, which is also what the M-7/X-22 contract check
 * forbids in an option label). These four are what the service actually
 * returns, so the tests below measure the real thing.
 *
 * `LIST_ID_1` / `LIST_ID_2` diverge at character 1 — the ordinary case, where
 * the 4-character floor stands. `TWIN_ID_A` / `TWIN_ID_B` agree for 5 and force
 * the extend path, and their summaries are otherwise IDENTICAL (same customer,
 * same total, same state), which is the collision that motivated this rule.
 */
const LIST_ID_1 = "7e4ce728-1b3f-4a5e-9c21-0d5f6a7b8c90";
const LIST_ID_2 = "b91d4a02-77c6-4e18-8f30-2a6b5c4d3e1f";
const TWIN_ID_A = "3f8a1c05-4d2e-4f61-8a70-5b6c7d8e9f01";
const TWIN_ID_B = "3f8a1d90-2e6b-4c37-9d84-1a2b3c4d5e6f";

const SUMMARY_1 = {
	id: LIST_ID_1,
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
	id: LIST_ID_2,
	state: "shipped",
	currency: "USD",
	buyerRef: "bob@example.com",
	customerId: null,
	paymentMethod: "x402",
	createdAt: "2026-07-11T01:00:00.000Z",
	totalCents: 2000,
	reconciliationFlag: false,
};

/**
 * D4's motivating case, in one fixture pair: one repeat customer, two orders,
 * SAME total and SAME state. Everything the old picker label was built from is
 * identical — only the id differs, and it differs late enough (character 6) to
 * exercise the extend-on-collision path rather than the 4-character floor.
 *
 * The `twins` page serves them ALONGSIDE `SUMMARY_2` rather than alone, for two
 * reasons. The load-bearing one: a page of nothing but twins has one `Status`
 * value in every row, and X-4 rejects a badge column that cannot chunk two
 * values apart — so a twins-only page could never go through the §15 V-3 sweep,
 * and the render state this increment introduces would be the one state nothing
 * mechanically checked. The second: it makes the page assert both halves of
 * "extends ONLY on collision" at once — the twins go to six characters while
 * their uncolliding neighbour stays at the four-character floor.
 */
const SUMMARY_TWIN_A = { ...SUMMARY_1, id: TWIN_ID_A };
const SUMMARY_TWIN_B = { ...SUMMARY_1, id: TWIN_ID_B };

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

/**
 * A guest order whose buyer handle is long enough to blow the confirm dialog's
 * 200-character budget (§1/X-11) — the fixture that drives `refundConfirmText`'s
 * recipient-dropping fallback, which D4 must survive without giving up the order
 * id. 114 characters: the named form is `100 + recipient.length` at this amount,
 * so anything past 100 takes the fallback.
 */
const ORDER_LONG_BUYER = {
	...ORDER_1,
	id: "ord-long-buyer",
	customerId: null,
	buyerRef: `${"long.handle.".repeat(8)}buyer@example.test`,
};

// M-11 / D-6b: an order whose CAPTURE is smaller than its total. Both figures are
// honest; together they are a contradiction the operator otherwise has to leave the
// console to resolve, and the D-6 ratio degenerates to `$0.00 of $0.00`.
const ORDER_UNCAPTURED = { ...ORDER_1, id: "ord-uncaptured" };
const REFUNDS_UNCAPTURED = {
	refunds: [],
	currency: "USD",
	capturedTotalCents: 0,
	refundedTotalCents: 0,
	ceilingCents: 0,
	remainingCents: 0,
	paymentMethod: "stripe",
	refundable: false,
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

/**
 * The order state machine the stub serves `allowedTransitions` from — THE DOMAIN'S
 * OWN TABLE, imported, not restated.
 *
 * WHY IMPORTED. This fixture is standing in for the service, and the service's answer
 * is literally `[...legalNextStates(order.state)]` off this map
 * (`service/src/routes/admin.ts:185`), unnarrowed. So the map IS the wire shape; a
 * second copy of it is not an independent statement of the contract, it is an
 * unverified guess that happens to agree today.
 *
 * WHAT A COPY COSTS, MEASURED. The hand-written version this replaces offered
 * `processing` FROM `shipped` — a transition `ORDER_STATE_MACHINE` forbids outright —
 * while omitting the legal `delivered`. It passed for as long as it existed, because a
 * copy is only ever checked against itself: the suite was asserting the plugin's
 * behaviour on a wire shape the service cannot produce. A more careful copy has the
 * same failure mode; only the import removes it. When the domain adds a row, this
 * suite now renders it or fails, and either is information.
 *
 * IT DOES NOT BREAK SANDBOX PURITY. `packages/plugin/src/**` still imports
 * `@otta-sh/domain` nowhere — that constraint is on the bundle. Test files run in Node
 * with workspace resolution and the harness copies `src/` only, which is the same
 * ground `money-parity.test.ts` stands on (`@otta-sh/domain` is a devDependency here).
 * Nor is it circular: the code under test is `src/admin/orders-page.ts`, which has its
 * own hand-maintained closed `ORDER_STATES` list (DA-6) and never reads this map.
 *
 * `shipped: ["delivered", "refunded"]` is the row that settles a real question:
 * `shipped → refunded` IS legal, so the console really can offer `Mark refunded` on a
 * shipped order. That is why a transition carries a watermark (DA-2a) — see the test
 * that asserts it against this fixture.
 */
/** Widened to a string key: the stub looks up by the wire `state` string, including
 *  `ord-unknown`'s deliberately off-list one (`noUncheckedIndexedAccess`). */
const ALLOWED_BY_STATE: Record<string, readonly string[]> = ORDER_STATE_MACHINE;

/** A GET responder for the guarded list + detail reads (200 only WITH the admin
 *  token, else 401 — mirroring the service guard). Distinguishes list vs detail
 *  by path, and page1 vs page2 by the `cursor=` query param. */
/** Per-test switch for the LIST read, so the two zero-row branches (E-2's `empty`
 *  block when unfiltered, `empty_text` when filtered) are both reachable — and,
 *  for D4, so is a page of two orders a human cannot tell apart (`twins`). */
let listRows: "two" | "none" | "twins" = "two";

/**
 * Detail reads for the ids the LIST offers, so a test can walk from a picker
 * option to that order's own refund confirm and compare the two short ids. The
 * record STATE is `ORDER_1`'s throughout — these fixtures exist to carry an id,
 * and every state-specific assertion has its own `ord-*` fixture above.
 */
const LIST_DETAILS: Record<string, typeof ORDER_1> = {
	[LIST_ID_1]: { ...ORDER_1, id: LIST_ID_1 },
	[LIST_ID_2]: { ...ORDER_1, id: LIST_ID_2 },
	[TWIN_ID_A]: { ...ORDER_1, id: TWIN_ID_A },
	[TWIN_ID_B]: { ...ORDER_1, id: TWIN_ID_B },
};

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
			if (listRows === "twins") {
				return {
					status: 200,
					body: {
						ok: true,
						orders: [SUMMARY_TWIN_A, SUMMARY_TWIN_B, SUMMARY_2],
						nextCursor: null,
					},
				};
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
					: path.includes("/ord-uncaptured")
						? REFUNDS_UNCAPTURED
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
			// The uuid-keyed list fixtures first — they carry no `ord-` marker for the
			// substring chain below to recognise.
			const listed = Object.entries(LIST_DETAILS).find(([id]) => path.includes(`/${id}`));
			const order =
				listed !== undefined
					? listed[1]
					: path.includes("/ord-long-buyer")
						? ORDER_LONG_BUYER
						: path.includes("/ord-uncaptured")
							? ORDER_UNCAPTURED
							: path.includes("/ord-no-addr")
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
			// State-appropriate transitions, DERIVED THE WAY THE REAL SERVICE DERIVES
			// THEM: `service/src/routes/admin.ts:185` returns `[...legalNextStates(state)]`
			// with no narrowing whatsoever, so this reads the SAME imported map (see
			// ALLOWED_BY_STATE above) rather than a second copy of it. That fidelity is
			// load-bearing for two assertions below: a `processing` order's legal targets
			// INCLUDE the bare `shipped`, which the PLUGIN must steer away from, and a
			// `shipped` order's include `refunded`, which is why a transition needs a
			// watermark (DA-2a).
			const allowedTransitions =
				order.id === "ord-unknown"
					? // A state outside the plugin's closed ORDER_STATES (DA-6).
						["teleported", "completed"]
					: (ALLOWED_BY_STATE[order.state] ?? []);
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

/** The L-7 drill-in picker's field, and its options as the concrete
 *  `{value, label}` pairs D4's assertions read. */
function pickerField(blocks: LooseBlock[]): Record<string, unknown> | undefined {
	return field(formFor(blocks, "orders:open"), "orderId");
}

function pickerOptions(blocks: LooseBlock[]): Array<{ value: string; label: string }> {
	return (pickerField(blocks)?.options ?? []) as Array<{ value: string; label: string }>;
}

/**
 * "Did we land on THIS order's detail?", read off the identity strip rather
 * than the H1.
 *
 * It used to be an H1 assertion, and D4 is why it no longer can be: the header
 * is now `Order · <customer> · <date>`, which two orders of one repeat customer
 * placed on one day share CHARACTER FOR CHARACTER — the exact collision §1.3
 * exists to break. The strip's full `Order ID` is the one thing on the screen
 * that names the record, so every "we are on the right order" check reads it,
 * and each of these assertions got STRONGER in the move: `Order ord-ctx-fail`
 * could only ever prove the header was rendered from some order.
 */
function onDetailOf(blocks: LooseBlock[], orderId: string): boolean {
	return fieldEntries(blocks).includes(`Order ID=${orderId}`);
}

/** The `YYYY-MM-DD` (UTC) `n` days before `day` — how a relative period's
 *  expected bounds are computed here, so these tests are not a function of the
 *  day they run on (the shape the Reports default-range test uses). */
function dayBefore(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** The query the console actually sent for the LAST orders list read. */
function listQuery(requests: ReadonlyArray<{ url: string }>): URLSearchParams {
	const url = requests.filter((r) => r.url.startsWith("/admin/orders?")).at(-1)?.url ?? "";
	return new URLSearchParams(url.split("?")[1] ?? "");
}

/** The filter panel's period `select` options, in render order. */
function periodOptions(blocks: LooseBlock[]): Array<{ value: string; label: string }> {
	const period = field(formFor(blocks, "orders:apply-filter"), "period");
	return (period?.options ?? []) as Array<{ value: string; label: string }>;
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

/**
 * The D4 primitive, on its own, before the screen that renders it. Pure string
 * work — no sandbox, because there is no IO to sandbox.
 */
describe("short ids (D4)", () => {
	const UUIDS = [LIST_ID_1, LIST_ID_2, TWIN_ID_A, TWIN_ID_B];

	test("floors at 4 characters and stops there when 4 already separates the set", () => {
		expect(SHORT_ID_MIN).toBe(4);
		const prefixes = shortIdsFor([LIST_ID_1, LIST_ID_2]);
		expect([...prefixes.values()]).toEqual(["7e4c", "b91d"]);
	});

	test("extends ONLY for the ids that collide, one character at a time", () => {
		const prefixes = shortIdsFor(UUIDS);
		// The twins agree for five characters and need six; their neighbours are
		// unaffected and stay at the floor.
		expect(prefixes.get(TWIN_ID_A)).toBe("3f8a1c");
		expect(prefixes.get(TWIN_ID_B)).toBe("3f8a1d");
		expect(prefixes.get(LIST_ID_1)).toBe("7e4c");
		expect(prefixes.get(LIST_ID_2)).toBe("b91d");
	});

	test("is TOTAL and UNIQUE over its input — every id has an entry, and no two distinct ids share a prefix", () => {
		const ids = [...UUIDS, "3f8a1c05-4d2e-4f61-8a70-000000000000", "ab", "abc", "abcdef"];
		const prefixes = shortIdsFor(ids);
		for (const id of ids) {
			expect(prefixes.get(id), `no prefix for ${id}`).toBeDefined();
			expect(id.startsWith(prefixes.get(id)!)).toBe(true);
		}
		expect(new Set(prefixes.values()).size).toBe(new Set(ids).size);
	});

	test("is deterministic and order-independent — a re-render in another order cannot renumber the page", () => {
		const forward = shortIdsFor(UUIDS);
		const reversed = shortIdsFor(UUIDS.toReversed());
		for (const id of UUIDS) expect(reversed.get(id)).toBe(forward.get(id));
		expect(shortIdsFor(UUIDS)).toEqual(forward);
	});

	test("a duplicated id is one candidate, not a collision with itself", () => {
		const prefixes = shortIdsFor([LIST_ID_1, LIST_ID_1, LIST_ID_2]);
		expect(prefixes.size).toBe(2);
		expect(prefixes.get(LIST_ID_1)).toBe("7e4c");
	});

	test("an explicit `min` moves the floor; ids shorter than it are returned whole", () => {
		expect(shortIdsFor([LIST_ID_1, LIST_ID_2], 8).get(LIST_ID_1)).toBe("7e4ce728");
		expect(shortIdsFor(["ab", "cd"], 4).get("ab")).toBe("ab");
	});

	test("`min` can only RAISE the floor — a caller cannot opt out of the 4-character minimum", () => {
		// SHORT_ID_MIN is a rule about what an operator can recognise, not a
		// default: at min 1 a page of orders renders `#7`, `#b`.
		for (const min of [1, 2, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(shortIdsFor([LIST_ID_1, LIST_ID_2], min).get(LIST_ID_1)).toBe("7e4c");
		}
		// Above the minimum a fractional floor truncates rather than rounding up.
		expect(shortIdsFor([LIST_ID_1, LIST_ID_2], 8.9).get(LIST_ID_1)).toBe("7e4ce728");
	});

	test("shortIdFixed takes 8 by default and never pads a shorter id", () => {
		expect(SHORT_ID_CONFIRM_LEN).toBe(8);
		expect(shortIdFixed(LIST_ID_1)).toBe("7e4ce728");
		expect(shortIdFixed(LIST_ID_1, 4)).toBe("7e4c");
		expect(shortIdFixed("ord-1")).toBe("ord-1");
	});

	test("the fixed length is a superset of any computed prefix ≤ 8 — the property the confirm dialog leans on", () => {
		for (const [id, prefix] of shortIdsFor(UUIDS)) {
			expect(shortIdFixed(id).startsWith(prefix)).toBe(true);
		}
	});
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
			"accordion", // the filter panel — collapsed (L-2: 3 fields)
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
		//
		// The order is D4's (PM §C.3): what a human SCANS leads, the opaque key
		// does not, and money holds the final column because there is no column
		// alignment of any kind (T-2/R-7) and the edge is the only thing that
		// makes a money column read as one.
		expect(columnLabels(table)).toEqual(["Placed", "Customer", "Status", "Order #", "Total"]);
		// T-1: five columns on a list screen, the ceiling — the short id replaced
		// the full uuid in place rather than being added alongside it.
		expect(columnLabels(table)).toHaveLength(5);
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
		// THREE fields, down from four: the two date inputs became one `Period`
		// select (INC-11). Height on this panel is recovered by CUTTING FIELDS —
		// never by gridding them, which would split one filter across submits.
		expect(fieldIds(form)).toEqual(["status", "period", "search"]);
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

	// -- INC-11: one Period select ----------------------------------------------

	test("the Period select offers the five options as HUMAN values, and no date field is on screen until one is asked for (R-17a, F-6a)", async () => {
		await boot();
		const blocks = await list();
		const options = periodOptions(blocks);
		expect(options.map((o) => o.value)).toEqual([
			"Any time",
			"Last 7 days",
			"Last 30 days",
			"Last 90 days",
			"Custom…",
		]);
		// The pinned renderer's trigger shows the raw VALUE, so the value IS the
		// label — `last7` on screen would be exactly the visible plumbing this file
		// removed everywhere else (R-17a, F-6c).
		for (const o of options) expect(o.value).toBe(o.label);
		expect(options.map((o) => o.value)).not.toContain(""); // F-6a: never a blank trigger
		const form = formFor(blocks, "orders:apply-filter");
		expect(field(form, "period")?.initial_value).toBe("Any time");
		expect(field(form, "from")).toBeUndefined();
		expect(field(form, "to")).toBeUndefined();
		// Interval notation is gone from the operator's view — from the labels AND
		// from the option values, which are labels here.
		for (const f of (form?.fields ?? []) as Array<Record<string, unknown>>) {
			expect(String(f.label)).not.toMatch(/inclusive|exclusive/i);
		}
		// An unfiltered list asks for NO window: `Any time` is the absence of one,
		// not a very wide one.
		expect(listQuery(stub!.requests).has("from")).toBe(false);
		expect(listQuery(stub!.requests).has("to")).toBe(false);
	});

	test("`Custom…` REPLACES the select with exactly two plainly-labelled date fields — four fields, the panel's ceiling, never five; no preset reveals them", async () => {
		await boot();
		const custom = await submitForm(await list(), "orders:apply-filter", {
			status: "any",
			period: "Custom…",
			search: "",
		});
		assertBlockContract(custom, { screen: "orders", level: "list" });
		const form = formFor(custom, "orders:apply-filter");
		// The filter panel is a form of QUERY fields and nothing else — no value a
		// record owns is editable here.
		expect(fieldIds(form)).toEqual(["status", "from", "to", "search"]);
		// `filterPanel` THROWS above four authored fields (a design-spec violation it
		// refuses to hide), which is why the dates take the select's slot rather than
		// standing beside it: status + period + from + to + search is five.
		expect(fieldIds(form).length).toBeLessThanOrEqual(4);
		expect(field(form, "period")).toBeUndefined();
		expect(field(form, "from")?.type).toBe("date_input");
		expect(field(form, "to")?.type).toBe("date_input");
		expect(field(form, "from")?.label).toBe("From");
		expect(field(form, "to")?.label).toBe("To");
		// Still collapsed, still one form (L-2/L-4) — the shape changed, not the panel.
		expect(group(custom, "orders:filters")?.default_open).not.toBe(true);
		// Picking `Custom…` alone filters NOTHING: no window on the wire until days
		// are given, and nothing claims otherwise.
		expect(group(custom, "orders:filters")?.label).toBe("Filters");
		expect(listQuery(stub!.requests).has("from")).toBe(false);

		// …and nothing else reveals the dates: every preset keeps the select.
		for (const option of ["Any time", "Last 7 days", "Last 30 days", "Last 90 days"]) {
			const blocks = await submitForm(await list(), "orders:apply-filter", {
				status: "any",
				period: option,
				search: "",
			});
			expect(fieldIds(formFor(blocks, "orders:apply-filter"))).toEqual([
				"status",
				"period",
				"search",
			]);
		}
	});

	test("a custom period is INCLUSIVE at both ends: the To day is queried to its LAST instant, not padded to the midnight that dropped it", async () => {
		await boot();
		const custom = await submitForm(await list(), "orders:apply-filter", {
			status: "any",
			period: "Custom…",
			search: "",
		});
		const applied = await submitForm(custom, "orders:apply-filter", {
			status: "any",
			from: "2026-07-10",
			to: "2026-07-12",
			search: "",
		});
		const query = listQuery(stub!.requests);
		expect(query.get("from")).toBe("2026-07-10T00:00:00.000Z");
		// The console now has ONE date-bounds semantics, the Reports screen's: whole
		// days, both ends inclusive. `T00:00:00Z` here asked for orders placed before
		// 12 Jul began — so the day the operator named was the one day missing, which
		// is what `To (exclusive)` was labelling rather than fixing.
		expect(query.get("to")).toBe("2026-07-12T23:59:59.999Z");
		// The panel quotes the DAYS the operator typed, and prefills days back.
		expect(group(applied, "orders:filters")?.label).toBe("Filters (2 active)");
		expect(findBlock(applied, "section")?.text).toBe("from: 2026-07-10 · to: 2026-07-12");
		const form = formFor(applied, "orders:apply-filter");
		expect(field(form, "from")?.initial_value).toBe("2026-07-10");
		expect(field(form, "to")?.initial_value).toBe("2026-07-12");
	});

	test("a relative period resolves against UTC now at RENDER time, and the panel names the PRESET — never a second, independently computed copy of the dates", async () => {
		await boot();
		const today = new Date().toISOString().slice(0, 10);
		const blocks = await submitForm(await list(), "orders:apply-filter", {
			status: "any",
			period: "Last 7 days",
			search: "",
		});
		const query = listQuery(stub!.requests);
		// 7 WHOLE DAYS, today included — today and the six before it, not `now-168h`.
		expect(query.get("from")).toBe(`${dayBefore(today, 6)}T00:00:00.000Z`);
		expect(query.get("to")).toBe(`${today}T23:59:59.999Z`);
		// The active-filter part names the preset. A part quoting the resolved dates
		// would be a SECOND computation of the same period and the two can differ
		// across a midnight — the divergence the Reports period was fixed for.
		expect(group(blocks, "orders:filters")?.label).toBe("Filters (1 active)");
		expect(findBlock(blocks, "section")?.text).toBe("period: Last 7 days");
		expect(String(findBlock(blocks, "section")?.text)).not.toContain(today);
		expect(field(formFor(blocks, "orders:apply-filter"), "period")?.initial_value).toBe(
			"Last 7 days",
		);

		for (const [option, days] of [
			["Last 30 days", 30],
			["Last 90 days", 90],
		] as const) {
			await submitForm(await list(), "orders:apply-filter", {
				status: "any",
				period: option,
				search: "",
			});
			const presetQuery = listQuery(stub!.requests);
			expect(presetQuery.get("from")).toBe(`${dayBefore(today, days - 1)}T00:00:00.000Z`);
			expect(presetQuery.get("to")).toBe(`${today}T23:59:59.999Z`);
		}
	});

	test("the period survives Load more: the cursor carries the PRESET (not the instants it resolved to) and the next page asks the same window", async () => {
		await boot();
		const today = new Date().toISOString().slice(0, 10);
		const filtered = await submitForm(await list(), "orders:apply-filter", {
			status: "paid",
			period: "Last 7 days",
			search: "",
		});
		const token = tableWithId(filtered, "orders:list")?.next_cursor as string;
		const carried = decodeListCursor(token);
		// A relative period is stored RELATIVE. Freezing its instants into the token
		// would make page 2 answer a question page 1 never asked once the token
		// outlived the day it was minted on.
		expect(carried?.f).toEqual({ status: "paid", period: "last7" });

		stub!.requests.length = 0;
		const nextPage = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:page",
				value: { cursor: token, sort: null },
			}),
		);
		// The GET sends the SERVICE cursor alone — that token already embeds the
		// window, and re-sending a freshly resolved one alongside it is how the two
		// come to disagree.
		const paged = listQuery(stub!.requests);
		expect(paged.get("cursor")).toBe("svc-cursor-1");
		expect(paged.has("from")).toBe(false);
		// What the OPERATOR must still see on page 2 is the period they chose, which
		// is what the console's own token restores.
		expect(field(formFor(nextPage, "orders:apply-filter"), "period")?.initial_value).toBe(
			"Last 7 days",
		);
		expect(field(formFor(nextPage, "orders:apply-filter"), "status")?.initial_value).toBe("paid");
		expect(findBlock(nextPage, "section")?.text).toBe("status: paid · period: Last 7 days");
		// And re-applying that restored panel asks the same window as page 1.
		await submitForm(nextPage, "orders:apply-filter", {
			status: "paid",
			period: "Last 7 days",
			search: "",
		});
		const reapplied = listQuery(stub!.requests);
		expect(reapplied.get("from")).toBe(`${dayBefore(today, 6)}T00:00:00.000Z`);
		expect(reapplied.get("to")).toBe(`${today}T23:59:59.999Z`);
	});

	test("emptying both dates LEAVES the custom shape — the select returns at `Any time` and the window is dropped; `Clear filters` does it in one click", async () => {
		await boot();
		const custom = await submitForm(await list(), "orders:apply-filter", {
			status: "paid",
			period: "Custom…",
			search: "",
		});
		const ranged = await submitForm(custom, "orders:apply-filter", {
			status: "paid",
			from: "2026-07-10",
			to: "2026-07-12",
			search: "",
		});
		// The custom shape sustains ITSELF: its submits carry dates and no `period`
		// field, and the range must not fall back to `Any time` on every re-apply.
		expect(fieldIds(formFor(ranged, "orders:apply-filter"))).toEqual([
			"status",
			"from",
			"to",
			"search",
		]);

		const emptied = await submitForm(ranged, "orders:apply-filter", {
			status: "paid",
			from: "",
			to: "",
			search: "",
		});
		const form = formFor(emptied, "orders:apply-filter");
		expect(fieldIds(form)).toEqual(["status", "period", "search"]);
		expect(field(form, "period")?.initial_value).toBe("Any time");
		expect(field(form, "status")?.initial_value).toBe("paid"); // the rest survives
		expect(findBlock(emptied, "section")?.text).toBe("status: paid");
		expect(listQuery(stub!.requests).has("to")).toBe(false);

		const cleared = await click(findBlock(ranged, "section")?.accessory as Record<string, unknown>);
		expect(fieldIds(formFor(cleared, "orders:apply-filter"))).toEqual([
			"status",
			"period",
			"search",
		]);
		expect(field(formFor(cleared, "orders:apply-filter"), "period")?.initial_value).toBe(
			"Any time",
		);
	});

	test("BACK from a detail resets the period to its default — scaffold parity, pinned as a decision rather than left as a surprise", async () => {
		await boot();
		const filtered = await submitForm(await list(), "orders:apply-filter", {
			status: "any",
			period: "Last 30 days",
			search: "",
		});
		expect(field(formFor(filtered, "orders:apply-filter"), "period")?.initial_value).toBe(
			"Last 30 days",
		);
		const detail = await open("ord-1");
		const back = await click(buttonWith(detail, "orders:back"));
		// The scaffold re-lists with the level's DEFAULT filter on `back` — every
		// filter on this screen has always behaved this way, and the period is not
		// special-cased into an exception to it.
		expect(field(formFor(back, "orders:apply-filter"), "period")?.initial_value).toBe("Any time");
		expect(findBlocks(back, "section")).toEqual([]);
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

	test("the drill-in picker is a combobox whose option VALUE is the full id and whose label LEADS with the short id (L-7, D4)", async () => {
		await boot();
		const blocks = await list();
		const picker = pickerField(blocks);
		expect(picker?.type).toBe("combobox"); // >8 rows per page, and it never prefills
		expect(picker?.initial_value).toBe("none"); // F-6a: a real option, never blank
		const options = pickerOptions(blocks);
		expect(options[0]).toEqual({ value: "none", label: "Choose an order…" });
		const row = options.find((o) => o.value === LIST_ID_1);
		// D4's shape, exactly: `#<prefix> · <customer> · <total> · <state>`, the id
		// FIRST because it is the only token that discriminates.
		expect(row?.label).toBe("#7e4c · cust-a · $15.00 · paid");
		// The Block Kit degradation (§1.3): a prefix and nothing else — an option is
		// `{value, label}`, so there is nowhere to hang a copy button. The full id is
		// NOT here, and does not need to be: the detail's identity strip carries it
		// verbatim.
		expect(row?.label).not.toContain(LIST_ID_1);
	});

	test("D4: two orders identical in customer, total and state still get DISTINCT picker labels, and the prefix extends only as far as the collision demands", async () => {
		await boot();
		listRows = "twins";
		const options = pickerOptions(await list()).filter((o) => o.value !== "none");
		expect(options.map((o) => o.value)).toEqual([TWIN_ID_A, TWIN_ID_B, LIST_ID_2]);
		const twins = options.filter((o) => o.value === TWIN_ID_A || o.value === TWIN_ID_B);
		// Everything after the leading token is character-for-character identical —
		// which is precisely the label the old picker rendered, twice.
		const tails = twins.map((o) => o.label.slice(o.label.indexOf(" · ")));
		expect(tails[0]).toBe(tails[1]);
		expect(tails[0]).toBe(" · cust-a · $15.00 · paid");
		// So the leading token is the whole discriminator, and it is distinct.
		expect(twins[0]?.label).not.toBe(twins[1]?.label);
		// `3f8a1c…` / `3f8a1d…` agree for five characters, so the 4-character floor
		// cannot separate them and the prefix extends to six — no further. Their
		// neighbour collides with neither and stays at the floor: the extension is
		// paid for by the ids that need it, not by the page.
		expect(options.map((o) => o.label.split(" · ")[0])).toEqual(["#3f8a1c", "#3f8a1d", "#b91d"]);
	});

	test("D4: the picker's candidate set IS the array the table renders — the row's token and that row's option token are the same string, on both pages", async () => {
		await boot();
		for (const mode of ["two", "twins"] as const) {
			listRows = mode;
			const blocks = await list();
			const rowTokens = tableRows([tableWithId(blocks, "orders:list")!]).map((r) =>
				String(r.shortId),
			);
			// Everything below is an equality between two lists; on an empty page they
			// are both `[]` and every assertion passes having compared nothing.
			expect(rowTokens.length).toBeGreaterThan(0);
			const options = pickerOptions(blocks).filter((o) => o.value !== "none");
			// The two surfaces are computed at two call sites over the same `orders`
			// array. THIS is the line that makes that a fact rather than an intention:
			// the token the operator reads off a row is character-for-character the
			// token leading that row's option, so the walk from table to picker is an
			// exact string match and not a positional guess.
			expect(options.map((o) => o.label.split(" · ")[0])).toEqual(
				rowTokens.map((token) => `#${token}`),
			);
			// And the population itself is right. The picker still carries FULL ids as
			// option values — that is where the table's ids went — so recomputing the
			// prefixes from the picker's own candidate set must reproduce the table's
			// cells verbatim. A picker fed a re-fetched, filtered or reordered copy
			// diverges here even when the leading tokens happen to line up.
			const recomputed = shortIdsFor(options.map((o) => o.value));
			expect(options.map((o) => recomputed.get(o.value))).toEqual(rowTokens);
		}
	});

	test("D4/§1.3: the list row renders the SHORT id and the full uuid appears NOWHERE in the table — including on the page where two ids collide", async () => {
		await boot();
		for (const mode of ["two", "twins"] as const) {
			listRows = mode;
			const table = tableWithId(await list(), "orders:list");
			// Not "no id column": the identity is still THERE and still a `code` chip
			// (T-4) — it is the 32 characters of entropy after the prefix that are not.
			expect(columnsOf(table).find((c) => c.label === "Order #")?.format).toBe("code");
			const rendered = JSON.stringify(table);
			for (const id of [LIST_ID_1, LIST_ID_2, TWIN_ID_A, TWIN_ID_B]) {
				expect(rendered).not.toContain(id);
			}
			// The row cell is the bare token — the `#` is the column HEADER's job, so
			// it is not paid for once per row.
			const tokens = tableRows([table!]).map((r) => String(r.shortId));
			for (const token of tokens) expect(token.startsWith("#")).toBe(false);
			// Uniqueness is the whole point of a prefix: two rows an operator cannot
			// tell apart is the defect this rule exists to prevent, and the `twins`
			// page is two ids that agree for five characters.
			expect(new Set(tokens).size).toBe(tokens.length);
		}
		// On the twins page the extension is paid for by the ids that need it: the
		// colliding pair goes to six characters, their neighbour stays at the floor.
		listRows = "twins";
		expect(tableRows([tableWithId(await list(), "orders:list")!]).map((r) => r.shortId)).toEqual([
			"3f8a1c",
			"3f8a1d",
			"b91d",
		]);
	});

	test("D4/§1.3: NO table anywhere in the console renders a full uuid — the sweep is every table in every response, not just `orders:list`", async () => {
		await boot();
		// This test is deliberately scoped to TABLES rather than to whole
		// responses, because the two are different claims. §1.3 bans the full id
		// from a LIST ROW; it simultaneously REQUIRES the detail to render one in
		// full, in the identity strip, or the id stops being obtainable anywhere.
		// A response-wide sweep would forbid the thing the rule mandates.
		//
		// It is scoped to every table rather than to the primary one because the
		// first version of this sweep named `orders:list` — and the Customer
		// panel's "Other orders" table, one accordion below, went on rendering all
		// 36 characters identity-first with nothing to catch it.
		const uuids = [LIST_ID_1, LIST_ID_2, TWIN_ID_A, TWIN_ID_B];
		const sweep = (blocks: LooseBlock[], where: string): void => {
			const tables = findBlocks(blocks, "table");
			expect(tables.length).toBeGreaterThan(0);
			for (const table of tables) {
				for (const uuid of uuids) {
					expect(
						JSON.stringify(table).includes(uuid),
						`${where}: table "${String(table.block_id)}" renders the full uuid ${uuid}`,
					).toBe(false);
				}
			}
		};
		for (const mode of ["two", "twins"] as const) {
			listRows = mode;
			sweep(await list(), `list (${mode})`);
		}
		listRows = "two";
		// `ord-1` is the one that carries a populated `recentOrders`, so it is the
		// order whose detail exercises the "Other orders" table; the rest are swept
		// so a future table on any of these states inherits the rule for free.
		for (const id of ["ord-1", "ord-guest", "ord-shipped", "ord-refunded", "ord-flagged"]) {
			sweep(await open(id), `detail ${id}`);
		}
		// And the detail DOES still carry the full id — one summary field, which is
		// §1.3's escape hatch and the reason the sweep above is table-scoped.
		expect(fieldEntries(await open("ord-1"))).toContain("Order ID=ord-1");
	});

	test("T-2/M-1: money is the LAST column and every cell is formatted with its own currency — no Currency column, no raw minor units", async () => {
		await boot();
		const table = tableWithId(await list(), "orders:list");
		const labels = columnLabels(table);
		expect(labels[labels.length - 1]).toBe("Total");
		// M-2: the currency rides in the formatted string, not in a column of its
		// own and not in the header — orders carry their own currency each, so a
		// currency stated once in a header would be a claim this page cannot make.
		expect(labels).not.toContain("Currency");
		for (const label of labels) expect(label).not.toMatch(/USD|EUR|\$/);
		// SUMMARY_1 is 1500 minor units, SUMMARY_2 is 2000.
		expect(tableRows([table!]).map((r) => r.total)).toEqual(["$15.00", "$20.00"]);
	});

	test("D4: for every order on a page the picker's prefix is a prefix of the refund confirm's — the operator can match `#7e4c` to `#7e4ce728` by eye", async () => {
		await boot();
		for (const mode of ["two", "twins"] as const) {
			listRows = mode;
			for (const option of pickerOptions(await list()).filter((o) => o.value !== "none")) {
				const pickerPrefix = String(option.label.split(" · ")[0]).slice(1);
				const detail = await open(option.value);
				const text = String(confirmOf(buttonWith(detail, "orders:refund")).text);
				const confirmPrefix = String(/#([0-9a-z-]+)/i.exec(text)?.[1]);
				expect(confirmPrefix).toHaveLength(8);
				expect(confirmPrefix.startsWith(pickerPrefix)).toBe(true);
			}
		}
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
		// E-7 / X-42: this path swallows EVERYTHING — an unreachable service, this 401, a
		// malformed response, and a bug in the console's own code (a `carriedForm` digest
		// throw lands here). So it must not name a single cause: "Could not reach the
		// commerce service" is false whenever a console defect is the cause, and its cost
		// is that it tells the operator the network is down and sends whoever they page to
		// the wrong team. The last clause is the load-bearing one.
		expect(banner?.title).toBe("Orders are unavailable");
		expect(banner?.description).toBe(
			"Orders could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		);
		expect(String(banner?.description)).toContain("a fault in the console itself");
		expect(String(banner?.description).length).toBeLessThanOrEqual(240);
		expect(text).not.toContain("Could not reach the commerce service");
	});

	// -- §11.2 the detail skeleton ---------------------------------------------

	test("the detail is five blocks outside the tabs plus FOUR constant task-named panels at default_tab 0 (D-1..D-4)", async () => {
		await boot();
		const blocks = await open("ord-1");
		expect(blocks.map((b) => b.type)).toEqual(["header", "actions", "fields", "tab"]);
		expect(findBlocks(blocks, "header").map((b) => b.text)).toEqual([
			// D4: the H1 names the order the way a human does — who placed it and
			// when — instead of spending the page's largest type on a uuid.
			"Order · cust-a · 10 Jul 2026",
			"Line items", // the ONE header permitted inside a panel (P-2)
		]);
		// …and the id is not merely absent from the H1, it has MOVED (§1.3): a
		// console that shows a prefix on every other surface needs exactly one
		// place the whole id is still readable, or it stops being obtainable at
		// all. That place is the identity strip, and it renders in FULL.
		expect(fieldEntries(blocks)).toContain("Order ID=ord-1");
		const tab = findBlock(blocks, "tab");
		expect(tab?.block_id).toBe("orders:ord-1:tabs"); // stable (B-4)
		expect(tab?.default_tab).toBe(0); // ALWAYS (D-4)
		expect(panelLabels(blocks)).toEqual(["Order", "Fulfilment", "Money", "History"]);
		// A back button exists (no dead-end).
		expect(buttonWith(blocks, "orders:back")).toBeDefined();
		// The identity strip: 6 entries in 3 row-major PAIRS, with Total on it.
		const identity = findBlocks(blocks, "fields").find((f) => f.block_id === "orders:identity");
		const labels = ((identity?.fields ?? []) as Array<{ label: string }>).map((f) => f.label);
		// `Order ID` sits where `Customer` used to: the H1 took the customer, the
		// strip took the id, and the count stayed at 6 so R-3's row-major PAIRS
		// survive. An appended 7th entry would have left a widowed cell.
		expect(labels).toEqual([
			"Status",
			"Total",
			"Placed (UTC)",
			"Payment",
			"Order ID",
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
		// §11.2's SIX entries on an account, with the two labels that used to be
		// indistinguishable now named: the ACCOUNT's address vs the order's contact
		// address (which was the internal-sounding `Buyer reference`).
		expect(values).toEqual([
			"Account email=alice@example.com",
			"Account=cust-a",
			"Name=Alice Example",
			"Orders placed=3",
			"Contact email=alice@example.com",
			"Email verified (UTC)=2026-07-09T00:00:00Z",
		]);
		expect(values.some((v) => v.startsWith("Email="))).toBe(false);
		expect(values.some((v) => v.startsWith("Buyer reference="))).toBe(false);
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
		// D4/§1.3 binds this table too — it is a list row like any other. It shows
		// the prefix of `LIST_ID_2`, computed over ITS OWN candidate set
		// (`recentOrders`), and never the 36 characters it used to lead with.
		const other = groupBlocks(blocks, "orders:ord-1:other-orders");
		expect(tableRows(other)[0]?.shortId).toBe(shortIdsFor([LIST_ID_2]).get(LIST_ID_2));
		expect(tableRows(other)[0]?.shortId).toBe("b91d");
		expect(JSON.stringify(other)).not.toContain(LIST_ID_2);
		// Same ordering principle as the primary list: identity out of the lead,
		// money last (T-2). No `Customer` column — every row is this customer.
		expect(columnLabels(findBlock(other, "table"))).toEqual([
			"Placed",
			"Status",
			"Order #",
			"Total",
		]);
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
		// TWO entries, and only these (§11.2). The six-entry shape said "no account"
		// five different ways over the D-7 line that already says it once, and its
		// `Email — (no account)` row DENIED an address the group label, the identity
		// strip and `Contact email` were all displaying at the same moment.
		const customerFields = groupBlocks(blocks, "orders:ord-guest:customer");
		expect(fieldEntries(customerFields)).toEqual([
			"Contact email=alice@example.com",
			"Orders placed=1",
		]);
		for (const denial of [
			"Account=Guest — no account",
			"Name=—",
			"Account email=—",
			"Email verified=not verified",
			"Email=— (no account)",
		]) {
			expect(fieldEntries(customerFields)).not.toContain(denial);
		}
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
		expect(onDetailOf(blocks, "ord-ctx-fail")).toBe(true);
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
		// DA-7a: the line names the ALTERNATIVE and never narrates the design
		// decision. Both used to open "There is deliberately no bare …".
		expect(contexts).toContain(
			"To ship this order, record the tracking under Fulfilment above — that emails it to the buyer.",
		);
		expect(contexts).toContain(
			"To cancel this order, use Cancel order below — it records a reason on file.",
		);
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
		// DA-2a / DA-6 item 5: EVERY transition button carries the observed state —
		// the watermark its handler re-reads against. X-38 is countable on the payload.
		for (const st of ["processing", "completed", "refunded"]) {
			expect(valueOf(buttonWith(blocks, `orders:transition-${st}`))).toEqual({
				orderId: "ord-1",
				toState: st,
				state: "paid",
			});
		}
	});

	test("DA-6: a service-offered state OUTSIDE the plugin's closed ORDER_STATES renders NO button and no blank page", async () => {
		await boot();
		const blocks = await open("ord-unknown");
		// The stub offered `teleported` + `completed`; only the known one renders.
		expect(transitionStates(blocks)).toEqual(["completed"]);
		expect(JSON.stringify(blocks)).not.toContain("teleported");
		// And the page is a real detail, not the `{blocks: []}` dead-end.
		expect(onDetailOf(blocks, "ord-unknown")).toBe(true);
	});

	test("a transition button POSTs with a content-derived Idempotency-Key and re-renders the detail", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await click(buttonWith(blocks, "orders:transition-processing"));
		// DA-3a: the re-read happens BEFORE the write, on a transition too.
		expect(stub!.requests.some((r) => r.method === "GET")).toBe(true);
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post!.url).toBe("/admin/orders/ord-1/transition");
		expect(post!.headers["idempotency-key"]).toBe("admin-transition:ord-1:processing");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect((post!.body as { toState: string }).toState).toBe("processing");
		expect(onDetailOf(after, "ord-1")).toBe(true);
	});

	test("DA-2a: a SHIPPED order really is offered `Mark refunded` — the terminal flip a stale view could otherwise reach, so the watermark is not theoretical", async () => {
		await boot();
		const blocks = await open("ord-shipped");
		// THE WIRE SHAPE, not an inference. The stub's `allowedTransitions` comes from the
		// domain's `ORDER_STATE_MACHINE` ITSELF (imported, not restated — see
		// ALLOWED_BY_STATE), which the service returns through `[...legalNextStates(state)]`
		// with no narrowing — so `shipped` really does offer `delivered` and `refunded`, and
		// the plugin steers away from neither. Both figures below are the domain's.
		expect(transitionStates(blocks).toSorted()).toEqual(["delivered", "refunded"]);
		const refunded = buttonWith(blocks, "orders:transition-refunded");
		expect(refunded).toBeDefined();
		expect(refunded?.style).toBe("danger");
		// `refunded` is TERMINAL (the same table gives it no outbound transitions), so
		// this is a one-way flip on an order whose tracking has already been emailed.
		expect(ORDER_STATE_MACHINE["refunded"]).toEqual([]);
		// Which is exactly why the button carries the state the operator was LOOKING at:
		// the domain guard cannot help, because `paid → refunded` and `shipped → refunded`
		// are both legal, so a click decided on a `paid` view succeeds against a shipped
		// order. The watermark is the only thing that catches it.
		expect(valueOf(refunded).state).toBe("shipped");
		expect(String(confirmOf(refunded).text)).toContain("does not move money");
	});

	test("DA-2a: a transition whose observed state no longer matches applies NOTHING and names both states", async () => {
		await boot();
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:transition-refunded",
				// The scenario in full: the operator opened this order while it read
				// `paid`, a colleague moved it to `shipped`, and only then did they
				// confirm the dialog. `ord-1` is `paid` live, so the mismatch fires the
				// other way round with the same shape.
				value: { orderId: "ord-1", toState: "refunded", state: "shipped" },
			}),
		);
		// The re-read happened; the write did NOT.
		expect(stub!.requests.some((r) => r.method === "GET")).toBe(true);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("The order changed — nothing was applied");
		expect(String(banner?.description)).toContain("shipped");
		expect(String(banner?.description)).toContain("paid");
		// A transition has no group and no operator-typed input, so DA-3a-i's four
		// clauses have nothing to bind to: no group is forced open, and the live state
		// the operator needs is in the identity strip.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:fulfilment"]);
		expect(fieldEntries(after)).toContain("Status=paid");
	});

	test("DA-3a is not opt-out: a transition payload with the watermark STRIPPED refuses instead of writing unchecked", async () => {
		await boot();
		stub!.requests.length = 0;
		// `button.value` is operator-alterable (B-1), so a `state.length > 0` guard around
		// the comparison would let anyone with devtools — or any browser tab rendered
		// before the watermark existed — write with no staleness check at all. A stale tab
		// is precisely the case DA-3a is for, so refusing is the right answer for both.
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:transition-refunded",
				value: { orderId: "ord-1", toState: "refunded" },
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("That action could not be read");
		// The same holds for a cancel, whose watermark rides the same channel.
		stub!.requests.length = 0;
		const cancelled = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:cancel-out_of_stock",
				value: { orderId: "ord-1", reason: "out_of_stock" },
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(cancelled, "banner").find((b) => b.variant === "error")?.title).toBe(
			"That action could not be read",
		);
	});

	test("a no-op transition (ok but transitioned:false) re-renders the detail with a NON-error notice", async () => {
		await boot();
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:transition-paid", // already paid ⇒ transitioned:false
				value: { orderId: "ord-1", toState: "paid", state: "paid" },
			}),
		);
		expect(onDetailOf(after, "ord-1")).toBe(true);
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
		// D-6a / X-35: a destructive group's label carries its CONSEQUENCE, because a
		// label cannot be red (R-5) and a bare verb makes the most dangerous control on
		// the panel the quietest thing on it.
		expect(cancel?.label).toBe("Cancel order — permanent, releases held stock");
		expect(String(cancel?.label).length).toBeLessThanOrEqual(60);
		expect(cancel?.default_open).toBe(false); // ALWAYS, for anything destructive
		const reasonButtons = buttons([cancel!]).filter((e) =>
			String(e.action_id).startsWith("orders:cancel-"),
		);
		// FOUR buttons, not five: `other` promised a detail field the button could not
		// provide, so it lives only in the note form's select — which also keeps the
		// fan-out inside DA-2c's cap, so each button stays `style:"danger"` (X-37).
		expect(reasonButtons.map((e) => e.action_id)).toEqual([
			"orders:cancel-customer_request",
			"orders:cancel-fraud_suspected",
			"orders:cancel-out_of_stock",
			"orders:cancel-pricing_error",
		]);
		// LABELS ARE THE BARE REASON — the group label and the confirm already say
		// "cancel" twice, so a "Cancel — " prefix said it three times per button and
		// pushed the only differing word to the right.
		expect(reasonButtons.map((e) => e.label)).toEqual([
			"Customer requested it",
			"Fraud suspected",
			"Out of stock",
			"Pricing error",
		]);
		expect(reasonButtons.filter((e) => e.style === "danger")).toHaveLength(4);
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
		// The causal clause: the fact, not just the effect (E-4, §8).
		expect(String(banner?.description)).toContain("someone else moved it");
		// DA-3a-i: the refusal re-renders state 1 INTO THE CANCEL GROUP, forced open on
		// a THIRD key, flattened, with no confirm — X-18 still holds at one open group.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:cancel:refused"]);
		expect(group(after, "orders:ord-1:cancel-note")).toBeUndefined();
		expect(buttonWith(after, "orders:cancel")).toBeUndefined();
		expect(formFor(after, "orders:cancel-review")).toBeDefined();
	});

	test("DA-3: `Review cancellation` stages the free text — the group gets a CHANGED block_id AND default_open true, and one danger confirm appears (B-6, X-29)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const noteForm = formFor(blocks, "orders:cancel-review");
		expect(group(blocks, "orders:ord-1:cancel-note")?.default_open).toBe(false);
		stub!.requests.length = 0;
		const staged = await submitForm(blocks, "orders:cancel-review", {
			// The select's option VALUE is the human label (R-17a: the trigger renders
			// the raw value, so wire values would put `customer_request` on screen).
			reason: "Other",
			detail: "chargeback risk flagged",
			cancelledBy: "carol",
		});
		// A `-review` writes NOTHING — but it DOES re-read, so state 2 can never draw a
		// confirm the write would already refuse (DA-3c: not only the confirm handler).
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(stub!.requests.some((r) => r.method === "GET")).toBe(true);
		// BOTH halves of the force-open. Only the id half and the whole thing snaps
		// shut on the operator, hiding the confirm they just asked for.
		expect(group(staged, "orders:ord-1:cancel")).toBeUndefined();
		const review = group(staged, "orders:ord-1:cancel:review");
		expect(review?.default_open).toBe(true);
		expect(openGroupIds(staged)).toEqual(["orders:ord-1:cancel:review"]);
		// THE SAME FORM, remounted with the staged values — there is no "Change
		// details" action and no `fields` echo of the payload.
		const restaged = formFor([review!], "orders:cancel-review");
		expect(field(restaged, "reason")?.initial_value).toBe("Other");
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
		// at a time — and so is the nested collect group (flattened, DA-3's
		// outermost-group rule).
		expect(buttonWith(staged, "orders:cancel-out_of_stock")).toBeUndefined();
		expect(group(staged, "orders:ord-1:cancel-note")).toBeUndefined();
		// The confirm carries the WIRE reason, mapped back from the option label.
		expect(valueOf(confirm).reason).toBe("other");

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
			reason: "Out of stock",
			detail: "last one broke in transit",
			cancelledBy: "  ",
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
			"Not cancelled",
		);
		// Nothing is STAGED — no state 2, no confirm.
		expect(group(after, "orders:ord-1:cancel:review")).toBeUndefined();
		expect(buttonWith(after, "orders:cancel")).toBeUndefined();
		// But the refusal is still a DA-3a-i render: the cancel group is forced open on
		// its refusal key, the collect group is FLATTENED away, and the reason and
		// detail the operator did type are prefilled back.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:cancel:refused"]);
		expect(group(after, "orders:ord-1:cancel-note")).toBeUndefined();
		const retry = formFor(after, "orders:cancel-review");
		expect(field(retry, "reason")?.initial_value).toBe("Out of stock");
		expect(field(retry, "detail")?.initial_value).toBe("last one broke in transit");
	});

	test("DA-3c: `cancel-review` re-reads too, so state 2 never draws a confirm the write would already refuse", async () => {
		await boot();
		const blocks = await open("ord-1");
		const noteForm = formFor(blocks, "orders:cancel-review");
		// Re-submit the form with a carrier whose watermark is stale — the shape em-dash
		// sends from a tab that rendered before someone else moved the order.
		const carried = decodeCarrier(noteForm?.block_id) ?? {};
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:cancel-review",
				values: { reason: "Out of stock", detail: "shelf empty", cancelledBy: "carol" },
				block_id: encodeCarrier("orders:cancel-note", { ...carried, state: "pending" }),
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		// NOTHING is staged: no `:review` group and no confirm, because the confirm it
		// would have drawn ("Cancel this order as 'out of stock'? This is permanent…")
		// carries a watermark `cancelOrderAction` is about to reject anyway — leaving the
		// operator a coherent current panel beside a button that cannot succeed.
		expect(group(after, "orders:ord-1:cancel:review")).toBeUndefined();
		expect(buttonWith(after, "orders:cancel")).toBeUndefined();
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("The order changed — nothing was staged");
		expect(String(banner?.description)).toContain("someone else moved it");
		// DA-3a-i, all four clauses.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:cancel:refused"]);
		expect(group(after, "orders:ord-1:cancel-note")).toBeUndefined();
		const retry = formFor(after, "orders:cancel-review");
		expect(field(retry, "reason")?.initial_value).toBe("Out of stock");
		expect(field(retry, "detail")?.initial_value).toBe("shelf empty");
		expect(field(retry, "cancelledBy")?.initial_value).toBe("carol");
	});

	test("DA-3a has NO `-review` exemption: a cancel review whose carrier has no watermark stages NOTHING, rather than re-stamping one the operator never saw", async () => {
		await boot();
		const blocks = await open("ord-1");
		const noteForm = formFor(blocks, "orders:cancel-review");
		const { state: _dropped, ...noWatermark } = decodeCarrier(noteForm?.block_id) ?? {};
		expect(_dropped).toBe("paid");
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:cancel-review",
				values: { reason: "Out of stock", detail: "shelf empty", cancelledBy: "carol" },
				block_id: encodeCarrier("orders:cancel-note", noWatermark),
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
			"That action could not be read",
		);
		// NOTHING IS STAGED, and that is the whole point. This used to stage successfully:
		// the guard read `observedState !== undefined && …`, so an absent watermark skipped
		// DA-3a, and the confirm this step drew then carried a `state` RE-STAMPED from its
		// own fresh read. The write's own check would then pass trivially against a state
		// the operator never saw, leaving the form-render → review window unchecked while
		// the payload claimed otherwise. `readWatermark`'s doc calls that rule absolute;
		// this asserts the reference screen actually obeys it.
		expect(group(after, "orders:ord-1:cancel:review")).toBeUndefined();
		expect(buttonWith(after, "orders:cancel")).toBeUndefined();
		// Still a DA-3a-i refusal — nothing was written, so the typing comes back.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:cancel:refused"]);
		expect(group(after, "orders:ord-1:cancel-note")).toBeUndefined();
		const retry = formFor(after, "orders:cancel-review");
		expect(field(retry, "reason")?.initial_value).toBe("Out of stock");
		expect(field(retry, "detail")?.initial_value).toBe("shelf empty");
		expect(field(retry, "cancelledBy")?.initial_value).toBe("carol");
	});

	test("DA-2c: a render carrying render state QUIETS the transition row — no red `Mark refunded` above a form the banner is telling the operator to re-submit — and keeps every confirm", async () => {
		await boot();
		const idle = await open("ord-1");
		// The baseline: on an idle render `Mark refunded` is the one danger transition
		// (DA-5), and it stays that way. This change is scoped to render-state renders.
		expect(buttonWith(idle, "orders:transition-refunded")?.style).toBe("danger");
		expect(buttonWith(idle, "orders:transition-refunded")?.confirm).toBeDefined();

		// A cancel REFUSAL. Suppressing the four DA-2b reason buttons and the confirm was
		// right, and it left a terminal, irreversible `Mark refunded` as the loudest
		// control on the panel — directly above the form the operator is being told to
		// re-submit, and not what this render is about.
		const refusal = await submitForm(idle, "orders:cancel-review", {
			reason: "Out of stock",
			detail: "shelf empty",
			cancelledBy: "  ",
		});
		expect(openGroupIds(refusal)).toEqual(["orders:ord-1:cancel:refused"]);
		const quiet = buttonWith(refusal, "orders:transition-refunded");
		expect(quiet).toBeDefined();
		expect(quiet?.style).toBeUndefined();
		// THE GUARD IS THE DIALOG, NOT THE COLOUR (DA-2c, explicit) — so the confirm is
		// untouched, still names the transition it guards, and still carries its own
		// `style:"danger"`. The click costs exactly what it did before.
		expect(quiet?.confirm).toBeDefined();
		expect(confirmOf(quiet).style).toBe("danger");
		expect(String(confirmOf(quiet).text)).toContain("does not move money");
		// No transition button on this render is loud, and the watermark still rides along.
		for (const st of ["processing", "completed", "refunded"]) {
			expect(buttonWith(refusal, `orders:transition-${st}`)?.style, st).toBeUndefined();
			expect(valueOf(buttonWith(refusal, `orders:transition-${st}`)).state).toBe("paid");
		}

		// And in DA-3 STATE 2 the same holds, where it matters just as much: the one loud
		// control is the confirm the operator asked for, not a neighbour.
		const staged = await submitForm(idle, "orders:cancel-review", {
			reason: "Out of stock",
			detail: "shelf empty",
			cancelledBy: "carol",
		});
		expect(openGroupIds(staged)).toEqual(["orders:ord-1:cancel:review"]);
		expect(buttonWith(staged, "orders:transition-refunded")?.style).toBeUndefined();
		expect(buttonWith(staged, "orders:transition-refunded")?.confirm).toBeDefined();
		expect(buttonWith(staged, "orders:cancel")?.style).toBe("danger");
		// Exactly one danger control ON THE PANEL THE OPERATOR IS LOOKING AT — the act
		// itself. Scoped to Fulfilment on purpose: Money's DA-2b full-remaining refund is
		// still red and should be, because it is behind another tab and DA-2c is about what
		// competes for emphasis on one screen (§0.2 E-f).
		expect(buttons(panel(staged, "Fulfilment")).filter((b) => b.style === "danger")).toEqual([
			buttonWith(staged, "orders:cancel"),
		]);
		expect(buttons(panel(refusal, "Fulfilment")).filter((b) => b.style === "danger")).toEqual([]);
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
			// M-11a: a bare `Remaining` beside `Captured` and `Refunded` could mean
			// remaining to capture, to refund or to ship.
			"Remaining refundable=$10.00",
			// A BARE INTEGER: X-9's heuristic now excludes labels matching /recorded/,
			// so the invented "1 refund" unit is no longer needed to satisfy it.
			"Refunds recorded=1",
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
		// NO `Kind` COLUMN (T-5, X-4): `kind` is resolved once from the ORDER's own
		// gateway, so it cannot vary down one order's ledger — a column of identical
		// `manual` pills, which is a column of nothing.
		expect(columnLabels(ledger)).toEqual(["Amount", "Provider ref", "By", "When"]);
		expect(columnsOf(ledger).filter((c) => c.format === "badge")).toEqual([]);
		expect(JSON.stringify(ledger)).not.toContain("gateway");
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
		// D4: the ORDER comes first. Amount and recipient are the two attributes a
		// repeat customer's orders share, so a dialog naming only those cannot say
		// WHICH order the money is leaving.
		expect(confirm.text).toBe(
			"Order #ord-1 — refund $10.00 to cust-a? This sends the money back through Stripe and cannot be reversed.",
		);
		expect(String(confirm.text).length).toBeLessThanOrEqual(200);
		expect(confirm.confirm).toBe("Yes, refund $10.00");
		// DA-1: no form submit can refund.
		expect(formFor(blocks, "orders:refund")).toBeUndefined();
	});

	test("D4: the refund confirm names the order BEFORE the amount and the recipient, and keeps naming it on the recipient-dropping fallback — both inside 200 (X-11)", async () => {
		await boot();
		// The ordinary path: order, then amount, then recipient, in that order.
		const named = String(confirmOf(buttonWith(await open(LIST_ID_1), "orders:refund")).text);
		expect(named.startsWith(`Order #${shortIdFixed(LIST_ID_1)} — refund $10.00 to cust-a?`)).toBe(
			true,
		);
		expect(named.indexOf("#7e4ce728")).toBeLessThan(named.indexOf("$10.00"));
		expect(named.indexOf("$10.00")).toBeLessThan(named.indexOf("cust-a"));
		expect(named.length).toBeLessThanOrEqual(200);
		// A buyer handle long enough to blow the budget drops THE RECIPIENT — never
		// the id and never the amount, and never by truncating mid-sentence.
		const long = String(confirmOf(buttonWith(await open("ord-long-buyer"), "orders:refund")).text);
		expect(long.length).toBeLessThanOrEqual(200);
		expect(long).toBe(
			"Order #ord-long — refund $10.00 to this order's buyer? This sends the money back through Stripe and cannot be reversed.",
		);
		expect(long).not.toContain(ORDER_LONG_BUYER.buyerRef);
		// The OTHER call site: the DA-3 staged confirm, which must not drift from the
		// DA-2b one — the same operator reads both.
		const idle = await open("ord-1");
		const staged = await submitForm(idle, "orders:refund-review", {
			amount: "4.00",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(String(confirmOf(buttonWith(staged, "orders:refund")).text)).toBe(
			"Order #ord-1 — refund $4.00 to cust-a? This sends the money back through Stripe and cannot be reversed.",
		);
	});

	test("the DA-3 partial-refund form has THREE visible fields and carries the order id, currency and watermark — the `nonce` select is DELETED, not relocated (F-2a)", async () => {
		await boot();
		const blocks = await open("ord-1");
		const partial = group(blocks, "orders:ord-1:refund-partial");
		// D-6a / X-35: the consequence, not a bare noun. 46 chars.
		expect(partial?.label).toBe("Refund a different amount — cannot be reversed");
		expect(String(partial?.label).length).toBeLessThanOrEqual(60);
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
		// A `-review` writes NOTHING — but it DOES re-read, both to bound-check against
		// the LIVE ceiling (DA-3c) and so state 2 can never draw a confirm the write
		// would already refuse (DA-3a at the review step).
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(stub!.requests.some((r) => r.method === "GET")).toBe(true);
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
		// §8's outermost-group rule and §11.2, both explicit: the state-2 body is
		// "banner + staged form + one danger confirm, AND NOTHING ELSE — the meter, the
		// ledger and the full-remaining button are all suppressed". The reason is not
		// tidiness: everything else the group draws is rebuilt from the FRESH read while
		// the confirm alone carries the watermark the operator saw, so a visible ledger
		// beside it is a second reading of the figure the button will NOT be judged
		// against.
		expect(tableWithId(staged, "orders:ord-1:refunds:table")).toBeUndefined();
		expect(findBlock([review!], "meter")).toBeUndefined();
		expect([review!].flatMap((g) => (g.blocks as LooseBlock[]).map((b) => b.type))).toEqual([
			"banner",
			"form",
			"actions",
		]);
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

	test("F-2a, THE POSITIVE CASE: two DELIBERATE identical refunds derive DIFFERENT keys, so both apply — this is what the watermark buys", async () => {
		await boot();
		// The property that makes the whole no-nonce design work, and the one nothing
		// asserted: refund $10, let the ledger advance, re-open, refund $10 again — the
		// two Idempotency-Keys must DIFFER, or the domain (which resolves a duplicate by
		// KEY ALONE with no amount comparison) would swallow the second as a replay and
		// render a success-shaped "Already refunded" for money that never moved.
		//
		// It holds today because the key's third component is read from the freshly
		// loaded summary. This test is what catches a future refactor dropping the
		// watermark render-side, where every other refund assertion stays green.
		// A $30 capture, so there is genuinely room for two $10 refunds — with a $15
		// ceiling the SECOND review is refused by DA-3c, correctly, and the property under
		// test never gets exercised.
		let refundedTotal = 0;
		let remaining = 3000;
		stub!.respondWith("GET", (req) => {
			if (req.url.includes("/refunds")) {
				return {
					status: 200,
					body: {
						ok: true,
						refunds: [],
						currency: "USD",
						capturedTotalCents: 3000,
						refundedTotalCents: refundedTotal,
						ceilingCents: 3000,
						remainingCents: remaining,
						paymentMethod: "stripe",
						refundable: true,
					},
				};
			}
			return makeGetResponder()(req);
		});
		stub!.respondWith("POST", (req) => {
			if (req.url.includes("/refund")) {
				// The ledger ADVANCES, exactly as a real recorded refund would.
				refundedTotal += 1000;
				remaining -= 1000;
				return {
					status: 200,
					body: { ok: true, recorded: true, duplicate: false, fullyRefunded: false },
				};
			}
			return makePostResponder()(req);
		});

		const first = await submitForm(await open("ord-1"), "orders:refund-review", {
			amount: "10.00",
			refundedBy: "carol",
		});
		stub!.requests.length = 0;
		await click(buttonWith(first, "orders:refund"));
		const firstKey = stub!.requests.find((r) => r.method === "POST")!.headers["idempotency-key"];

		// A SECOND, deliberate refund of the SAME amount, staged against the ledger as it
		// now stands.
		const second = await submitForm(await open("ord-1"), "orders:refund-review", {
			amount: "10.00",
			refundedBy: "carol",
		});
		stub!.requests.length = 0;
		const after = await click(buttonWith(second, "orders:refund"));
		const secondKey = stub!.requests.find((r) => r.method === "POST")!.headers["idempotency-key"];

		expect(firstKey).toBe("admin-refund:ord-1:1000:0");
		expect(secondKey).toBe("admin-refund:ord-1:1000:1000");
		expect(secondKey).not.toBe(firstKey);
		// And the second one is recorded, not swallowed as a duplicate.
		expect(findBlocks(after, "banner").find((b) => b.variant === "default")?.title).toBe(
			"Refund recorded",
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
		// §8's normative copy, including THE CAUSAL CLAUSE. "The ledger changed" states
		// an effect and leaves the operator to guess whether they hit a bug; the cause is
		// what stops them retrying identically, and at 76 chars it was never
		// length-driven.
		expect(banner?.description).toBe(
			"$15.00 was staged and was not recorded — someone else refunded this order since you started. $10.00 now remains refundable; re-enter an amount below to try again.",
		);
		expect(String(banner?.description).length).toBeLessThanOrEqual(240);

		// DA-3a-i / X-39, all four clauses on one response: THE SAME GROUP, forced open
		// on a key distinct from both idle and `:review`, the collect group FLATTENED
		// away, the submitted amount prefilled — and NO confirm, because the payload a
		// confirm would carry is the payload just refused.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:refunds:refused"]);
		expect(group(after, "orders:ord-1:refunds")).toBeUndefined();
		expect(group(after, "orders:ord-1:refunds:review")).toBeUndefined();
		expect(group(after, "orders:ord-1:refund-partial")).toBeUndefined();
		expect(buttonWith(after, "orders:refund")).toBeUndefined();
		const retry = formFor(after, "orders:refund-review");
		expect(field(retry, "amount")?.initial_value).toBe("15.00");
		expect(field(retry, "refundedBy")?.initial_value).toBe("carol");
		// And the form's carrier now holds the FRESH watermark, not the stale one — so
		// the operator's next review stages against current truth by construction, and
		// the draft render state deliberately carries no watermark of its own (B-3).
		expect(decodeCarrier(retry?.block_id)).toMatchObject({ refundedSoFar: "500" });
		// The ledger the banner points at IS on screen — a refusal is a state-1 body.
		expect(tableWithId(after, "orders:ord-1:refunds:table")).toBeDefined();
	});

	test("refund review with a blank or zero amount stages nothing and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		// The MOST FREQUENT refusal on this screen is a typo in the amount field, and it
		// is the one where nothing can be re-derived: `parseMinorUnitsInput` returned
		// `null`, so there IS no `amountCents` and `19,99` cannot be reconstructed from
		// cents. The draft therefore carries the raw string and the form prefills it
		// VERBATIM (DA-3a-iii property 5).
		for (const amount of ["0", "abc", "19,99", "12.345"]) {
			const after = await submitForm(blocks, "orders:refund-review", {
				amount,
				reason: "damaged",
				refundedBy: "carol",
			});
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			expect(findBlocks(after, "banner").find((b) => b.variant === "error")?.title).toBe(
				"Not refunded",
			);
			expect(group(after, "orders:ord-1:refunds:review")).toBeUndefined();
			expect(buttonWith(after, "orders:refund")).toBeUndefined();
			expect(openGroupIds(after)).toEqual(["orders:ord-1:refunds:refused"]);
			const retry = formFor(after, "orders:refund-review");
			expect(field(retry, "amount")?.initial_value, `prefill for ${amount}`).toBe(amount);
			expect(field(retry, "reason")?.initial_value).toBe("damaged");
			expect(field(retry, "refundedBy")?.initial_value).toBe("carol");
		}
		// A blank amount refuses too, and there is nothing to put back for it.
		const blank = await submitForm(blocks, "orders:refund-review", {
			amount: "  ",
			refundedBy: "carol",
		});
		expect(field(formFor(blank, "orders:refund-review"), "amount")?.initial_value).toBe("");
	});

	test("DA-3b: a `-review` whose CARRIER lost its watermark refuses as an unreadable payload — it never sends the operator back to an amount field that was already right", async () => {
		await boot();
		const blocks = await open("ord-1");
		const form = formFor(blocks, "orders:refund-review");
		const { refundedSoFar: _dropped, ...noWatermark } = decodeCarrier(form?.block_id) ?? {};
		// The watermark is the ONLY thing missing: a payload edited in devtools, or a tab
		// that rendered before the watermark existed. `5.00` is perfectly valid.
		expect(_dropped).toBe("500");
		stub!.requests.length = 0;
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "orders:refund-review",
				values: { amount: "5.00", reason: "damaged", refundedBy: "carol" },
				block_id: encodeCarrier("orders:refund-partial", noWatermark),
			}),
		);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		// DA-3b's copy, NOT the M-3 parse refusal. Folded together, this branch answered
		// `5.00` with "Enter a valid refund amount greater than zero (e.g. 19.99)" over a
		// field still reading `5.00` — naming a cause that is checkably not the cause and
		// asking the operator to re-type the one thing they got right.
		expect(banner?.title).toBe("That action could not be read");
		expect(String(banner?.description)).toContain("Nothing was changed");
		expect(String(banner?.description)).not.toMatch(/refund amount|19\.99/i);
		// Still a DA-3a-i render: same group, forced open on the refusal key, flattened,
		// every typed value back, no confirm.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:refunds:refused"]);
		expect(group(after, "orders:ord-1:refund-partial")).toBeUndefined();
		expect(buttonWith(after, "orders:refund")).toBeUndefined();
		const retry = formFor(after, "orders:refund-review");
		expect(field(retry, "amount")?.initial_value).toBe("5.00");
		expect(field(retry, "reason")?.initial_value).toBe("damaged");
		expect(field(retry, "refundedBy")?.initial_value).toBe("carol");
	});

	test("DA-3a-i: an unreadable CONFIRM payload puts back the amount it did parse — only a genuinely unparseable one comes back blank", async () => {
		await boot();
		await open("ord-1");
		/** The confirm payload minus its watermark — three of the four disjuncts leave a
		 *  perfectly good `amountCents` in hand, and blanking the field discards it. */
		const refuse = async (amountCents: string): Promise<LooseBlock[]> => {
			stub!.requests.length = 0;
			return blocksOf(
				await sandbox!.invokeRoute("admin", {
					type: "block_action",
					action_id: "orders:refund",
					value: {
						orderId: "ord-1",
						amountCents,
						// `refundedSoFarCents` DELIBERATELY ABSENT — this is what makes the
						// payload unreadable, not the amount.
						currency: "USD",
						reason: "damaged",
						refundedBy: "carol",
					},
				}),
			);
		};
		const parsed = await refuse("1000");
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(findBlocks(parsed, "banner").find((b) => b.variant === "error")?.title).toBe(
			"That action could not be read",
		);
		// THE POINT: `1000` parsed, nothing was written, and the operator's $10.00 is in
		// hand — so it goes back, formatted the way the field showed it. It used to come
		// back EMPTY while `reason` survived one field below, on the reasoning that this
		// branch has "no parsed amount by definition" — true of one of its four disjuncts.
		const retry = formFor(parsed, "orders:refund-review");
		expect(field(retry, "amount")?.initial_value).toBe("10.00");
		expect(field(retry, "reason")?.initial_value).toBe("damaged");
		expect(field(retry, "refundedBy")?.initial_value).toBe("carol");
		expect(openGroupIds(parsed)).toEqual(["orders:ord-1:refunds:refused"]);
		expect(buttonWith(parsed, "orders:refund")).toBeUndefined();
		// And the other side of the conditional: nothing positive to put back ⇒ blank,
		// never a fabricated `0.00`.
		for (const bad of ["abc", "0", "-500"]) {
			const blank = await refuse(bad);
			expect(
				field(formFor(blank, "orders:refund-review"), "amount")?.initial_value,
				`prefill for ${bad}`,
			).toBe("");
		}
	});

	test("DA-3c/X-40: `-review` BOUND-CHECKS against the live ceiling, so a red `Refund $99.99` on a $10 order is never staged at all", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		// An extra zero is the likeliest typo on a money field. Without the bound check
		// this staged a red `Refund $99.99` and a dialog reading "Refund $99.99 to …?" —
		// BOTH FALSE at the exact moment they were shown, on the one step that exists to
		// let an operator check exactly that.
		const after = await submitForm(blocks, "orders:refund-review", {
			amount: "99.99", // 9999 > the live remaining 1000
			refundedBy: "carol",
		});
		// Nothing was written AND nothing was staged.
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(group(after, "orders:ord-1:refunds:review")).toBeUndefined();
		expect(buttonWith(after, "orders:refund")).toBeUndefined();
		// The figure DOES still appear — in the refusal copy, and prefilled verbatim in
		// the form so the operator can fix the extra zero. What must not exist is a
		// CONTROL offering it: no button, no confirm dialog, anywhere in the response.
		expect(buttons(after).some((b) => String(b.label).includes("$99.99"))).toBe(false);
		expect(buttons(after).some((b) => JSON.stringify(confirmOf(b)).includes("$99.99"))).toBe(false);
		// The refusal names THE REAL FIGURE, not just "too high" (DA-3c).
		const banner = findBlocks(after, "banner").find((b) => b.variant === "error");
		expect(banner?.title).toBe("Amount too high");
		expect(banner?.description).toBe(
			"$99.99 is more than the $10.00 that remains refundable on this order. Enter $10.00 or less.",
		);
		expect(String(banner?.description).length).toBeLessThanOrEqual(240);
		// DA-3a-i: forced open, flattened, prefilled verbatim, no confirm.
		expect(openGroupIds(after)).toEqual(["orders:ord-1:refunds:refused"]);
		expect(group(after, "orders:ord-1:refund-partial")).toBeUndefined();
		expect(field(formFor(after, "orders:refund-review"), "amount")?.initial_value).toBe("99.99");
	});

	test("the service's own 409 REFUND_EXCEEDS_TOTAL is still handled — the genuinely concurrent case DA-3c cannot catch", async () => {
		await boot();
		stub!.requests.length = 0;
		// DA-3c bound-checks what `-review` RENDERS; it cannot see a capture that shrinks
		// between the confirm rendering and the click. Drive the confirm directly with a
		// payload whose watermark still matches, so the service is the one that refuses.
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "orders:refund",
				value: {
					orderId: "ord-1",
					amountCents: "9999",
					refundedSoFarCents: "500", // matches the live ledger, so DA-3a passes
					currency: "USD",
					reason: "",
					refundedBy: "carol",
				},
			}),
		);
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

	test("M-11 + D-6b: a $15 order with NOTHING captured reconciles the two figures in copy and REPLACES the degenerate ratio in the label", async () => {
		await boot();
		const blocks = await open("ord-uncaptured");
		const money = panel(blocks, "Money");
		// The contradiction, both halves visible on one screen.
		expect(fieldEntries(blocks)).toContain("Total=$15.00");
		expect(fieldEntries(money)).toContain("Captured=$0.00");
		// M-11 resolves it: which figure is the money that actually moved, and both
		// amounts named. It states the arithmetic and the semantics and does NOT diagnose
		// a cause — "authorised but not settled" is a claim about a provider this screen
		// cannot verify (E-7).
		expect(contextTexts(money)).toContain(
			"Captured is the money that actually arrived; $0.00 of the $15.00 total has been captured so far.",
		);
		expect(contextTexts(money).every((t) => t.length <= 200)).toBe(true);
		// D-6b / X-36: `Refunds — $0.00 of $0.00 refunded` tells an operator nothing and
		// reads like a bug, so the label states the FACT instead of the arithmetic…
		const refunds = group(money, "orders:ord-uncaptured:refunds");
		expect(refunds?.label).toBe("Refunds — nothing captured, nothing to refund");
		expect(String(refunds?.label)).not.toMatch(/\$0\.00 of \$0\.00/);
		// …and the explanatory `context` line inside the group is then DROPPED, rather
		// than sitting under a label that already says it.
		expect(contextTexts([refunds!]).some((t) => t.includes("nothing to refund"))).toBe(false);
		// M-8: no `meter` over a zero denominator — a full-width bar is not a ratio.
		expect(findBlock([refunds!], "meter")).toBeUndefined();
		// And no refund control at all (DA-7).
		expect(buttonWith(blocks, "orders:refund")).toBeUndefined();
		expect(formFor(blocks, "orders:refund-review")).toBeUndefined();
	});

	test("M-11's line is absent when captured EQUALS the total — the rule fires on disagreement, not unconditionally", async () => {
		await boot();
		expect(
			contextTexts(panel(await open("ord-1"), "Money")).some((t) =>
				t.includes("the money that actually arrived"),
			),
		).toBe(false);
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
		// §11.2: the Notes group is FORM ONLY. Its read table repeated the timeline
		// verbatim — a `note` entry's `Detail` column IS the note body, and the
		// timeline's cap (50) is looser than the notes cap (20) was — so the table added
		// a duplicate rendering, a second cap line, and nothing else.
		expect(((notes?.blocks ?? []) as LooseBlock[]).map((b) => b.type)).toEqual(["form"]);
		expect(tableWithId(blocks, "orders:ord-1:notes:table")).toBeUndefined();
		// And the timeline is still the read path for both note bodies.
		const details = tableRows([timeline!]).map((r) => String(r.detail));
		expect(details).toContain("Called the customer back.");
	});

	test("T-8a: the timeline cap line is emitted ONLY when the read was actually truncated", async () => {
		await boot();
		// Four entries, cap 50 ⇒ nothing was withheld, so the sentence is not true news.
		expect(
			contextTexts(panel(await open("ord-1"), "History")).some((t) => t.includes("most recent")),
		).toBe(false);

		// 60 entries ⇒ rows really are missing, and the line says so.
		stub!.respondWith("GET", (req) => {
			if (req.url.includes("/timeline")) {
				return {
					status: 200,
					body: {
						ok: true,
						timeline: {
							orderId: "ord-1",
							stateChangesAudited: true,
							entries: Array.from({ length: 60 }, (_unused, i) => ({
								kind: "created",
								at: `2026-07-10T01:${String(i).padStart(2, "0")}:00.000Z`,
							})),
						},
					},
				};
			}
			return makeGetResponder()(req);
		});
		const truncated = panel(await open("ord-1"), "History");
		expect(tableRows([tableWithId(truncated, "orders:timeline")!])).toHaveLength(50);
		expect(contextTexts(truncated)).toContain(
			"Showing the 50 most recent events; older activity is not listed.",
		);
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
		expect(onDetailOf(after, "ord-1")).toBe(true);
		expect(group(after, "orders:ord-1:notes")).toBeDefined();
	});

	test("add-note with a blank body shows an inline error and makes NO POST", async () => {
		await boot();
		const blocks = await open("ord-1");
		stub!.requests.length = 0;
		const after = await submitForm(blocks, "orders:add-note", { author: "carol", body: "   " });
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(onDetailOf(after, "ord-1")).toBe(true);
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

	test("X-41: no rendered `context` or `banner` narrates a design decision, on any record state (DA-7a, E-4)", async () => {
		await boot();
		for (const id of [
			"ord-1",
			"ord-proc",
			"ord-shipped",
			"ord-flagged",
			"ord-guest",
			"ord-cancelled",
			"ord-x402",
			"ord-refunded",
			"ord-uncaptured",
		]) {
			const blocks = await open(id);
			const prose = [
				...contextTexts(blocks),
				...findBlocks(blocks, "banner").flatMap((b) => [String(b.title), String(b.description)]),
			];
			for (const line of prose) {
				// "deliberately" / "there is no" / "we do not" tell an operator what
				// designers withheld — a fact they cannot act on — and the useful version
				// is 30 characters SHORTER, so this is not a trade-off.
				expect(line.toLowerCase(), `on ${id}`).not.toMatch(/deliberately|there is no|we do not/);
				expect(line, `on ${id}`).not.toMatch(/point of no return/i);
			}
		}
	});

	test("F-6c: the one remaining `select` shows HUMAN LABELS, so no wire value like `customer_request` reaches the screen", async () => {
		await boot();
		const blocks = await open("ord-1");
		const form = formFor(blocks, "orders:cancel-review");
		const reason = field(form, "reason");
		// The pinned renderer's trigger renders the raw option VALUE, not its label
		// (R-17a), so with wire values here an operator read `customer_request` — directly
		// beneath four buttons already showing the human labels. This was the last piece
		// of visible plumbing on the screen.
		const options = (reason?.options ?? []) as Array<{ value: string; label: string }>;
		expect(options.map((o) => o.value)).toEqual([
			"Customer requested it",
			"Fraud suspected",
			"Out of stock",
			"Pricing error",
			"Other",
		]);
		for (const o of options) expect(o.value).toBe(o.label);
		// `Other` no longer promises a field: the Detail input is the next field down.
		expect(fieldIds(form)).toEqual(["reason", "detail", "cancelledBy"]);
		// And no wire value appears anywhere an operator can read.
		const readable = [
			...contextTexts(blocks),
			...findBlocks(blocks, "form").flatMap((f) =>
				((f.fields ?? []) as Array<Record<string, unknown>>).flatMap((fl) => [
					String(fl.label),
					...((fl.options ?? []) as Array<{ value: string }>).map((o) => String(o.value)),
				]),
			),
			...buttons(blocks).map((b) => String(b.label)),
		];
		for (const text of readable) {
			expect(text).not.toMatch(/customer_request|fraud_suspected|out_of_stock|pricing_error/);
		}
	});

	// X-20 (the banned-slogan check) and every other H-marked §13 row this
	// helper enforces now live in `assertBlockContract` (§15 V-3/V-3a) instead
	// of a hand-rolled assertion here — this is the "wire it into the Orders
	// suite" half of that PR: one call on the list, one per open record state.
	test("assertBlockContract holds on the list and on every open record state (§15 V-3)", async () => {
		await boot();
		assertBlockContract(await list(), { screen: "orders", level: "list" });
		for (const id of [
			"ord-1",
			"ord-proc",
			"ord-shipped",
			"ord-flagged",
			"ord-guest",
			"ord-cancelled",
			"ord-x402",
			"ord-refunded",
			"ord-uncaptured",
			// D4's two new render states, through the SAME gate as the rest — the
			// twins page is where option labels are closest to colliding (X-22) and
			// the long-buyer order is where the confirm dialog is closest to its
			// 200-character budget (X-11), so neither may take the short-id change
			// as licence to skip the sweep.
			"ord-long-buyer",
		]) {
			assertBlockContract(await open(id), { screen: "orders", level: "detail" });
		}
		listRows = "twins";
		assertBlockContract(await list(), { screen: "orders", level: "list" });
		for (const id of [TWIN_ID_A, TWIN_ID_B]) {
			assertBlockContract(await open(id), { screen: "orders", level: "detail" });
		}
	});
});
