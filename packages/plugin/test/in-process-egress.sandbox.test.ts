/**
 * INC-C5 revision (review A2/B6) — the in-process email adapter, driven
 * inside REAL workerd, with its URL BAKED INTO THE SCRATCH MANIFEST.
 *
 * WHY THIS FILE EXISTS. INC-C5 added `emailApiUrl` to the sandbox harness and
 * then never set it, so `CtxHttpEmailSender.send` had never once run inside an
 * isolate: every sandbox assertion was about the UNCONFIGURED arm, which is the
 * arm where the adapter is not constructed at all. The property only the sandbox
 * can prove is exactly the one this increment changed — that the adapter reaches
 * the network THROUGH `ctx.http` and is therefore subject to `allowedHosts` — and
 * `CLAUDE.md` requires the workerd tier for plugin work for precisely that
 * reason.
 *
 * THE TWO BOOTS ARE THE WHOLE POINT. Both bake the SAME URL; they differ
 * only in whether the stub's host is in `allowedHosts`. The granted boot proves
 * the bytes arrive (the stub records the request, headers and all). The refused
 * boot proves the gate — not a typo, not an unreachable port — is what stops
 * them: the same code, the same baked URL, ZERO recorded requests. A bare
 * `fetch` anywhere in the adapter would pass the first boot and fail the
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
import { startStubHttpServer, type StubHttpServer } from "./helpers/stub-http-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const EMAIL_FROM = "orders@egress.otta.sh";

/** The path the stub answers on. */
const EMAIL_PATH = "/email/send";

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

/** The non-secret setting the adapter reads, written through the ONLY writer
 *  an operator has (the Settings screen) rather than injected — so this suite
 *  also pins that the A3 form actually reaches the kv the adapter reads. */
async function configure(sandbox: SandboxHandle): Promise<void> {
	const saved = await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-payment-settings",
		values: { emailFrom: EMAIL_FROM },
	});
	if ("error" in saved) throw new Error(saved.error);
}

function postsTo(pathname: string): number {
	return stub.requests.filter((req) => req.method === "POST" && req.url === pathname).length;
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	stub = await startStubHttpServer();
	stub.respondWith("POST", (req) => {
		if (req.url === EMAIL_PATH) return { status: 202, body: { queued: true } };
		return { status: 404, body: { error: "unexpected path" } };
	});

	const egress = { emailApiUrl: `${stub.baseUrl}${EMAIL_PATH}` };
	[granted, refused] = await Promise.all([
		loadPluginInSandbox({
			// The stub's host IS granted — production derives exactly this from the
			// same URL.
			allowedHosts: [stub.host],
			storage: true,
			...egress,
		}),
		loadPluginInSandbox({
			// SAME baked URL, host NOT granted. Everything else is identical, so a
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
