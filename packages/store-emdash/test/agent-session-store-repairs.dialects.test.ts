/**
 * #712 review round 3: the adapter's own repairs, on every Node dialect.
 *  - A token pointer lives as long as its session: an order moves the session to
 *    its 30-day retention and the pointer follows, and the sweep never deletes a
 *    pointer its live session still answers for (re-read by version first).
 *  - An order's slot freeing and record retention survive a crash between the
 *    session write and that follow-up: the sweep finishes it.
 *  - Freeing a slot retries a version miss instead of leaking the slot.
 *  - An EXPIRED slot is deleted outright, whatever its session document says.
 */
import {
	AGENT_SESSION_RETENTION_MS,
	claimAgentHandoff,
	createAgentSession,
	currency,
	finalizeAgentHandoff,
	orderId,
	productId,
	recordAgentSessionOrder,
	sku,
	type AgentSessionDeps,
} from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import { expect, test } from "vitest";
import {
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSION_SLOTS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	EmdashAgentSessionStore,
	WebCryptoAgentSessionSecrets,
	type StorageAccess,
} from "../src/index.js";
import { AGENT_SESSION_LAYOUT } from "./agent-session-collections.js";
import { clearAgentSessionStorage } from "./agent-session-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `storage`, with `hook` run before every call on `collection` (it may throw). */
function hooked(
	storage: StorageAccess,
	collection: string,
	hook: (method: string, args: unknown[]) => Promise<void>,
): StorageAccess {
	const wrapped: StorageAccess = { ...storage };
	const target = storage[collection];
	if (target === undefined) throw new Error(`no collection ${collection}`);
	wrapped[collection] = new Proxy(target, {
		get(t, prop, receiver) {
			const value: unknown = Reflect.get(t, prop, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				await hook(String(prop), args);
				return (value as (...a: unknown[]) => unknown).apply(t, args);
			};
		},
	});
	return wrapped;
}

function depsOver(storage: StorageAccess, clock: FixedClock): AgentSessionDeps {
	return {
		store: new EmdashAgentSessionStore({ storage }),
		clock,
		secrets: new WebCryptoAgentSessionSecrets(new Uint8Array(32).fill(3)),
	};
}

describeEachDialect("EmdashAgentSessionStore repairs (#712 round 3)", (ctx) => {
	const bound = ctx.useStorage(AGENT_SESSION_LAYOUT);

	const deps = (clock: FixedClock, storage?: StorageAccess) =>
		depsOver(storage ?? bound.storage, clock);

	/** A created, claimed and finalized session (no order yet), with its token. */
	async function handedOff(clock: FixedClock, key: string) {
		await clearAgentSessionStorage(bound.storage);
		const d = deps(clock);
		const made = await createAgentSession(d, {
			networkKey: "net-repair",
			idempotencyKey: key,
			fingerprint: `fp-${key}`,
			content: {
				currency: currency("USD"),
				lines: [{ productId: productId("p-1"), sku: sku("SKU-1"), quantity: 1 }],
			},
		});
		if (!made.ok || made.handoffToken === undefined) throw new Error("create failed");
		const claimed = await claimAgentHandoff(d, {
			token: made.handoffToken,
			redeemer: "browser-1",
		});
		if (!claimed.ok || claimed.status !== "claimed") throw new Error("claim failed");
		const done = await finalizeAgentHandoff(d, {
			sessionId: claimed.session.id,
			claimId: claimed.claimId,
			cartId: "cart-shopper",
		});
		expect(done.ok).toBe(true);
		return { id: made.session.id, token: made.handoffToken };
	}

	test(`an order's session keeps its token pointer: at day 2 the link still answers HANDOFF_USED [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id, token } = await handedOff(clock, "keep-link");
		const ordered = await recordAgentSessionOrder(deps(clock), {
			sessionId: id,
			orderId: orderId("order-keep-link"),
		});
		expect(ordered.ok).toBe(true);
		const sessionPurge = new Date(T0.getTime() + AGENT_SESSION_RETENTION_MS).toISOString();
		const links = bound.collection<{ purgeAt: string }>(AGENT_SESSION_LINKS_COLLECTION);
		const pointers = await links.query({ limit: 10 });
		expect(pointers.items.map((p) => p.data.purgeAt)).toEqual([sessionPurge]);

		clock.advance(2 * DAY);
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		await store.purgeIdempotencyDue(clock.now().toISOString(), 10);
		const tokenHash = await deps(clock).secrets.hash(token);
		expect((await store.findByHandoffTokenHash(tokenHash))?.id).toBe(id);
		expect(await claimAgentHandoff(deps(clock), { token, redeemer: "browser-2" })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	test(`the sweep re-reads a due pointer and keeps it (raised) while its session still answers for it [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id, token } = await handedOff(clock, "stale-link");
		const tokenHash = await deps(clock).secrets.hash(token);
		const links = bound.collection<{ purgeAt: string; sessionId: string; tokenHash: string }>(
			AGENT_SESSION_LINKS_COLLECTION,
		);
		// A pointer left with an older retention than its session's (written before
		// this fix): the session is retained for 30 days.
		const sessions = bound.collection<{ purgeAt: string }>(AGENT_SESSIONS_COLLECTION);
		const doc = await sessions.get(id);
		if (doc === null) throw new Error("no session");
		const later = new Date(T0.getTime() + 10 * DAY).toISOString();
		await sessions.put(id, { ...doc, purgeAt: later });
		await links.put(tokenHash, { tokenHash, sessionId: id, purgeAt: T0.toISOString() });

		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		await store.purgeIdempotencyDue(new Date(T0.getTime() + 2 * DAY).toISOString(), 10);
		expect((await links.get(tokenHash))?.purgeAt).toBe(later);
		expect((await store.findByHandoffTokenHash(tokenHash))?.id).toBe(id);
	});

	test(`an order write that crashes before freeing its slots is finished by the sweep [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id } = await handedOff(clock, "crash-settle");
		let crash = true;
		const crashing = hooked(bound.storage, AGENT_SESSION_SLOTS_COLLECTION, async (method) => {
			if (crash && method === "compareAndDelete") {
				crash = false;
				throw new Error("injected crash after the order write");
			}
		});
		await expect(
			recordAgentSessionOrder(deps(clock, crashing), {
				sessionId: id,
				orderId: orderId("order-crash"),
			}),
		).rejects.toThrow("injected crash");
		const slots = bound.collection<unknown>(AGENT_SESSION_SLOTS_COLLECTION);
		expect(await slots.count()).toBe(2);

		clock.advance(HOUR);
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		await store.purgeSlotsDue(clock.now().toISOString(), 5);
		expect(await slots.count()).toBe(0);
		const records = bound.collection<{ purgeAt: string }>(AGENT_SESSION_CREATE_KEYS_COLLECTION);
		const purgeAts = (await records.query({ limit: 10 })).items.map((r) => r.data.purgeAt);
		expect(purgeAts).toEqual([new Date(T0.getTime() + AGENT_SESSION_RETENTION_MS).toISOString()]);
	});

	test(`freeing a slot retries a version miss instead of leaking it [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id } = await handedOff(clock, "free-retry");
		let bumped = false;
		const racing = hooked(bound.storage, AGENT_SESSION_SLOTS_COLLECTION, async (method, args) => {
			if (bumped || method !== "compareAndDelete") return;
			bumped = true;
			// A concurrent writer re-stores the slot between the read and the delete.
			const slots = bound.collection<Record<string, unknown>>(AGENT_SESSION_SLOTS_COLLECTION);
			const slotId = String(args[0]);
			const slot = await slots.get(slotId);
			if (slot !== null) await slots.put(slotId, { ...slot });
		});
		const ordered = await recordAgentSessionOrder(deps(clock, racing), {
			sessionId: id,
			orderId: orderId("order-free-retry"),
		});
		expect(ordered.ok).toBe(true);
		expect(bumped).toBe(true);
		expect(await bound.collection<unknown>(AGENT_SESSION_SLOTS_COLLECTION).count()).toBe(0);
	});

	test(`an expired slot is deleted even while its (hidden) session document exists [${ctx.dialect}]`, async () => {
		await clearAgentSessionStorage(bound.storage);
		const slots = bound.collection<Record<string, unknown>>(AGENT_SESSION_SLOTS_COLLECTION);
		const sessions = bound.collection<Record<string, unknown>>(AGENT_SESSIONS_COLLECTION);
		await sessions.put("cs_expired_hidden", {
			id: "cs_expired_hidden",
			admission: "hidden",
			slots: ["live:0"],
			purgeAt: "2026-03-05T00:00:00.000Z",
		});
		await slots.put("live:0", {
			pool: "live",
			sessionId: "cs_expired_hidden",
			expiresAt: "2026-03-01T00:00:00.000Z",
			claimedAt: "2026-02-28T00:00:00.000Z",
			state: "taken",
		});
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		expect(await store.purgeSlotsDue("2026-03-02T00:00:00.000Z", 5)).toBe(1);
		expect(await slots.count()).toBe(0);
	});

	test(`an order frees a slot that names its session though its list does not (a same-id race leftover) [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id } = await handedOff(clock, "unlisted-settle");
		const slots = bound.collection<Record<string, unknown>>(AGENT_SESSION_SLOTS_COLLECTION);
		await slots.put("live:7", {
			pool: "live",
			sessionId: id,
			expiresAt: new Date(T0.getTime() + DAY).toISOString(),
			claimedAt: T0.toISOString(),
			state: "landed",
		});
		expect(await slots.count()).toBe(3);
		const ordered = await recordAgentSessionOrder(deps(clock), {
			sessionId: id,
			orderId: orderId("order-unlisted"),
		});
		expect(ordered.ok).toBe(true);
		expect(await slots.count()).toBe(0);
	});

	test(`the sweep deletes a taken slot its (admitted) session does not list [${ctx.dialect}]`, async () => {
		const clock = new FixedClock(T0);
		const { id } = await handedOff(clock, "unlisted-sweep");
		const slots = bound.collection<Record<string, unknown>>(AGENT_SESSION_SLOTS_COLLECTION);
		await slots.put("live:8", {
			pool: "live",
			sessionId: id,
			expiresAt: new Date(T0.getTime() + DAY).toISOString(),
			claimedAt: T0.toISOString(),
			state: "taken",
		});
		clock.advance(HOUR);
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		expect(await store.purgeSlotsDue(clock.now().toISOString(), 5)).toBe(1);
		expect(await slots.get("live:8")).toBeNull();
		// The session's own (listed, landed) slots are untouched.
		expect(await slots.count()).toBe(2);
	});
});
