/**
 * INC-C5 revision (review A2/B6) — the plugin's outbound email, driven inside
 * REAL workerd.
 *
 * EMAIL IS NOT EGRESS ANY MORE (ADR-0031). It goes through the host's
 * `ctx.email`; this file pins exactly that: with a provider wired the order
 * email reaches it and NOTHING reaches the network, and with none the leg
 * reports `skipped` and nothing goes anywhere.
 *
 * THE TWO BOOTS. They differ only in whether an EmDash email provider is wired
 * and whether the stub's host is in `allowedHosts`. The stub records every
 * request, so "the stub saw nothing" is what proves no email left over
 * `ctx.http` — in the boot whose gate would have let it through, too.
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

beforeAll(async () => {
	({ storage } = await storageBridge());
	stub = await startStubHttpServer();
	stub.respondWith("POST", () => ({ status: 404, body: { error: "unexpected path" } }));

	[granted, refused] = await Promise.all([
		loadPluginInSandbox({
			// The stub's host IS granted, and an EmDash email provider is wired
			// behind `ctx.email`.
			allowedHosts: [stub.host],
			storage: true,
			email: true,
		}),
		loadPluginInSandbox({
			// Host NOT granted, and NO email provider selected.
			allowedHosts: ["not-the-stub.invalid"],
			storage: true,
		}),
	]);
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
