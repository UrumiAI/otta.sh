/**
 * INC-C4 — the `cron` hook and its nine sweep legs, driven inside REAL workerd.
 *
 * WHY THE SANDBOX AND NOT A UNIT TEST. The sweeps are the plugin's only
 * unattended code path: nobody is watching when they run, and "it worked in
 * trusted mode" is precisely the claim `CLAUDE.md` forbids. So the hook is
 * invoked as the host's cron executor invokes it — `POST /hook/cron` into the
 * isolate — against a real `PluginStorageRepository` over SQLite, and every
 * assertion is made from OUTSIDE the isolate against the same documents.
 *
 * HOW A CASE IS BUILT. The store lives in this process (see
 * `sandbox/storage-bridge.ts`), so the setup below uses the REAL adapters against
 * it — not hand-written documents — and reaches for a raw document write only to
 * INJECT A PARTIAL STATE: the half-completed shape a crash leaves behind, which
 * by construction no successful API call can produce. That is what the five new
 * sweepers are for, and a happy-path invocation would prove nothing about them.
 *
 * PAST DEADLINES ARE REAL PAST DEADLINES. The isolate runs on the wall clock, so
 * a case that needs an expired hold builds one with a store pinned to an hour ago
 * rather than by advancing a clock the isolate cannot see.
 *
 * ONE STORE PER PROCESS, so every case namespaces its ids with its own suffix —
 * the same discipline the other sandbox suites keep for kv.
 *
 * TWO TICKS, ONE EFFECT. Idempotency is asserted on the EFFECT (the document, the
 * balance, the pointer) rather than only on a leg's count, because this store is
 * shared and another case's leftovers could make a count non-zero without any
 * work having been repeated.
 */
import {
	currency,
	customerId as toCustomerId,
	email as toEmail,
	idempotencyKey,
	money,
	cents,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashCartStore,
	EmdashCouponStore,
	EmdashCredentialVerifier,
	EmdashCustomerStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	systemClock,
	uuidIdGen,
	type InventoryDoc,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_LEGS,
	SWEEP_SCHEDULE,
	SWEEP_TASK_NAME,
} from "../src/cron/index.js";
import type {
	CommerceSweepOptions,
	CommerceSweepSummary,
	SweepCursorStore,
	SweepLeg,
	SweepLegOutcome,
} from "../src/cron/index.js";
import { STOREFRONT_LIST_ROUTE } from "../src/storefront/plp-route.js";
import type { PluginContext } from "../src/types.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let sandbox: SandboxHandle;
let storage: StorageAccess;

/** Every store built the way the composition root builds it, except for the clock
 *  — which a case pins to the past when it needs a deadline that has already
 *  passed by the time the isolate looks at it. */
function stores(at?: Date) {
	const clock = at === undefined ? systemClock : new FixedClock(at);
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock });
	const customerStore = new EmdashCustomerStore({ storage, idGen: uuidIdGen, clock });
	return {
		clock,
		inventory,
		customerStore,
		cartStore: new EmdashCartStore({ storage, inventory, idGen: uuidIdGen, clock }),
		orderStore: new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock }),
		productCommerce: new EmdashProductCommerceStore({ storage, clock }),
		couponStore: new EmdashCouponStore({ storage, idGen: uuidIdGen, clock }),
	};
}

/** One cron tick, through the isolate, as the host's executor would drive it. */
async function tick(): Promise<CommerceSweepSummary> {
	const outcome = await sandbox.invokeHook("cron", {
		name: SWEEP_TASK_NAME,
		scheduledAt: new Date().toISOString(),
	});
	if ("error" in outcome) throw new Error(outcome.error);
	return outcome.result as CommerceSweepSummary;
}

function leg(summary: CommerceSweepSummary, name: SweepLeg): SweepLegOutcome {
	const found = summary.legs.find((entry) => entry.leg === name);
	if (found === undefined) throw new Error(`no ${name} leg in the summary`);
	// A leg that threw must surface HERE, with its own message, rather than as a
	// confusing zero somewhere below.
	if (!found.ok) throw new Error(`${name} failed: ${found.error ?? "unknown"}`);
	return found;
}

/** A physical order over one real, adopted reservation — the shape every
 *  hold-related leg acts on. */
async function placeOrder(
	suffix: string,
	options: { at: Date; holdExpiresAt: string },
): Promise<{ id: string; sku: string; reservationId: string }> {
	const s = stores(options.at);
	const sku = `CRON-${suffix}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 2, idempotencyKey(`res-${suffix}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	const id = `order-${suffix}`;
	// The cart stamps a hold's deadline when the line is added, and an UNSTAMPED
	// hold is not adoptable — so a seed that skipped this would build an order whose
	// holds were all "lost" from the start, and every hold assertion below would be
	// about the seed rather than about the sweep.
	await s.inventory.stampHoldDeadline(
		held.reservationId,
		new Date(Date.now() + DAY_MS).toISOString(),
	);
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt: options.holdExpiresAt,
		now: options.at.toISOString(),
	});
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-${suffix}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt: options.holdExpiresAt,
		buyerRef: `buyer-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${suffix}`),
				sku: toSku(sku),
				title: "Sweep Widget",
				unitPrice: cents(1999),
				currency: currency("USD"),
				quantity: 2,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(3998), total: cents(3998), currency: currency("USD") },
	});
	return { id, sku, reservationId: held.reservationId };
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	sandbox = await loadPluginInSandbox({
		// A host that CANNOT exist (RFC 2606 `.invalid`), because the sweeps this
		// suite drives make no egress at all: the allowlist is here to be non-empty
		// and unreachable, not to name anything real. (It used to name a placeholder
		// commerce-service host, which INC-D3a retired along with the service.)
		allowedHosts: ["no-egress.invalid"],
		storage: true,
	});
}, 180_000);

afterAll(async () => {
	await sandbox?.close();
});

describe("the cron hook", () => {
	// FIRST IN THE FILE, DELIBERATELY: it asserts what an untouched isolate holds,
	// so anything that registered the task before it would make it vacuous.
	test("a storefront route registers the task, for a deployment that never activates", async () => {
		// THE REGISTRATION GAP, pinned. Otta is hand-registered in the site config's
		// `plugins` array, so the host fires `plugin:activate` for it NEVER — that runs
		// only from an admin enable toggle — while its routes and content hooks run
		// from the first request. A plugin that registered its task only on activation
		// would have a declared `cron` hook and no task row, forever, and every sweep
		// in this suite would be dead code in production. So reaching an ordinary
		// public route has to be enough on its own.
		expect(await cronTasks()).toHaveLength(0);

		const listed = await sandbox.invokeRoute(STOREFRONT_LIST_ROUTE, {});
		// The PLP's own outcome is beside the point; what is asserted is the
		// registration it performed on the way in.
		void listed;

		expect((await cronTasks()).map((entry) => entry.name)).toContain(SWEEP_TASK_NAME);
	}, 120_000);

	test("registers its task on plugin:activate, and again on every tick", async () => {
		const activated = await sandbox.invokeHook("plugin:activate", {});
		if ("error" in activated) throw new Error(activated.error);
		// THE ASSERTION THAT MATTERS is `tasks`, not `scheduled`. `scheduled: true`
		// says only that the handler called `ctx.cron.schedule` and the call resolved
		// — it would still be true if the host's registration were a no-op, which is
		// exactly the failure mode this increment shipped with. `tasks` is the host's
		// own `ctx.cron.list()`, read back after the upsert: it says a ROW EXISTS,
		// under this name, at this cadence, which is the only thing that makes the
		// executor ever fire the `cron` hook.
		expect(activated.result).toMatchObject({
			scheduled: true,
			task: SWEEP_TASK_NAME,
			schedule: SWEEP_SCHEDULE,
		});
		const tasks = (activated.result as { tasks: Array<{ name: string; schedule: string }> }).tasks;
		expect(tasks.map((entry) => ({ name: entry.name, schedule: entry.schedule }))).toContainEqual({
			name: SWEEP_TASK_NAME,
			schedule: SWEEP_SCHEDULE,
		});

		// And the upsert really is an upsert: a second activation leaves ONE row.
		const again = await sandbox.invokeHook("plugin:activate", {});
		if ("error" in again) throw new Error(again.error);
		const reaffirmed = (again.result as { tasks: Array<{ name: string }> }).tasks;
		expect(reaffirmed.filter((entry) => entry.name === SWEEP_TASK_NAME)).toHaveLength(1);
	}, 120_000);

	test("a task this plugin did not register is not this plugin's work", async () => {
		const outcome = await sandbox.invokeHook("cron", {
			name: "someone-elses-task",
			scheduledAt: new Date().toISOString(),
		});
		if ("error" in outcome) throw new Error(outcome.error);
		expect(outcome.result).toEqual({ task: "someone-elses-task", skipped: true });
	}, 120_000);

	test("one tick drives all nine legs, and a leg never starves the others", async () => {
		const summary = await tick();
		expect(summary.task).toBe(SWEEP_TASK_NAME);
		expect(summary.legs.map((entry) => entry.leg)).toEqual([...SWEEP_LEGS]);
		// Every leg reports for itself. A failing one is a row here, not a rejected
		// hook — which is the whole point of the per-leg try/catch.
		for (const entry of summary.legs) {
			expect({ leg: entry.leg, ok: entry.ok, error: entry.error }).toEqual({
				leg: entry.leg,
				ok: true,
				error: undefined,
			});
		}
	}, 120_000);
});

describe("the four ported sweeps", () => {
	test("expire-holds reclaims a past-TTL cart hold, and a second tick reclaims nothing", async () => {
		const suffix = "holds";
		const past = new Date(Date.now() - HOUR_MS);
		const s = stores(past);
		const sku = `CRON-${suffix}`;
		await s.inventory.seedOnHand(toSku(sku), 10);
		// A real hold on a real cart line, carrying a deadline that passed half an
		// hour ago — so it is genuinely past by the wall clock the isolate reads,
		// rather than by a clock the isolate cannot see.
		// ONE key for the reserve and the line, as the real add-to-cart path uses:
		// the reservation's own reserve key IS the cart mutation's key, and that
		// locator is how the sweep knows a hold was cart-originated at all.
		const key = idempotencyKey(`line-${suffix}`);
		const held = await s.inventory.reserve(toSku(sku), 2, key);
		if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
		expect(await s.inventory.getOnHand(toSku(sku))).toBe(8);
		const cartId = await s.cartStore.create(currency("USD"));
		await s.cartStore.upsertLine({
			cartId,
			sku,
			productId: null,
			qty: 2,
			reservationId: held.reservationId,
			expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
			key,
		});

		await tick();
		// The units are back on hand: the reclaim is the effect, not the count.
		expect(await s.inventory.getOnHand(toSku(sku))).toBe(10);

		await tick();
		expect(await s.inventory.getOnHand(toSku(sku))).toBe(10);
	}, 180_000);

	test("expire-orders expires a past-hold pending order exactly once", async () => {
		const suffix = "orders";
		const past = new Date(Date.now() - HOUR_MS);
		const placed = await placeOrder(suffix, {
			at: past,
			holdExpiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
		});

		await tick();
		const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
		const expired = await orders.get(placed.id);
		expect(expired?.state).toBe("expired");
		const firstUpdatedAt = expired?.updatedAt;

		await tick();
		const again = await orders.get(placed.id);
		// Two ticks, ONE transition: the guarded flip is won once and the second
		// tick finds nothing expirable, so the document is untouched.
		expect(again?.state).toBe("expired");
		expect(again?.updatedAt).toBe(firstUpdatedAt);
	}, 180_000);

	test("order-emails reports SKIPPED while no sender is wired, and drains the outbox once one is", async () => {
		// Since INC-C5 there IS an `EmailSender` over `ctx.http` — but this sandbox
		// bakes no `IN_PROCESS_EGRESS_URLS.emailApiUrl`, so `makeEmailSender`
		// fail-closes to `undefined` and the leg reports the same `skipped` for a
		// DIFFERENT reason than when this line was written: the deployment is
		// unconfigured, not the code unbuilt. A silent no-op would be
		// indistinguishable from an empty outbox, so the leg says so.
		// `in-process-egress.sandbox.test.ts` covers the CONFIGURED arm, where the
		// URL is baked into the scratch manifest and its host is in `allowedHosts`.
		expect(leg(await tick(), "order-emails")).toMatchObject({ count: 0, skipped: true });

		// And with one injected, over the SAME real store, the leg is a real drain.
		const sent: SendEmailInput[] = [];
		const emailSender: EmailSender = {
			async send(input) {
				sent.push(input);
			},
		};
		const suffix = "emails";
		const placed = await placeOrder(suffix, {
			at: new Date(Date.now() - HOUR_MS),
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		});
		// `markPaid` enqueues the outbox row the dispatcher drains.
		await stores().orderStore.markPaid(toOrderId(placed.id));

		const ctx = { http: { fetch: notReached }, kv: kvStub(), storage } as unknown as PluginContext;
		const first = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, { emailSender });
		expect(leg(first, "order-emails").skipped).toBeUndefined();
		expect(sent.length).toBeGreaterThanOrEqual(1);

		const drained = sent.length;
		await runCommerceSweeps(ctx, SWEEP_TASK_NAME, { emailSender });
		// The row was marked sent, so a second run re-sends nothing.
		expect(sent.length).toBe(drained);
	}, 180_000);

	test("prune-challenges removes an expired login challenge and leaves nothing to redo", async () => {
		const suffix = "chal";
		const past = new Date(Date.now() - HOUR_MS);
		const s = stores(past);
		const verifier = new EmdashCredentialVerifier({
			storage,
			customerStore: s.customerStore,
			idGen: uuidIdGen,
			clock: s.clock,
			ttlMs: 1_000,
		});
		const issued = await verifier.issueChallenge(toEmail(`${suffix}@example.test`));
		expect(issued.ok).toBe(true);

		const first = leg(await tick(), "prune-challenges");
		expect(first.count).toBeGreaterThanOrEqual(1);
		const second = leg(await tick(), "prune-challenges");
		expect(second.count).toBe(0);
	}, 180_000);
});

describe("the five new sweepers, each from an injected partial state", () => {
	test("sku-transfers finishes a carry stranded between the two inventory documents", async () => {
		const suffix = "xfer";
		const productId = `prod-${suffix}`;
		const fromSku = `CRON-${suffix}-OLD`;
		const toSkuName = `CRON-${suffix}-NEW`;
		const s = stores();
		await s.productCommerce.upsert(
			{
				productId: toProductId(productId),
				sku: toSku(toSkuName),
				price: money(cents(1999), currency("USD")),
				productKind: "physical",
			},
			idempotencyKey(`upsert-${suffix}`),
		);

		// THE INJECTED PARTIAL STATE: the source document zeroed and STAMPED with the
		// carry, the product row still recording the intent, and the target never
		// credited — exactly what a crash between the two halves of a rename leaves.
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const token = `xfer-token-${suffix}`;
		await inventory.put(fromSku, {
			sku: fromSku,
			onHand: 0,
			holds: {},
			transferOut: { token, toSku: toSkuName, qty: 7 },
		});
		const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
		const current = await products.getVersioned(productId);
		expect(current).not.toBeNull();
		await products.compareAndSet(productId, current!.revision, {
			...current!.value,
			pendingRenames: {
				[token]: { token, fromSku, toSku: toSkuName, commandKey: `cmd-${suffix}` },
			},
		});

		await tick();
		// The units arrived, and the stamp that was accounting for them is gone —
		// conserved at every seam, which is the invariant the carry exists to keep.
		expect(await s.inventory.getOnHand(toSku(toSkuName))).toBe(7);
		expect((await inventory.get(fromSku))?.transferOut).toBeUndefined();
		expect((await products.get(productId))?.pendingRenames).toBeUndefined();

		await tick();
		// Two ticks, ONE carry: the token guards both the credit and the clear.
		expect(await s.inventory.getOnHand(toSku(toSkuName))).toBe(7);
	}, 180_000);

	test("order-sku-index heals a missing derived pointer without touching a live one", async () => {
		const suffix = "index";
		const placed = await placeOrder(suffix, {
			at: new Date(Date.now() - 60_000),
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		});
		const pointers = collectionOf<OrderSkuIndexDoc>(storage, ORDER_SKU_INDEX_COLLECTION);
		const pointerId = orderSkuIndexId(placed.sku.toLowerCase(), placed.id);
		expect(await pointers.get(pointerId)).not.toBeNull();

		// THE INJECTED PARTIAL STATE: the order is truth and survives; its derived
		// pointer does not. The order is now invisible to a by-sku search and
		// perfectly valid everywhere else.
		expect(await pointers.delete(pointerId)).toBe(true);

		await tick();
		const healed = await pointers.get(pointerId);
		expect(healed).toMatchObject({ sku: placed.sku.toLowerCase(), orderId: placed.id });

		await tick();
		// Create-if-absent only: the second tick reads the pointer and writes nothing,
		// so the healed document is byte-identical.
		expect(await pointers.get(pointerId)).toEqual(healed);
	}, 180_000);

	test("hold-intents completes a half-done adoption from the order's OWN recorded intent", async () => {
		const suffix = "intent";
		const holdExpiresAt = new Date(Date.now() + DAY_MS).toISOString();
		const placed = await placeOrder(suffix, { at: new Date(Date.now() - 60_000), holdExpiresAt });
		const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);

		// THE INJECTED PARTIAL STATE: the order flip landed and recorded its
		// adoption intent, but the per-id writes the intent describes never all
		// finished — `completedAt` null, and `holdsPendingAt` in the past so the
		// declared index surfaces it.
		const before = await orders.getVersioned(placed.id);
		expect(before).not.toBeNull();
		const pendingSince = new Date(Date.now() - HOUR_MS).toISOString();
		await orders.compareAndSet(placed.id, before!.revision, {
			...before!.value,
			holdsPendingAt: pendingSince,
			holdsAdopted: {
				reservationIds: [placed.reservationId],
				holdExpiresAt,
				recordedAt: pendingSince,
				completedAt: null,
			},
		});

		const first = leg(await tick(), "hold-intents");
		expect(first.count).toBeGreaterThanOrEqual(1);
		// A real hold, really adopted: the intent is stamped done and the order owes
		// nothing, so the index stops surfacing it.
		const healed = await orders.get(placed.id);
		expect(healed?.holdsAdopted?.completedAt).not.toBeNull();
		expect(healed?.holdsPendingAt).toBeNull();
		// And nothing was reported lost — this order is still `pending`, which is the
		// state that owns an adoption intent, so a loss here would have been real.
		expect(first.anomalies).toBeUndefined();

		const second = leg(await tick(), "hold-intents");
		expect(second.count).toBe(0);
		expect(second.anomalies).toBeUndefined();
	}, 180_000);

	test("hold-intents RECORDS a genuinely lost reservation on the order, not just in the summary", async () => {
		const suffix = "lost";
		const holdExpiresAt = new Date(Date.now() + DAY_MS).toISOString();
		const placed = await placeOrder(suffix, { at: new Date(Date.now() - 60_000), holdExpiresAt });
		const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);

		// THE INJECTED PARTIAL STATE: an outstanding adoption intent naming a
		// reservation inventory has never heard of — the shape left when a hold was
		// swept away underneath an order that still claims it. The order stays
		// `pending`, which is the state that OWNS an adoption intent, so this loss is
		// real rather than a completer losing a race with a state change.
		const missing = `res-${suffix}-vanished`;
		const before = await orders.getVersioned(placed.id);
		expect(before).not.toBeNull();
		const pendingSince = new Date(Date.now() - HOUR_MS).toISOString();
		await orders.compareAndSet(placed.id, before!.revision, {
			...before!.value,
			holdsPendingAt: pendingSince,
			holdsAdopted: {
				reservationIds: [missing],
				holdExpiresAt,
				recordedAt: pendingSince,
				completedAt: null,
			},
		});

		const swept = leg(await tick(), "hold-intents");
		// It survived the hazard-2 re-read: the order is still `pending`, so the
		// `INTENT_OWNER_STATE` filter keeps this loss rather than discarding it as a
		// completer that read a stale document.
		expect(swept.anomalies ?? []).toContain(`${placed.id}:adopt:${missing}`);

		// AND IT IS DURABLE. The summary is the hook's return value and the host's
		// cron executor throws that away, so an anomaly that lived only there would be
		// a finding nobody could ever meet. ADR-0019 §7.13 says an anomaly must always
		// be RECORDABLE — so it is written onto the order itself.
		const flagged = await orders.get(placed.id);
		expect(flagged?.reconciliationFlag).toContain(missing);
		expect(flagged?.reconciliationFlag).toContain("pending");

		// A second tick finds the intent stamped and reports nothing further about it:
		// the anomaly is recorded once, not re-raised forever.
		const again = leg(await tick(), "hold-intents");
		expect(again.anomalies ?? []).not.toContain(`${placed.id}:adopt:${missing}`);
	}, 180_000);

	test("reporting-heal rebuilds a rollup several closed days back, not just yesterday", async () => {
		const suffix = "report";
		// THREE DAYS BACK, for two reasons, and both were defects in the first cut.
		//
		// (1) IT EXERCISES THE BACKFILL. A heal pinned to `now - 24h` reconciles one
		//     day and no other, so a day lost to a deploy outage or a paused cron is
		//     never healed by any later tick — the one gap the leg exists to close is
		//     the one it cannot close. Reaching a day that is NOT yesterday is the
		//     only assertion that tells those two implementations apart.
		//
		// (2) IT DE-FLAKES THE CASE. This used to assert that YESTERDAY's rollup was
		//     empty before the heal, while every other case in this file seeds orders
		//     at `Date.now() - 1h`. Run in the hour after UTC midnight, those orders
		//     land on yesterday, write their rollups live, and this case fails for a
		//     reason that has nothing to do with the sweep. A day three back is one
		//     no other case can reach, so the emptiness precondition is this case's
		//     own fact rather than a bet on the clock and the run order.
		//
		// THE INJECTED PARTIAL STATE itself: an order created on that day by a store
		// with NO rollup writer wired — the exact shape a crash between the order
		// write and its rollup delta leaves, and the reason the rollup is a separate
		// aggregate that must be swept rather than trusted.
		const when = new Date(Date.now() - 3 * DAY_MS);
		const day = when.toISOString().slice(0, 10);
		// Its hold deadline is still in the FUTURE, deliberately: an order the expiry
		// leg touches in this same tick would have its rollup written by that live
		// event, and the heal would then be measuring the event rather than itself.
		await placeOrder(suffix, {
			at: when,
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		});
		const daily = collectionOf<{ date: string; currency: string }>(
			storage,
			REPORTING_DAILY_COLLECTION,
		);
		const beforeHeal = await daily.query({ where: { date: day }, limit: 10 });
		expect(beforeHeal.items).toHaveLength(0);

		// DRIVEN WITH ITS OWN CURSOR, which is the other half of de-coupling this case
		// from the run order: the isolate's cursor is boot-scoped, so by the time this
		// test runs the shared tick has already walked the day watermark up to the
		// closed day and a further tick would never look three days back. A cursor
		// with no history is what a first run — or a run after an outage — actually
		// sees, and it is the state the backfill is for.
		const first = leg(await sweepInProcess({ cursors: freshCursors() }), "reporting-heal");
		expect(first.count).toBeGreaterThanOrEqual(1);
		const afterHeal = await daily.query({ where: { date: day }, limit: 10 });
		expect(afterHeal.items.length).toBeGreaterThanOrEqual(1);
		const healed = afterHeal.items;

		// The same span again, from a cursor that is equally naive: an already-exact
		// day is recomputed and NOT rewritten, which is what makes re-reconciling the
		// closed day on every tick affordable.
		await sweepInProcess({ cursors: freshCursors() });
		const settled = await daily.query({ where: { date: day }, limit: 10 });
		expect(settled.items).toEqual(healed);
	}, 180_000);

	test("coupon-orphans releases a claimed-but-unapplied redemption and frees the customer's slot", async () => {
		const suffix = "coupon";
		const couponId = `coupon-${suffix}`;
		const customer = toCustomerId(`cust-${suffix}`);
		const s = stores();
		await s.couponStore.create({
			id: couponId,
			code: `SWEEP${suffix.toUpperCase()}`,
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: null,
			currency: currency("USD"),
			minSubtotalCents: cents(0),
			startsAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
			expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
			maxUses: 10,
			maxUsesPerCustomer: 1,
		});

		// THE INJECTED PARTIAL STATE: a redemption claimed two hours ago against an
		// order that never became durable. The coupon now counts a use nobody holds
		// and the customer's single per-customer slot is spent on nothing.
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`order-${suffix}-never-written`),
			idempotencyKey: idempotencyKey(`redeem-${suffix}`),
			customerId: customer,
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		expect(claimed.ok).toBe(true);
		// The slot really is spent: a second key for the same customer is refused.
		const blocked = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`order-${suffix}-second`),
			idempotencyKey: idempotencyKey(`redeem-${suffix}-2`),
			customerId: customer,
			createdAt: new Date().toISOString(),
		});
		expect(blocked).toMatchObject({ ok: false, reason: "COUPON_MAX_PER_CUSTOMER" });

		await tick();
		// The orphan is gone from the reconciliation read…
		const remaining = await s.couponStore.listRedemptionsCreatedBefore(new Date().toISOString());
		expect(remaining.map((entry) => entry.couponId)).not.toContain(couponId);
		// …and the freed slot is usable again, which is the half an operator feels.
		const afterRelease = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`order-${suffix}-third`),
			idempotencyKey: idempotencyKey(`redeem-${suffix}-3`),
			customerId: customer,
			createdAt: new Date().toISOString(),
		});
		expect(afterRelease).toMatchObject({ ok: true });

		await tick();
		// Two ticks, ONE release: the fresh redemption above is inside the grace
		// window, so the sweep leaves it exactly where it is.
		const stillHeld = await s.couponStore.listRedemptionsCreatedBefore(
			new Date(Date.now() + HOUR_MS).toISOString(),
		);
		expect(stillHeld.filter((entry) => entry.couponId === couponId)).toHaveLength(1);
	}, 180_000);

	test("coupon-orphans leaves a stale redemption alone while its order exists", async () => {
		const suffix = "keep";
		const couponId = `coupon-${suffix}`;
		const customer = toCustomerId(`cust-${suffix}`);
		const s = stores();
		// A REAL ORDER, the whole point of the case. Orphaned means the order does not
		// exist and NOTHING else: that is the domain's own rule in
		// `reconcileCouponRedemptions`, and it is the scope the brief amendment
		// ratified. The first cut also released redemptions whose order was `expired`
		// or `cancelled` — the first redundant (`expireOrders` already calls
		// `releaseByOrder`), the second a silent policy reversal, since `cancelOrder`
		// deliberately releases no coupon. This case is what makes a return to either
		// arm fail.
		const placed = await placeOrder(suffix, {
			at: new Date(Date.now() - HOUR_MS),
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		});
		await s.couponStore.create({
			id: couponId,
			code: `SWEEP${suffix.toUpperCase()}`,
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: null,
			currency: currency("USD"),
			minSubtotalCents: cents(0),
			startsAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
			expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
			maxUses: 10,
			maxUsesPerCustomer: 1,
		});
		// Old enough to be well past the grace window — so the leg genuinely examines
		// it and then decides to leave it, rather than never reaching it.
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(placed.id),
			idempotencyKey: idempotencyKey(`redeem-${suffix}`),
			customerId: customer,
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		expect(claimed.ok).toBe(true);

		// A cursor with no history, so the window certainly covers this redemption
		// whatever the shared isolate's cursor has already walked past.
		await sweepInProcess({ cursors: freshCursors() });

		// Still held: the use is still counted and the slot is still spent, which is
		// correct — a real order consumed them.
		const held = await s.couponStore.listRedemptionsCreatedBefore(new Date().toISOString());
		expect(held.filter((entry) => entry.couponId === couponId)).toHaveLength(1);
		const blocked = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`order-${suffix}-second`),
			idempotencyKey: idempotencyKey(`redeem-${suffix}-2`),
			customerId: customer,
			createdAt: new Date().toISOString(),
		});
		expect(blocked).toMatchObject({ ok: false, reason: "COUPON_MAX_PER_CUSTOMER" });
	}, 180_000);
});

/** `ctx.http` is never reached by a sweep — every leg is storage-only — so the
 *  in-process case's context says so instead of offering a usable fetch. */
function notReached(): never {
	throw new Error("a sweep must not make an HTTP request");
}

/** The sweep read-only-ly, from outside the isolate: what `ctx.cron.list()` in
 *  there currently holds. The one thing that can observe a registration without
 *  performing one — every handler that could report the registry also re-affirms
 *  it, which would make the registration assertions vacuous. */
async function cronTasks(): Promise<Array<{ name: string; schedule: string }>> {
	const res = await sandbox.rawFetch("/cron/tasks");
	const body = (await res.json()) as { result: Array<{ name: string; schedule: string }> };
	return body.result;
}

/**
 * The same legs, driven in this process against the SAME real store.
 *
 * Used where a case needs to control the sweep's own bookkeeping — a cursor with
 * no history, an injected `EmailSender` — which the isolate's boot-scoped `ctx.kv`
 * makes impossible from outside. The code under test is identical; only who holds
 * the cursor differs.
 */
async function sweepInProcess(options: CommerceSweepOptions = {}): Promise<CommerceSweepSummary> {
	const ctx = { http: { fetch: notReached }, kv: kvStub(), storage } as unknown as PluginContext;
	return await runCommerceSweeps(ctx, SWEEP_TASK_NAME, options);
}

/** A cursor store with no history: what a first run, or a run after a cursor was
 *  lost, actually sees. Keeping it per-case is what de-couples a case from
 *  whatever the shared isolate's cursors have already walked past. */
function freshCursors(): SweepCursorStore {
	const store = new Map<string, string>();
	return {
		async read(name: string): Promise<string | null> {
			return store.get(name) ?? null;
		},
		async write(name: string, value: string): Promise<void> {
			store.set(name, value);
		},
	};
}

function kvStub() {
	const store = new Map<string, unknown>();
	return {
		async get<T>(key: string): Promise<T | null> {
			return store.has(key) ? (store.get(key) as T) : null;
		},
		async set(key: string, value: unknown): Promise<void> {
			store.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return store.delete(key);
		},
		async list(): Promise<Array<{ key: string; value: unknown }>> {
			return [...store].map(([key, value]) => ({ key, value }));
		},
	};
}
