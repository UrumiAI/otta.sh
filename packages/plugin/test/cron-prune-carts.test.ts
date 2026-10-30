/**
 * Issue #39: the `prune-carts` leg deletes abandoned, empty, anonymous carts, and
 * each one's `cart_create_keys` record with it.
 *
 * A cart is minted on a shopper's first add and nothing ever removed one: the hold
 * sweep reaps a lapsed line, the cart stays, empty, for good. Every case builds its
 * carts through the real document-store adapters on a clock in the past, then runs
 * real ticks over SQLite.
 */
import {
	addLine,
	currency,
	idempotencyKey,
	NOOP_LOGGER,
	orderId as toOrderId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import {
	CART_CREATE_KEYS_COLLECTION,
	CARTS_COLLECTION,
	collectionOf,
	ORDER_KEYS_COLLECTION,
	type CartCreateKeyDoc,
	type CartDoc,
	newCartDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME } from "../src/cron/index.js";
import {
	ABANDONED_CART_PASS_INTERVAL_MS,
	ABANDONED_CART_TTL_MS,
	ABANDONED_CARTS_PER_DAY_FREE,
	ABANDONED_CARTS_PER_RUN,
	abandonedCartsDailyCap,
	LEG_PRIORITY,
	LEG_QUERY_COSTS,
	MAINTENANCE_LEGS,
	pruneAbandonedCart,
	STARVING_TICKS,
	starvingLeg,
	tickOrder,
	UNPROMOTED_LEGS,
	type CommerceSweepSummary,
} from "../src/cron/sweeps.js";
import { CART_COOKIE_MAX_AGE_SECONDS } from "../src/storefront/cart-routes.js";
import {
	adapters,
	type CallCounter,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
/** Comfortably past the abandonment window. */
const OLD = new Date(NOW.getTime() - ABANDONED_CART_TTL_MS - DAY_MS);
const USD = currency("USD");

let storage: StorageAccess;

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
}, 120_000);

/** Cursors with every OTHER slow-cadence leg just run, so `prune-carts` is the
 *  tick's only scan. */
async function onlyPruneCartsDue(): Promise<ReturnType<typeof memoryCursors>> {
	const cursors = memoryCursors();
	await cursors.write(
		"state",
		JSON.stringify({
			lastRun: Object.fromEntries(
				MAINTENANCE_LEGS.filter((leg) => leg !== "prune-carts").map((leg) => [
					leg,
					NOW.toISOString(),
				]),
			),
		}),
	);
	return cursors;
}

/** Stamps every OTHER slow-cadence leg as just run at `at`, keeping the rest of the
 *  tick state (prune-carts' own stamp included). */
async function othersRunAt(cursors: ReturnType<typeof memoryCursors>, at: Date): Promise<void> {
	const state = JSON.parse((await cursors.read("state")) ?? "{}") as {
		lastRun?: Record<string, string>;
	};
	for (const leg of MAINTENANCE_LEGS) {
		if (leg !== "prune-carts") (state.lastRun ??= {})[leg] = at.toISOString();
	}
	await cursors.write("state", JSON.stringify(state));
}

async function tick(
	cursors: ReturnType<typeof memoryCursors>,
	options: { now?: Date; queryBudget?: number; counter?: CallCounter } = {},
): Promise<CommerceSweepSummary> {
	return await runCommerceSweeps(sweepContext(storage, options.counter), SWEEP_TASK_NAME, {
		cursors,
		emailSender: recordingSender([]),
		now: options.now ?? NOW,
		queryBudget: options.queryBudget ?? 600,
	});
}

function pruneLeg(summary: CommerceSweepSummary) {
	const leg = summary.legs.find((entry) => entry.leg === "prune-carts");
	if (leg === undefined) throw new Error("the prune-carts leg must be in the summary");
	return leg;
}

const carts = (): ReturnType<typeof collectionOf<CartDoc>> =>
	collectionOf<CartDoc>(storage, CARTS_COLLECTION);
const createKeys = (): ReturnType<typeof collectionOf<CartCreateKeyDoc>> =>
	collectionOf<CartCreateKeyDoc>(storage, CART_CREATE_KEYS_COLLECTION);

/** An empty cart minted (and last touched) at `at`, keyed when `key` is given. */
async function emptyCart(at: Date, key?: string): Promise<string> {
	const s = adapters(storage, at);
	return await s.cartStore.create(USD, key === undefined ? undefined : idempotencyKey(key));
}

describe("prune-carts (#39)", () => {
	test("the window is at least the cart cookie's lifetime, so a pruned cart has no live cookie", () => {
		expect(ABANDONED_CART_TTL_MS).toBeGreaterThanOrEqual(CART_COOKIE_MAX_AGE_SECONDS * 1000);
		expect(MAINTENANCE_LEGS).toContain("prune-carts");
	});

	test("never promoted: however long it waits, prune-carts keeps its place right after product-orphans and is never starving", () => {
		const waits = { "prune-carts": STARVING_TICKS * 10 };
		const order = tickOrder(waits);
		expect(order[order.indexOf("product-orphans") + 1]).toBe("prune-carts");
		expect(order.indexOf("prune-carts")).toBe(LEG_PRIORITY.indexOf("prune-carts"));
		expect(starvingLeg(waits)).toBeUndefined();
		expect(UNPROMOTED_LEGS).toContain("prune-carts");
	});

	test("an empty cart untouched past the window is deleted, with its create-key record", async () => {
		const unkeyed = await emptyCart(OLD);
		const keyed = await emptyCart(OLD, "create:press-1");
		expect(await createKeys().get("create:press-1")).toEqual({ cartId: keyed });

		const summary = await tick(await onlyPruneCartsDue());

		expect(pruneLeg(summary)).toMatchObject({ ok: true, count: 2 });
		expect(await carts().get(unkeyed)).toBeNull();
		expect(await carts().get(keyed)).toBeNull();
		expect(await createKeys().get("create:press-1")).toBeNull();
		// A late replay of the key mints a NEW cart, never the pruned id back.
		const replayed = await emptyCart(NOW, "create:press-1");
		expect(replayed).not.toBe(keyed);
	});

	test("a rotation's replacement cart takes its rotate: key record with it", async () => {
		const replacement = await emptyCart(OLD, "rotate:spent-cart");
		await tick(await onlyPruneCartsDue());
		expect(await carts().get(replacement)).toBeNull();
		expect(await createKeys().get("rotate:spent-cart")).toBeNull();
	});

	test("skips a cart with a line, a recent cart, a checked-out cart, an outstanding claim, and one an order was placed from", async () => {
		const s = adapters(storage, OLD);
		// A line (digital: no hold, so no sweep ever reaps it).
		const withLine = await s.cartStore.create(USD);
		await s.cartStore.upsertLine({
			cartId: withLine,
			sku: "DIGI-1",
			productId: null,
			qty: 1,
			reservationId: null,
			expiresAt: null,
			key: idempotencyKey("add-digi"),
		});
		// Touched inside the window (29 days ago).
		const recent = await emptyCart(new Date(NOW.getTime() - ABANDONED_CART_TTL_MS + DAY_MS));
		// Handed off to an order.
		const checkedOut = await s.cartStore.create(USD);
		await s.cartStore.checkout(checkedOut, toOrderId("order-handed-off"));
		// An add claimed and never finished: a crash marker the hold sweep owns.
		const claimed = await s.cartStore.create(USD);
		await s.cartStore.claimMutation({
			key: idempotencyKey("add-crashed"),
			cartId: claimed,
			kind: "add",
		});
		// Empty and active, but a checkout key names it: an order exists for it.
		const ordered = await s.cartStore.create(USD);
		await collectionOf(storage, ORDER_KEYS_COLLECTION).put(`checkout:${ordered}`, {
			state: "terminal",
			orderId: "order-from-ordered",
			recordedAt: OLD.toISOString(),
		});
		const pruned = await emptyCart(OLD);

		const summary = await tick(await onlyPruneCartsDue());

		expect(pruneLeg(summary)).toMatchObject({ ok: true, count: 1 });
		expect(await carts().get(pruned)).toBeNull();
		for (const kept of [withLine, recent, checkedOut, claimed, ordered]) {
			expect(await carts().get(kept), kept).not.toBeNull();
		}
	});

	test("a key record that now names another cart is left alone", async () => {
		const old = await emptyCart(OLD, "create:reused");
		// The record was re-claimed for a newer cart (a replay after an earlier prune
		// attempt deleted it and then lost the cart's compare-and-delete).
		await createKeys().put("create:reused", { cartId: "newer-cart" });
		await tick(await onlyPruneCartsDue());
		expect(await carts().get(old)).toBeNull();
		expect(await createKeys().get("create:reused")).toEqual({ cartId: "newer-cart" });
	});

	test("a cart whose own delete loses keeps the cart, its record gone; the next pass prunes it", async () => {
		const id = await emptyCart(OLD, "create:lost-delete");
		const cutoffMs = NOW.getTime() - ABANDONED_CART_TTL_MS;
		const real = carts();
		let losses = 0;
		// The cart's compare-and-delete loses once, as to a write landing between
		// the versioned read and the delete.
		const losing = {
			get: (key: string) => real.get(key),
			getVersioned: (key: string) => real.getVersioned(key),
			compareAndDelete: async (key: string, revision: string) => {
				if (losses === 0) {
					losses++;
					return { applied: false };
				}
				return await real.compareAndDelete(key, revision);
			},
		};
		const collections = {
			carts: losing,
			createKeys: createKeys(),
			orderKeys: collectionOf<unknown>(storage, ORDER_KEYS_COLLECTION),
		};

		expect(await pruneAbandonedCart(id, cutoffMs, collections)).toBe("kept");
		expect(await createKeys().get("create:lost-delete")).toBeNull();
		expect(await carts().get(id)).not.toBeNull();

		// The next pass: the cart still names its key, whose record is gone already.
		expect(await pruneAbandonedCart(id, cutoffMs, collections)).toBe("pruned");
		expect(await carts().get(id)).toBeNull();
		expect(losses).toBe(1);
	});

	test("a cart from before the field existed is pruned; its key record cannot be found", async () => {
		const legacy = await emptyCart(OLD, "create:legacy");
		const doc = await carts().get(legacy);
		if (doc === null) throw new Error("the cart must exist");
		const { createKey: _dropped, ...withoutKey } = doc;
		await carts().put(legacy, withoutKey);
		await tick(await onlyPruneCartsDue());
		expect(await carts().get(legacy)).toBeNull();
		// The residual #582 accepted: a late replay re-creates the id, empty.
		expect(await createKeys().get("create:legacy")).toEqual({ cartId: legacy });
	});

	test("idempotent: a second pass finds nothing, and a finished pass rests for its interval", async () => {
		await emptyCart(OLD);
		const cursors = await onlyPruneCartsDue();
		expect(pruneLeg(await tick(cursors)).count).toBe(1);
		// Due again a cadence later, but the pass is done: its cursor read and nothing
		// else (the suite's in-memory cursors are not storage, so no storage call).
		const later = new Date(NOW.getTime() + 20 * MINUTE_MS);
		const rested = pruneLeg(await tick(cursors, { now: later }));
		expect(rested.notDue).toBeUndefined();
		expect(rested).toMatchObject({ ok: true, count: 0 });
		expect(rested.queries).toBe(0);
		// A new abandoned cart waits for the next pass, which prunes it.
		await emptyCart(OLD);
		const next = new Date(NOW.getTime() + ABANDONED_CART_PASS_INTERVAL_MS + HOUR_MS);
		expect(pruneLeg(await tick(cursors, { now: next })).count).toBe(1);
	});

	test.each([
		["a live cart before the resume point checks out", "checkout-first"],
		["the resume point itself is deleted", "delete-anchor"],
	] as const)(
		"a run stopped by the per-run cap mid-page resumes with no cart passed over: %s",
		async (_name, between) => {
			// Five live carts, then 110 abandoned ones, all on one host page: ids and
			// insertion order agree, so the host's `(created_at, id)` order is this one.
			const live = Array.from({ length: 5 }, (_, i) => `cart-a-live-${String(i)}`);
			const old = Array.from({ length: 110 }, (_, i) => `cart-b-old-${String(i).padStart(3, "0")}`);
			for (const id of live) await carts().put(id, newCartDoc(id, USD, NOW.toISOString()));
			for (const id of old) await carts().put(id, newCartDoc(id, USD, OLD.toISOString()));
			const cursors = await onlyPruneCartsDue();

			const first = pruneLeg(await tick(cursors, { queryBudget: 5_000 }));
			// The per-run cap stopped it: no second run this tick, and it is stamped, so
			// the next tick finds it not due — it waits its cadence, not one minute.
			expect(first).toMatchObject({
				count: ABANDONED_CARTS_PER_RUN,
				incomplete: true,
				waitsCadence: true,
			});
			const next = new Date(NOW.getTime() + MINUTE_MS);
			expect(pruneLeg(await tick(cursors, { now: next, queryBudget: 5_000 })).notDue).toBe(true);
			const left = old.length - first.count;

			// Between ticks a row the old count-based resume had counted leaves the page.
			if (between === "checkout-first") {
				await adapters(storage, NOW).cartStore.checkout(live[0]!, toOrderId("order-live-0"));
			} else {
				await carts().delete(live.at(-1)!);
			}

			// The pass finishes a cadence or two on (it rests a day once it does), and
			// every abandoned cart is gone by then: none was passed over.
			let pruned = 0;
			for (let i = 1; i <= 5 && pruned < left; i++) {
				const at = new Date(NOW.getTime() + i * 16 * MINUTE_MS);
				pruned += pruneLeg(await tick(cursors, { now: at, queryBudget: 5_000 })).count;
			}
			expect(pruned).toBe(left);
			for (const id of old) expect(await carts().get(id), id).toBeNull();
			for (const id of live.slice(1, -1)) expect(await carts().get(id), id).not.toBeNull();
		},
	);

	test("on the Free preset a UTC day's deletes stop at its cap, and the capped leg waits its cadence", async () => {
		expect(abandonedCartsDailyCap(30)).toBe(ABANDONED_CARTS_PER_DAY_FREE);
		// A custom Free budget up to the platform's 50 keeps the cap (#658 review).
		expect(abandonedCartsDailyCap(50)).toBe(ABANDONED_CARTS_PER_DAY_FREE);
		expect(abandonedCartsDailyCap(51)).toBeNull();
		expect(abandonedCartsDailyCap(600)).toBeNull();
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) ids.push(await emptyCart(OLD));
		const cursors = await onlyPruneCartsDue();
		// Two short of today's cap already.
		const today = NOW.toISOString().slice(0, 10);
		await cursors.write(
			"prune-carts",
			JSON.stringify({ day: today, deletedToday: ABANDONED_CARTS_PER_DAY_FREE - 2 }),
		);

		let pruned = 0;
		let waited: number | undefined;
		for (let i = 0; i < 10 && waited === undefined; i++) {
			const at = new Date(NOW.getTime() + i * MINUTE_MS);
			const counter: CallCounter = { calls: 0 };
			const leg = pruneLeg(await tick(cursors, { now: at, queryBudget: 30, counter }));
			expect(counter.calls).toBeLessThanOrEqual(30);
			pruned += leg.count;
			if (leg.waitsCadence === true) waited = i;
		}
		expect(pruned).toBe(2);
		expect(waited).toBeDefined();
		// Stamped: the next minute it is not due.
		const after = new Date(NOW.getTime() + (waited! + 1) * MINUTE_MS);
		expect(pruneLeg(await tick(cursors, { now: after, queryBudget: 30 })).notDue).toBe(true);
		// A cadence later, still today: one kv read, nothing deleted, waiting again.
		const later = new Date(NOW.getTime() + (waited! + 16) * MINUTE_MS);
		await othersRunAt(cursors, later);
		expect(pruneLeg(await tick(cursors, { now: later, queryBudget: 30 }))).toMatchObject({
			count: 0,
			waitsCadence: true,
		});
		expect((await Promise.all(ids.map((id) => carts().get(id)))).filter(Boolean)).toHaveLength(2);
		// The next UTC day the rest go.
		let tomorrow = 0;
		for (let i = 0; i < 10 && tomorrow < 2; i++) {
			const at = new Date(NOW.getTime() + DAY_MS + i * MINUTE_MS);
			await othersRunAt(cursors, at);
			tomorrow += pruneLeg(await tick(cursors, { now: at, queryBudget: 30 })).count;
		}
		expect(tomorrow).toBe(2);
		for (const id of ids) expect(await carts().get(id)).toBeNull();
	});

	test("above the Free preset there is no daily cap", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) ids.push(await emptyCart(OLD));
		const cursors = await onlyPruneCartsDue();
		await cursors.write(
			"prune-carts",
			JSON.stringify({
				day: NOW.toISOString().slice(0, 10),
				deletedToday: ABANDONED_CARTS_PER_DAY_FREE * 10,
			}),
		);
		expect(pruneLeg(await tick(cursors, { queryBudget: 600 })).count).toBe(4);
		for (const id of ids) expect(await carts().get(id)).toBeNull();
	});

	test("a real add-line landing between the prune's read and its delete keeps the cart and its line", async () => {
		const s = adapters(storage, NOW);
		await s.inventory.seedOnHand(toSku("SKU-RACE"), 5);
		const id = await emptyCart(OLD, "create:race-add");
		const cutoffMs = NOW.getTime() - ABANDONED_CART_TTL_MS;
		const real = carts();
		let added = false;
		// Not a stub: the real collection throughout. The only seam is WHEN the shopper's
		// add runs — through the real use-case and store, right after the prune's read.
		const interleaved = {
			get: (key: string) => real.get(key),
			compareAndDelete: (key: string, revision: string) => real.compareAndDelete(key, revision),
			getVersioned: async (key: string) => {
				const read = await real.getVersioned(key);
				if (!added) {
					added = true;
					const add = await addLine(
						{
							cartStore: s.cartStore,
							inventoryStore: s.inventory,
							clock: s.clock,
							logger: NOOP_LOGGER,
						},
						id,
						toSku("SKU-RACE"),
						null,
						1,
						idempotencyKey("add-race"),
					);
					expect(add.ok).toBe(true);
				}
				return read;
			},
		};
		const outcome = await pruneAbandonedCart(id, cutoffMs, {
			carts: interleaved,
			createKeys: createKeys(),
			orderKeys: collectionOf<unknown>(storage, ORDER_KEYS_COLLECTION),
		});

		expect(outcome).toBe("kept");
		const cart = await s.cartStore.get(id);
		expect(cart?.lines.map((line) => [line.sku, line.qty])).toEqual([["SKU-RACE", 1]]);
		expect(cart?.lines[0]?.reservationState).toBe("held");
		// The cart has a line now: no later pass touches it.
		const summary = await tick(await onlyPruneCartsDue());
		expect(pruneLeg(summary).count).toBe(0);
		expect(await carts().get(id)).not.toBeNull();
	});

	test("an add-line after the prune finds no cart, and the shopper's next create mints a fresh one", async () => {
		const s = adapters(storage, NOW);
		await s.inventory.seedOnHand(toSku("SKU-LATE"), 5);
		const id = await emptyCart(OLD, "create:late-add");
		await tick(await onlyPruneCartsDue());
		expect(await carts().get(id)).toBeNull();
		const add = await addLine(
			{ cartStore: s.cartStore, inventoryStore: s.inventory, clock: s.clock, logger: NOOP_LOGGER },
			id,
			toSku("SKU-LATE"),
			null,
			1,
			idempotencyKey("add-late"),
		);
		expect(add.ok).toBe(false);
		expect(await emptyCart(NOW, "create:late-add")).not.toBe(id);
	});

	test("on the Workers Free preset a backlog drains over ticks, no tick passing its budget", async () => {
		const FREE = 30;
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) ids.push(await emptyCart(OLD, `create:backlog-${String(i)}`));
		// Live carts the walk must pass over without spending a unit on them.
		for (let i = 0; i < 5; i++) await emptyCart(NOW);
		const cursors = await onlyPruneCartsDue();
		let pruned = 0;
		let ticks = 0;
		for (; ticks < 40 && pruned < ids.length; ticks++) {
			const counter: CallCounter = { calls: 0 };
			const at = new Date(NOW.getTime() + ticks * MINUTE_MS);
			const summary = await tick(cursors, { now: at, queryBudget: FREE, counter });
			expect(counter.calls, `tick ${String(ticks)}`).toBeLessThanOrEqual(FREE);
			const leg = pruneLeg(summary);
			expect(leg.ok, leg.error).toBe(true);
			pruned += leg.count;
		}
		expect(pruned).toBe(ids.length);
		for (const id of ids) expect(await carts().get(id)).toBeNull();
		expect((await createKeys().query({ limit: 100 })).items).toEqual([]);
		// Bounded per tick: twelve carts did not go in one Free tick.
		expect(ticks).toBeGreaterThan(1);
		expect(LEG_QUERY_COSTS["prune-carts"].unit).toBeGreaterThan(0);
	});
});
