/**
 * INC-C5 revision (review A2/B6) — the plugin's outbound adapters, driven inside
 * REAL workerd, with the facilitator URL BAKED INTO THE SCRATCH MANIFEST.
 *
 * EMAIL IS NOT EGRESS ANY MORE (ADR-0031). It goes through the host's
 * `ctx.email`; the email half of this file now pins exactly that: with a
 * provider wired the order email reaches it and NOTHING reaches the network,
 * and with none the leg reports `skipped` and nothing goes anywhere. The history
 * below is kept for the x402 half.
 *
 * WHY THIS FILE EXISTS. INC-C5 added the email and facilitator URLs to the
 * sandbox harness and then never set either, so `CtxHttpEmailSender.send` and
 * the x402 facilitator call had never once run inside an isolate:
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
 * THE x402 HALF IS NOW A NEGATIVE. ADR-0028 increment 2 retired the
 * receipt-forwarding facilitator call (`createHttpFacilitator.verifyReceipt`) and
 * its only caller, the public `entitlements/x402/settle` route. What this file
 * pins for x402 now is that the route is gone from a fully configured isolate,
 * and that nothing reaches a granted, baked facilitator URL through it.
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
import { startStubHttpServer, type StubHttpServer } from "./helpers/stub-http-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A well-formed EVM address — `isPlausiblePayTo` refuses anything else, so a
 *  placeholder like "0xshop" would arm no gateway and make every x402 case
 *  below pass for the wrong reason. */
const PAY_TO = "0x00000000000000000000000000000000000000a1";

/** The path the stub answers on. */
const FACILITATOR_PATH = "/x402/verify";

let stub: StubHttpServer;
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
		values: { x402PayTo: PAY_TO, x402Accepts: "eip155:8453" },
	});
	if ("error" in saved) throw new Error(saved.error);
}

/**
 * A pending, digital, x402-paid order — the state the retired settle route
 * demanded before it would spend a facilitator call. Seeding it is what makes
 * the negative below mean something: with the route still registered, this
 * order and {@link proofFor} reached the facilitator and settled.
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
	stub = await startStubHttpServer();
	stub.respondWith("POST", (req) => {
		if (req.url === FACILITATOR_PATH) {
			const asked = req.body as { orderId?: string; transaction?: string };
			// Answers as the retired receipt-forwarding facilitator expected, echo
			// and all, so anything that still reached it would be ACCEPTED — the
			// x402 case below can then only pass on the request count.
			return {
				status: 200,
				body: { valid: true, orderId: asked.orderId, transaction: asked.transaction },
			};
		}
		return { status: 404, body: { error: "unexpected path" } };
	});

	const egress = { facilitatorUrl: `${stub.baseUrl}${FACILITATOR_PATH}` };
	[granted, refused] = await Promise.all([
		loadPluginInSandbox({
			// The stub's host IS granted — production derives exactly this from the
			// same URL. An EmDash email provider is wired behind `ctx.email`.
			allowedHosts: [stub.host],
			storage: true,
			email: true,
			...egress,
		}),
		loadPluginInSandbox({
			// SAME baked URL, host NOT granted, and NO email provider selected.
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

describe("order email through ctx.email, inside workerd (ADR-0031)", () => {
	test("with an EmDash provider wired the order email reaches it, and no email touches the network", async () => {
		await placePaidOrder("granted");
		const before = stub.requests.length;

		const leg = await tick(granted);
		expect(leg.skipped).toBeUndefined();
		expect(leg.count).toBeGreaterThanOrEqual(1);

		const mail = granted.sentEmails().find((m) => m.to === "buyer-granted@example.test");
		if (mail === undefined) throw new Error("no message reached the provider");
		// EmDash's `EmailMessage`, exactly: no `from` (the provider owns it).
		expect(Object.keys(mail).toSorted()).toEqual(["html", "subject", "text", "to"]);
		expect(mail.text).toContain("Egress Widget × 1 — $19.99");
		// THE ASSERTION THAT MATTERS: no request went out over `ctx.http` at all.
		expect(stub.requests.length).toBe(before);
	}, 300_000);

	test("with NO provider selected the leg reports skipped, and nothing goes anywhere", async () => {
		await placePaidOrder("refused");
		const before = stub.requests.length;

		const leg = await tick(refused);
		// The host's sandbox bridge says "Email is not configured": the row goes back
		// uncounted and the leg honestly reports the configuration.
		expect(leg).toMatchObject({ count: 0, skipped: true });
		expect(refused.sentEmails()).toEqual([]);
		expect(stub.requests.length).toBe(before);
	}, 300_000);
});

describe("the x402 facilitator, inside workerd (ADR-0028 increment 2)", () => {
	test("the retired entitlements/x402/settle route is not registered, and asks no facilitator", async () => {
		const orderId = await placePendingX402Order("retired");
		const before = postsTo(FACILITATOR_PATH);

		// The granted boot: facilitator URL baked, its host allowed, `payTo` saved.
		// Everything the old route needed to settle this order is in place, so an
		// `unknown route` here is the deletion, not a misconfiguration.
		const outcome = await granted.invokeRoute("entitlements/x402/settle", proofFor(orderId));
		expect(outcome).toEqual({ error: "unknown route: entitlements/x402/settle" });
		expect(postsTo(FACILITATOR_PATH)).toBe(before);
	}, 300_000);
});
