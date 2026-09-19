/**
 * INC-C5 revision (review A2/B6) — the two in-process egress adapters, driven
 * inside REAL workerd, with their URLs BAKED INTO THE SCRATCH MANIFEST.
 *
 * WHY THIS FILE EXISTS. INC-C5 added `emailApiUrl`/`facilitatorUrl` to the
 * sandbox harness and then never set either, so `CtxHttpEmailSender.send` and
 * `createHttpFacilitator.verifyReceipt` had never once run inside an isolate:
 * every sandbox assertion was about the UNCONFIGURED arm, which is the arm where
 * neither adapter is constructed at all. The property only the sandbox can prove
 * is exactly the one this increment changed — that these adapters reach the
 * network THROUGH `ctx.http` and are therefore subject to `allowedHosts` — and
 * `CLAUDE.md` requires the workerd tier for plugin work for precisely that
 * reason.
 *
 * THE TWO BOOTS ARE THE WHOLE POINT. Both bake the SAME two URLs; they differ
 * only in whether the stub's host is in `allowedHosts`. The granted boot proves
 * the bytes arrive (the stub records the request, headers and all). The refused
 * boot proves the gate — not a typo, not an unreachable port — is what stops
 * them: the same code, the same baked URL, ZERO recorded requests. A bare
 * `fetch` anywhere in either adapter would pass the first boot and fail the
 * second, which is the regression this pair is here to catch.
 *
 * ONE STORE, SHARED, SO ORDERING IS LOAD-BEARING. The outbox lives in the
 * process-scoped bridge both boots proxy to, and any tick drains every pending
 * row — so the refused case seeds its order only AFTER the granted case has
 * ticked. Each case still namespaces its ids.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import type { CommerceSweepSummary, SweepLegOutcome } from "../src/cron/index.js";
import { X402_SETTLE_ROUTE } from "../src/payments/x402-settle-route.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A well-formed EVM address — `isPlausiblePayTo` refuses anything else, so a
 *  placeholder like "0xshop" would arm no gateway and make every x402 case
 *  below pass for the wrong reason. */
const PAY_TO = "0x00000000000000000000000000000000000000a1";
const EMAIL_FROM = "orders@egress.example";

/** The two paths the stub answers on. Distinct so a single responder can say
 *  which adapter it heard from — and so an assertion about "the email call"
 *  cannot be satisfied by the facilitator call. */
const EMAIL_PATH = "/email/send";
const FACILITATOR_PATH = "/x402/verify";

let stub: StubCommerceServer;
let granted: SandboxHandle;
let refused: SandboxHandle;
let storage: StorageAccess;

function stores() {
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	return {
		inventory,
		orderStore: new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock: systemClock }),
	};
}

/** A paid order, which is what puts a row in the email outbox — the outbox is
 *  the only thing the `order-emails` leg acts on. */
async function placePaidOrder(suffix: string): Promise<string> {
	const s = stores();
	const sku = `EGRESS-${suffix}`;
	const id = `order-egress-${suffix}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${suffix}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	const holdExpiresAt = new Date(Date.now() + DAY_MS).toISOString();
	await s.inventory.stampHoldDeadline(held.reservationId, holdExpiresAt);
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt,
		now: new Date().toISOString(),
	});
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-egress-${suffix}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt,
		buyerRef: `buyer-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-egress-${suffix}`),
				sku: toSku(sku),
				title: "Egress Widget",
				unitPrice: cents(1999),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1999), total: cents(1999), currency: currency("USD") },
	});
	// `markPaid` is what enqueues the outbox row the dispatcher drains.
	await s.orderStore.markPaid(toOrderId(id));
	return id;
}

/** One cron tick through an isolate, as the host's executor drives it. */
async function tick(sandbox: SandboxHandle): Promise<SweepLegOutcome> {
	const outcome = await sandbox.invokeHook("cron", {
		name: SWEEP_TASK_NAME,
		scheduledAt: new Date().toISOString(),
	});
	if ("error" in outcome) throw new Error(outcome.error);
	const summary = outcome.result as CommerceSweepSummary;
	const found = summary.legs.find((entry) => entry.leg === "order-emails");
	if (found === undefined) throw new Error("no order-emails leg in the summary");
	if (!found.ok) throw new Error(`order-emails failed: ${found.error ?? "unknown"}`);
	return found;
}

/** The non-secret settings both adapters read, written through the ONLY writer
 *  an operator has (the Settings screen) rather than injected — so this suite
 *  also pins that the A3 form actually reaches the kv these adapters read. */
async function configure(sandbox: SandboxHandle): Promise<void> {
	const saved = await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-payment-settings",
		values: { emailFrom: EMAIL_FROM, x402PayTo: PAY_TO, x402Accepts: "eip155:8453" },
	});
	if ("error" in saved) throw new Error(saved.error);
}

/**
 * A pending, digital, x402-paid order — the state the settle route's CHECK 2
 * demands before it will spend a facilitator call.
 *
 * WHY THIS REPLACED A BARE UUID (review round 2, A1/B1). These cases used to
 * settle a proof naming NO order, on the reasoning that `settleOrder` asked the
 * facilitator first and `ORDER_NOT_FOUND` therefore proved the network had been
 * reached. That ordering is exactly what the review closed: the route now loads
 * the order and refuses a non-x402 one BEFORE any egress, so a nonexistent order
 * proves the opposite — that nothing was asked. A real order is what makes the
 * egress assertion mean anything again.
 */
async function placePendingX402Order(suffix: string): Promise<string> {
	const s = stores();
	const id = crypto.randomUUID();
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`x402-create-${suffix}`),
		holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		buyerRef: `buyer-x402-${suffix}@example.test`,
		paymentMethod: "x402",
		lines: [
			{
				productId: toProductId(`prod-x402-${suffix}`),
				sku: toSku(`X402-${suffix}`),
				title: "Digital Widget",
				unitPrice: cents(1999),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1999), total: cents(1999), currency: currency("USD") },
	});
	return id;
}

/** A syntactically valid page-gate proof for a seeded order. */
function proofFor(orderId: string) {
	return {
		orderId,
		transaction: `0xtx-${orderId}`,
		network: "eip155:8453",
		payer: "0x00000000000000000000000000000000000000b2",
		amount: 1999,
		currency: "USD",
		signature: "sig-not-checked-by-this-stub",
	};
}

function postsTo(pathname: string): number {
	return stub.requests.filter((req) => req.method === "POST" && req.url === pathname).length;
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	stub = await startStubCommerceServer();
	stub.respondWith("POST", (req) => {
		if (req.url === FACILITATOR_PATH) {
			const asked = req.body as { orderId?: string; transaction?: string };
			// ECHOES THE QUESTION, because the adapter now refuses an answer that
			// does not (review B7) — a stub replying a bare `{valid:true}` would
			// still pass, but this is the shape a real facilitator returns.
			return {
				status: 200,
				body: { valid: true, orderId: asked.orderId, transaction: asked.transaction },
			};
		}
		if (req.url === EMAIL_PATH) return { status: 202, body: { queued: true } };
		return { status: 404, body: { error: "unexpected path" } };
	});

	const egress = {
		emailApiUrl: `${stub.baseUrl}${EMAIL_PATH}`,
		facilitatorUrl: `${stub.baseUrl}${FACILITATOR_PATH}`,
	};
	[granted, refused] = await Promise.all([
		loadPluginInSandbox({
			// The stub's host IS granted — production derives exactly this from the
			// same two URLs.
			allowedHosts: [stub.host],
			storage: true,
			...egress,
		}),
		loadPluginInSandbox({
			// SAME baked URLs, host NOT granted. Everything else is identical, so a
			// difference in outcome can only be the gate.
			allowedHosts: ["not-the-stub.invalid"],
			storage: true,
			...egress,
		}),
	]);
	await configure(granted);
	await configure(refused);
}, 300_000);

afterAll(async () => {
	await granted?.close();
	await refused?.close();
	await stub?.close();
});

describe("the email adapter, inside workerd", () => {
	test("a baked email URL on a granted host actually reaches the provider", async () => {
		const orderId = await placePaidOrder("granted");
		const before = postsTo(EMAIL_PATH);

		const leg = await tick(granted);
		// NOT `skipped`: a sender was built, which only happens when the bundle
		// carries an email URL.
		expect(leg.skipped).toBeUndefined();
		expect(leg.count).toBeGreaterThanOrEqual(1);

		const sends = stub.requests.filter((req) => req.method === "POST" && req.url === EMAIL_PATH);
		expect(sends.length).toBeGreaterThan(before);
		const sent = sends[sends.length - 1];
		if (sent === undefined) throw new Error("no recorded send");
		// The from-address came out of kv, written through the Settings form — the
		// whole configuration path, end to end, inside the isolate.
		expect(sent.body).toMatchObject({ from: EMAIL_FROM, to: "buyer-granted@example.test" });
		// THE IDEMPOTENCY HEADER IS THE OUTBOX ROW ID. Losing it is a silent
		// duplicate-email bug, so it is asserted on the wire and not in a unit test
		// of the sender alone.
		expect(sent.headers["idempotency-key"]).toBeTruthy();
		void orderId;
	}, 300_000);

	test("the same baked URL is REFUSED when its host is not in allowedHosts", async () => {
		await placePaidOrder("refused");
		const before = postsTo(EMAIL_PATH);

		const leg = await tick(refused);
		// A sender WAS built — the URL is baked — so this is not the `skipped` arm.
		// The send itself is refused by `ctx.http`, the dispatcher's per-row catch
		// leaves the row unsent, and the leg honestly reports nothing drained.
		expect(leg.skipped).toBeUndefined();
		expect(leg.count).toBe(0);
		// THE ASSERTION THAT MATTERS: the provider heard nothing at all.
		expect(postsTo(EMAIL_PATH)).toBe(before);
	}, 300_000);
});

describe("the x402 facilitator, inside workerd", () => {
	test("a baked facilitator URL on a granted host actually reaches the facilitator", async () => {
		const orderId = await placePendingX402Order("granted");
		const before = postsTo(FACILITATOR_PATH);

		const outcome = await granted.invokeRoute(X402_SETTLE_ROUTE, proofFor(orderId));
		if ("error" in outcome) throw new Error(outcome.error);

		// A full settlement, end to end inside the isolate: the facilitator was
		// asked over `ctx.http`, its echoing `valid: true` was accepted, and the
		// domain moved the order. A refused proof would have been 400
		// INVALID_SIGNATURE and an unreachable one 503.
		expect(outcome.result).toEqual({ ok: true, status: 200 });

		const calls = stub.requests.filter(
			(req) => req.method === "POST" && req.url === FACILITATOR_PATH,
		);
		expect(calls.length).toBe(before + 1);
		const asked = calls[calls.length - 1];
		if (asked === undefined) throw new Error("no recorded verification");
		// The WHOLE receipt is forwarded, with `amount` still an integer minor unit.
		expect(asked.body).toMatchObject({ orderId, amount: 1999, currency: "USD" });
	}, 300_000);

	test("the same baked URL is REFUSED when its host is not in allowedHosts", async () => {
		const orderId = await placePendingX402Order("refused");
		const before = postsTo(FACILITATOR_PATH);

		const outcome = await refused.invokeRoute(X402_SETTLE_ROUTE, proofFor(orderId));
		if ("error" in outcome) throw new Error(outcome.error);

		// 503, NOT 400: a transport the gate refused is "we could not ask", which
		// must never present to a buyer whose money already moved as "your receipt
		// is invalid" (review B2).
		expect(outcome.result).toEqual({
			ok: false,
			status: 503,
			reason: "FACILITATOR_UNAVAILABLE",
		});
		expect(postsTo(FACILITATOR_PATH)).toBe(before);
	}, 300_000);
});
