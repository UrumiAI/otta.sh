/**
 * Shared fixtures for the sweep's budget suites (`cron-sweep-ceiling`,
 * `cron-sweep-backlog`): a counting context over a real SQLite document store, and
 * builders for real work in each leg — written through the document store's own
 * adapters, so every leg meets the same documents it meets in production.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	type Clock,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	EmdashCartStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashReportingStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import type { SweepCursorStore } from "../src/cron/index.js";
import type { PluginContext } from "../src/types.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Every storage and kv call a tick makes, counted from OUTSIDE the sweep — the
 *  independent check on the sweep's own accounting. */
export interface CallCounter {
	calls: number;
}

/** The real store, counting every collection call — one D1 query each. */
export function countingStorage(base: StorageAccess, counter: CallCounter): StorageAccess {
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(base)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counter.calls++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}

/** A plugin context over `store`, with an in-memory kv whose calls also count. */
export function sweepContext(
	store: StorageAccess,
	counter?: CallCounter,
	seed: Record<string, unknown> = {},
): PluginContext {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const count = (): void => {
		if (counter !== undefined) counter.calls++;
	};
	return {
		http: {
			fetch() {
				throw new Error("a sweep must not make an HTTP request here");
			},
		},
		kv: {
			async get<T>(key: string): Promise<T | null> {
				count();
				return kv.has(key) ? (kv.get(key) as T) : null;
			},
			async set(key: string, value: unknown): Promise<void> {
				count();
				kv.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				count();
				return kv.delete(key);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				count();
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
		storage: counter === undefined ? store : countingStorage(store, counter),
	} as unknown as PluginContext;
}

export function memoryCursors(): SweepCursorStore {
	const store = new Map<string, string>();
	return {
		async read(name) {
			return store.get(name) ?? null;
		},
		async write(name, value) {
			store.set(name, value);
		},
	};
}

export function recordingSender(sent: SendEmailInput[]): EmailSender {
	return {
		async send(input) {
			sent.push(input);
		},
	};
}

/** The document-store adapters over `storage`, on `at` (default: real time), with
 *  the live reporting rollup wired as production wires it. */
export function adapters(storage: StorageAccess, at?: Date) {
	const clock: Clock = at === undefined ? systemClock : new FixedClock(at);
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock });
	const reporting = new EmdashReportingStore({ storage, clock });
	return {
		clock,
		inventory,
		reporting,
		cartStore: new EmdashCartStore({ storage, inventory, idGen: uuidIdGen, clock }),
		orderStore: new EmdashOrderStore({
			storage,
			inventory,
			idGen: uuidIdGen,
			clock,
			reporting,
		}),
	};
}

/** `n` real cart holds of one unit each on one sku seeded with exactly `n`, all
 *  lapsed by `now`. */
export async function seedLapsedHolds(
	storage: StorageAccess,
	tag: string,
	n: number,
	now: Date,
): Promise<string> {
	const s = adapters(storage, new Date(now.getTime() - HOUR_MS));
	const sku = `HOLD-${tag}`;
	await s.inventory.seedOnHand(toSku(sku), n);
	for (let i = 0; i < n; i++) {
		const key = idempotencyKey(`line-${tag}-${String(i)}`);
		const held = await s.inventory.reserve(toSku(sku), 1, key);
		if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
		const cartId = await s.cartStore.create(currency("USD"));
		await s.cartStore.upsertLine({
			cartId,
			sku,
			productId: null,
			qty: 1,
			reservationId: held.reservationId,
			expiresAt: new Date(now.getTime() - 30 * MINUTE_MS).toISOString(),
			key,
		});
	}
	return sku;
}

/** A physical order over one real adopted reservation, created at `createdAt`. */
export async function placeOrder(
	storage: StorageAccess,
	tag: string,
	holdExpiresAt: Date,
	createdAt: Date,
): Promise<{ id: string; sku: string }> {
	const s = adapters(storage, createdAt);
	const sku = `ORDER-${tag}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${tag}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	await s.inventory.stampHoldDeadline(
		held.reservationId,
		new Date(holdExpiresAt.getTime() + DAY_MS).toISOString(),
	);
	const id = `order-${tag}`;
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt: holdExpiresAt.toISOString(),
		now: createdAt.toISOString(),
	});
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-${tag}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${tag}`),
		holdExpiresAt: holdExpiresAt.toISOString(),
		buyerRef: `buyer-${tag}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${tag}`),
				sku: toSku(sku),
				title: "Budget Widget",
				unitPrice: cents(1000),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: currency("USD") },
	});
	return { id, sku };
}

/** A pending order whose hold lapsed 30 minutes before `now`, created an hour
 *  before it plus `offsetMs` (so a batch of them do not share one instant). */
export async function placeLapsedOrder(
	storage: StorageAccess,
	tag: string,
	now: Date,
	offsetMs = 0,
): Promise<{ id: string; sku: string }> {
	return await placeOrder(
		storage,
		tag,
		new Date(now.getTime() - 30 * MINUTE_MS),
		new Date(now.getTime() - HOUR_MS + offsetMs),
	);
}

/** A PAID order whose stock commit is still owed: `markPaid` records the commit
 *  intent and enqueues the confirmation email, and nothing commits the hold — the
 *  crash window `hold-intents` completes (and the outbox has a row to send). */
export async function placePaidOrderOwingCommit(
	storage: StorageAccess,
	tag: string,
	now: Date,
	offsetMs = 0,
): Promise<{ id: string; sku: string }> {
	const placed = await placeOrder(
		storage,
		tag,
		new Date(now.getTime() + DAY_MS),
		new Date(now.getTime() - HOUR_MS + offsetMs),
	);
	await adapters(storage, new Date(now.getTime() - HOUR_MS)).orderStore.markPaid(
		toOrderId(placed.id),
	);
	return placed;
}
