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
import { runCommerceSweeps, SWEEP_LEGS, SWEEP_TASK_NAME } from "../src/cron/index.js";
import type { CommerceSweepSummary, SweepLeg, SweepLegOutcome } from "../src/cron/index.js";
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
		allowedHosts: ["commerce.otta.internal"],
		commerceServiceBaseUrl: "https://commerce.otta.internal",
		storage: true,
	});
}, 180_000);

afterAll(async () => {
	await sandbox?.close();
});

describe("the cron hook", () => {
	test("registers its task on plugin:activate, and again on every tick", async () => {
		const activated = await sandbox.invokeHook("plugin:activate", {});
		if ("error" in activated) throw new Error(activated.error);
		// The host's `schedule` is an upsert on the task name, which is what makes
		// re-affirming it free — and what makes a schedule change land on the next
		// tick rather than on the next activation.
		expect(activated.result).toEqual({
			scheduled: true,
			task: SWEEP_TASK_NAME,
			schedule: "*/15 * * * *",
		});
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
		// In the isolate there is no `EmailSender` yet — INC-C5 builds one over
		// `ctx.http`, and it depends on this increment. A silent no-op would be
		// indistinguishable from an empty outbox, so the leg says so.
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

	test("reporting-heal rebuilds a closed day's rollup that was never written", async () => {
		const suffix = "report";
		// THE INJECTED PARTIAL STATE: an order created YESTERDAY by a store with NO
		// rollup writer wired — the exact shape a crash between the order write and
		// its rollup leaves, and the reason the rollup is a different aggregate that
		// must be swept rather than trusted.
		const yesterday = new Date(Date.now() - DAY_MS);
		const day = yesterday.toISOString().slice(0, 10);
		// Its hold deadline is still in the FUTURE, deliberately: an order the expiry
		// leg touches in this same tick would have its rollup written by that live
		// event, and the heal would then be measuring the event rather than itself.
		await placeOrder(suffix, {
			at: yesterday,
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
		});
		const daily = collectionOf<{ date: string; currency: string }>(
			storage,
			REPORTING_DAILY_COLLECTION,
		);
		const beforeHeal = await daily.query({ where: { date: day }, limit: 10 });
		expect(beforeHeal.items).toHaveLength(0);

		const first = leg(await tick(), "reporting-heal");
		expect(first.count).toBeGreaterThanOrEqual(1);
		const afterHeal = await daily.query({ where: { date: day }, limit: 10 });
		expect(afterHeal.items.length).toBeGreaterThanOrEqual(1);

		const second = leg(await tick(), "reporting-heal");
		// An already-exact day is not rewritten, which is what makes reconciling the
		// closed day every tick affordable.
		expect(second.count).toBe(0);
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
});

/** `ctx.http` is never reached by a sweep — every leg is storage-only — so the
 *  in-process case's context says so instead of offering a usable fetch. */
function notReached(): never {
	throw new Error("a sweep must not make an HTTP request");
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
