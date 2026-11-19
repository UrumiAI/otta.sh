import { describe, expect, test } from "vitest";
import {
	AGENT_SESSION_MAX_LINES,
	AGENT_SESSION_VIEW_KEYS,
	AGENT_SESSION_MAX_WRITE_RECORDS,
	AGENT_SESSION_MAX_WRITES,
	agentSessionId,
	cancelAgentSession,
	cents,
	completeAgentSession,
	createAgentSession,
	currency,
	getAgentSession,
	issueAgentHandoff,
	orderId,
	productId,
	recordAgentHandoffCart,
	recordAgentSessionOrder,
	redeemAgentHandoff,
	replaceAgentSession,
	sku,
	verifyAgentOrderSecret,
	type AgentCheckoutSession,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionId,
	type AgentSessionQuote,
	type AgentSessionStore,
} from "@urumi.ai/otta-domain";
import { FixedClock, InMemoryAgentSessionStore } from "@urumi.ai/otta-domain/testing";
import { FakeSecrets, TEST_SERVER_KEY } from "./fake-secrets.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = new Date("2026-11-18T10:00:00.000Z");
const USD = currency("USD");

function harness(limits?: AgentSessionDeps["limits"]) {
	const clock = new FixedClock(T0);
	const store = new InMemoryAgentSessionStore();
	const secrets = new FakeSecrets();
	const deps: AgentSessionDeps = { store, clock, secrets };
	if (limits !== undefined) deps.limits = limits;
	return { clock, store, secrets, deps };
}
type Harness = ReturnType<typeof harness>;

const mug = { productId: productId("p-mug"), sku: sku("MUG-1"), quantity: 2 };
const bowl = { productId: productId("p-bowl"), sku: sku("BOWL-1"), quantity: 1 };

function content(overrides: Partial<AgentSessionContent> = {}): AgentSessionContent {
	return { currency: USD, lines: [mug], ...overrides };
}

const CREATE = { idempotencyKey: "create-1", fingerprint: "fp-create-1", networkKey: "net-a" };

async function created(h: Harness, c: AgentSessionContent = content()) {
	const r = await createAgentSession(h.deps, { ...CREATE, content: c });
	if (!r.ok || r.replayed) throw new Error("create failed");
	return r;
}

/** A keyed request on `sessionId`; the fingerprint is derived from the key. */
function keyed(sessionId: AgentSessionId, key: string) {
	return { sessionId, idempotencyKey: key, fingerprint: `fp-${key}` };
}

async function stored(h: Harness, id: AgentSessionId): Promise<AgentCheckoutSession> {
	const s = await h.store.get(id);
	if (s === null) throw new Error("missing session");
	return s;
}

/** The store, except that the token lookup answers a copy read earlier (a racing reader). */
function staleLookup(store: AgentSessionStore, seen: AgentCheckoutSession): AgentSessionStore {
	return {
		get: (id) => store.get(id),
		write: (session, expected) => store.write(session, expected),
		findByHandoffTokenHash: async () => structuredClone(seen),
		findByCartId: (cartId) => store.findByCartId(cartId),
		getIdempotency: (networkKey, key) => store.getIdempotency(networkKey, key),
		putIdempotency: (record) => store.putIdempotency(record),
		extendIdempotencyPurge: (networkKey, key, purgeAt) =>
			store.extendIdempotencyPurge(networkKey, key, purgeAt),
		markHandoffUsed: (id, tokenHash, now) => store.markHandoffUsed(id, tokenHash, now),
		countLive: (now) => store.countLive(now),
		countCreatedSince: (networkKey, since) => store.countCreatedSince(networkKey, since),
		listPurgeDue: (now, limit) => store.listPurgeDue(now, limit),
		purge: (id, now) => store.purge(id, now),
		purgeIdempotencyDue: (now, limit) => store.purgeIdempotencyDue(now, limit),
	};
}

describe("createAgentSession", () => {
	test("mints a cs_ session: 24 h expiry, 30 d purge, channel other, hashes only", async () => {
		const h = harness();
		const r = await created(h);
		expect(r.session.status).toBe("requires_escalation");
		expect(Date.parse(r.session.expiresAt) - T0.getTime()).toBe(DAY_MS);
		expect(r.orderSecret).toBe(h.secrets.orderSecret(r.session.id));
		expect(r.handoffToken).toBe(h.secrets.token(r.session.id, 1));
		const s = await stored(h, r.session.id);
		expect(s.channel).toBe("other");
		expect(s.createdAt).toBe(T0.toISOString());
		expect(Date.parse(s.purgeAt) - T0.getTime()).toBe(30 * DAY_MS);
		expect(s.linkGeneration).toBe(1);
		expect(s.orderSecretHash).toBe(`h(${r.orderSecret})`);
		expect(s.handoffTokenHash).toBe(`h(${r.handoffToken})`);
		const doc = JSON.stringify(s);
		expect(doc).not.toContain(`"${r.orderSecret}"`);
		expect(doc).not.toContain(`"${r.handoffToken}"`);
	});

	test("the id suffix comes from the secrets port, not a counter", async () => {
		const h = harness();
		const r = await created(h);
		expect(h.secrets.minted).toHaveLength(1);
		expect(r.session.id).toBe(`cs_${h.secrets.minted[0]}`);
	});

	test("no lines → incomplete, with no hand-off link (generation 0)", async () => {
		const h = harness();
		const r = await created(h, content({ lines: [] }));
		expect(r.session.status).toBe("incomplete");
		expect(r.handoffToken).toBeUndefined();
		expect((await stored(h, r.session.id)).linkGeneration).toBe(0);
		expect((await stored(h, r.session.id)).handoffTokenHash).toBeUndefined();
	});

	test("an unquoted session has no quote; a full quote is kept verbatim", async () => {
		const h = harness();
		expect((await created(h)).session.quote).toBeUndefined();
		const quote: AgentSessionQuote = {
			currency: USD,
			subtotal: cents(3000),
			discount: cents(0),
			fulfillment: cents(500),
			tax: cents(200),
			total: cents(3700),
			quotedAt: T0.toISOString(),
		};
		const r = await createAgentSession(h.deps, {
			...CREATE,
			idempotencyKey: "create-q",
			content: content({ quote, cartId: "cart-1" }),
		});
		expect(r.ok && r.session.quote).toEqual(quote);
		expect(r.ok && r.session.cartId).toBe("cart-1");
	});

	test("a partial quote (unknown shipping or tax) must have a null total, never a zero-filled one", async () => {
		const h = harness();
		const partial: AgentSessionQuote = {
			currency: USD,
			subtotal: cents(3000),
			discount: cents(0),
			fulfillment: null,
			tax: null,
			total: null,
			quotedAt: T0.toISOString(),
		};
		const ok = await createAgentSession(h.deps, {
			...CREATE,
			idempotencyKey: "p-ok",
			content: content({ quote: partial }),
		});
		expect(ok.ok && ok.session.quote?.total).toBeNull();
		for (const [key, q] of [
			["p-both", { ...partial, total: cents(3000) }],
			["p-tax", { ...partial, fulfillment: cents(500), total: cents(3500) }],
			["p-ship", { ...partial, tax: cents(200), total: cents(3200) }],
		] as const) {
			expect(
				await createAgentSession(h.deps, {
					...CREATE,
					idempotencyKey: key,
					content: content({ quote: q }),
				}),
			).toEqual({ ok: false, reason: "QUOTE_PARTIAL_TOTAL" });
		}
	});

	test("a replay answers the created session with the same order_secret and the live link", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(1000);
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again).toEqual({
			ok: true,
			replayed: true,
			session: first.session,
			orderSecret: first.orderSecret,
			handoffToken: first.handoffToken,
		});
		expect(h.secrets.minted).toHaveLength(1);
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
		const verified = await verifyAgentOrderSecret(h.deps, {
			sessionId: first.session.id,
			secret: again.ok ? again.orderSecret : "",
		});
		expect(verified.ok).toBe(true);
	});

	test("a replay after later writes answers the session as created, with the current live link", async () => {
		const h = harness();
		const first = await created(h);
		await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-1"),
			content: content({ lines: [bowl] }),
		});
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again.ok && again.session).toEqual(first.session);
		expect(again.ok && again.session.lines).toEqual([mug]);
		expect(again.ok && again.handoffToken).toBe(first.handoffToken);
	});

	test("the same key from another network is a fresh create, never a replay", async () => {
		const h = harness();
		const first = await created(h);
		const other = await createAgentSession(h.deps, {
			...CREATE,
			networkKey: "net-b",
			content: content({ buyer: { email: "b@example.test" } }),
		});
		expect(other.ok && other.replayed).toBe(false);
		expect(other.ok && other.session.id).not.toBe(first.session.id);
		// A different body from another network is not a conflict either.
		const third = await createAgentSession(h.deps, {
			...CREATE,
			fingerprint: "fp-other",
			networkKey: "net-c",
			content: content({ lines: [bowl] }),
		});
		expect(third.ok && third.replayed).toBe(false);
		expect(third.ok && third.session.buyer).toBeUndefined();
	});

	test("same network, key and different fingerprint → IDEMPOTENCY_KEY_REUSED, nothing written", async () => {
		const h = harness();
		await created(h);
		const r = await createAgentSession(h.deps, {
			...CREATE,
			fingerprint: "fp-different",
			content: content({ lines: [bowl] }),
		});
		expect(r).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
	});

	test("a replay is answered even when today's limits would refuse its body", async () => {
		const h = harness();
		const first = await created(h);
		h.deps.limits = { maxLineQuantity: 1, maxLiveSessions: 0 };
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again.ok && again.replayed && again.session.id).toBe(first.session.id);
	});

	test("a create recorded but never written is finished by its replay, as the recorded network", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_crashed00000000000000");
		await h.store.putIdempotency({
			networkKey: "net-a",
			key: "k-crash",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
		});
		const r = await createAgentSession(h.deps, {
			idempotencyKey: "k-crash",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(r.ok && !r.replayed && r.session.id).toBe(sessionId);
		expect((await stored(h, sessionId)).networkKey).toBe("net-a");
	});

	test("finishing a crashed create late moves its record's purge out to the session's", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_crashed22222222222222");
		await h.store.putIdempotency({
			networkKey: "net-a",
			key: "k-late",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
		});
		h.clock.advance(2 * DAY_MS);
		const r = await createAgentSession(h.deps, {
			idempotencyKey: "k-late",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(r.ok && r.session.id).toBe(sessionId);
		const session = await stored(h, sessionId);
		expect(session.purgeAt).toBe(new Date(T0.getTime() + 32 * DAY_MS).toISOString());
		expect((await h.store.getIdempotency("net-a", "k-late"))?.purgeAt).toBe(session.purgeAt);
		// The sweep at the record's original purge time leaves it, so a retry still replays.
		await h.store.purgeIdempotencyDue(new Date(T0.getTime() + 30 * DAY_MS).toISOString(), 10);
		const retry = await createAgentSession(h.deps, {
			idempotencyKey: "k-late",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(retry.ok && retry.replayed && retry.session.id).toBe(sessionId);
	});

	test("finishing a crashed create re-checks the caps", async () => {
		const h = harness({ maxLiveSessions: 1 });
		await created(h);
		const sessionId = agentSessionId("cs_crashed11111111111111");
		await h.store.putIdempotency({
			networkKey: "net-a",
			key: "k-crash",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
		});
		expect(
			await createAgentSession(h.deps, {
				idempotencyKey: "k-crash",
				fingerprint: "fp",
				networkKey: "net-a",
				content: content(),
			}),
		).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(await h.store.get(sessionId)).toBeNull();
	});

	test("racing creates with one key make one session", async () => {
		const h = harness();
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				createAgentSession(h.deps, { ...CREATE, idempotencyKey: "k-race", content: content() }),
			),
		);
		const ids = new Set(results.map((r) => (r.ok ? r.session.id : r.reason)));
		expect(ids.size).toBe(1);
		expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
		const secrets = new Set(results.map((r) => (r.ok ? r.orderSecret : "")));
		expect(secrets.size).toBe(1);
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
	});

	test("refuses bad lines, a quote in another currency and a missing key", async () => {
		const h = harness();
		const base = { fingerprint: "fp", networkKey: "net-a" };
		const tooMany = Array.from({ length: AGENT_SESSION_MAX_LINES + 1 }, (_, i) => ({
			productId: productId(`p${i}`),
			sku: sku(`S${i}`),
			quantity: 1,
		}));
		expect(
			await createAgentSession(h.deps, {
				...base,
				idempotencyKey: "a",
				content: content({ lines: tooMany }),
			}),
		).toEqual({ ok: false, reason: "TOO_MANY_LINES" });
		for (const quantity of [0, -1, 1.5, 10_001]) {
			expect(
				await createAgentSession(h.deps, {
					...base,
					idempotencyKey: `q${quantity}`,
					content: content({ lines: [{ ...mug, quantity }] }),
				}),
			).toEqual({ ok: false, reason: "INVALID_QUANTITY" });
		}
		expect(
			await createAgentSession(h.deps, {
				...base,
				idempotencyKey: "d",
				content: content({ lines: [mug, mug] }),
			}),
		).toEqual({ ok: false, reason: "DUPLICATE_SKU" });
		const eurQuote: AgentSessionQuote = {
			currency: currency("EUR"),
			subtotal: cents(1),
			discount: cents(0),
			fulfillment: cents(0),
			tax: cents(0),
			total: cents(1),
			quotedAt: T0.toISOString(),
		};
		expect(
			await createAgentSession(h.deps, {
				...base,
				idempotencyKey: "e",
				content: content({ quote: eurQuote }),
			}),
		).toEqual({ ok: false, reason: "QUOTE_CURRENCY_MISMATCH" });
		expect(
			await createAgentSession(h.deps, { ...base, idempotencyKey: "", content: content() }),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_MISSING" });
		expect(await h.store.countLive(T0.toISOString())).toBe(0);
	});

	test("per-network create cap within the window, then it lapses", async () => {
		const h = harness({ maxCreatesPerNetwork: 2 });
		const make = (key: string, networkKey = "net-a") =>
			createAgentSession(h.deps, {
				idempotencyKey: key,
				fingerprint: key,
				networkKey,
				content: content(),
			});
		expect((await make("1")).ok).toBe(true);
		expect((await make("2")).ok).toBe(true);
		expect(await make("3")).toEqual({ ok: false, reason: "RATE_LIMITED" });
		expect((await make("4", "net-b")).ok).toBe(true);
		h.clock.advance(HOUR_MS + 1);
		expect((await make("5")).ok).toBe(true);
	});

	test("store-wide cap on live sessions; the default is the 5000 tuning knob", async () => {
		const h = harness({ maxLiveSessions: 1 });
		await created(h);
		const r = await createAgentSession(h.deps, {
			idempotencyKey: "other",
			fingerprint: "x",
			networkKey: "net-b",
			content: content(),
		});
		expect(r).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
	});
});

describe("replaceAgentSession", () => {
	test("full replacement: absent fields are cleared, status follows lines, the unused link survives", async () => {
		const h = harness();
		const first = await created(h, content({ couponCode: "SAVE", shippingMethodId: "std" }));
		const r = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-1"),
			content: content({ lines: [bowl] }),
		});
		expect(r.ok && !r.replayed).toBe(true);
		if (!r.ok) return;
		expect(r.session.lines).toEqual([bowl]);
		expect(r.session.couponCode).toBeUndefined();
		expect(r.session.shippingMethodId).toBeUndefined();
		expect(r.session.status).toBe("requires_escalation");
		expect((await stored(h, first.session.id)).linkGeneration).toBe(1);
		expect(r.handoffToken).toBe(first.handoffToken);
		const redeemed = await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" });
		expect(redeemed.ok && redeemed.session.lines).toEqual([bowl]);
	});

	test("emptying keeps the link: it refuses typed while empty and redeems once lines return", async () => {
		const h = harness();
		const first = await created(h);
		const emptied = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-empty"),
			content: content({ lines: [] }),
		});
		expect(emptied.ok && emptied.session.status).toBe("incomplete");
		expect(emptied.ok && emptied.handoffToken).toBeUndefined();
		const before = await stored(h, first.session.id);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_INCOMPLETE",
		});
		expect(await stored(h, first.session.id)).toEqual(before);
		const refilled = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-refill"),
			content: content({ lines: [bowl] }),
		});
		expect(refilled.ok && refilled.handoffToken).toBe(first.handoffToken);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
	});

	test("a replay answers that write's stored session and the live link; a reused key is refused", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		const applied = await replaceAgentSession(h.deps, put);
		// A later write changes the session; the replay must still answer put-1's state.
		await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-2"),
			content: content({ lines: [mug, bowl] }),
		});
		const replay = await replaceAgentSession(h.deps, put);
		expect(replay).toEqual({
			ok: true,
			replayed: true,
			session: applied.ok && applied.session,
			handoffToken: first.handoffToken,
		});
		expect(replay.ok && replay.session.lines).toEqual([bowl]);

		expect(await replaceAgentSession(h.deps, { ...put, fingerprint: "fp-other" })).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_REUSED",
		});
		expect(await cancelAgentSession(h.deps, keyed(first.session.id, "put-1"))).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_REUSED",
		});
		// The create's own key cannot be reused for an update either.
		expect(
			await replaceAgentSession(h.deps, {
				...put,
				idempotencyKey: CREATE.idempotencyKey,
				fingerprint: CREATE.fingerprint,
			}),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
	});

	test("session writes are keyed by the session alone: a retry from another network replays", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		// Even if the site passes its network key along, it plays no part in a session write.
		const fromA = { ...put, networkKey: "net-a" };
		const applied = await replaceAgentSession(h.deps, fromA);
		const fromB = { ...put, networkKey: "net-b" };
		const retried = await replaceAgentSession(h.deps, fromB);
		expect(retried).toEqual({ ...applied, replayed: true });
		const conflicting = { ...put, fingerprint: "fp-different", networkKey: "net-b" };
		expect(await replaceAgentSession(h.deps, conflicting)).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_REUSED",
		});
		expect((await stored(h, first.session.id)).writes).toHaveLength(2);
	});

	test("a replay is answered even when today's limits would refuse its body", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content() };
		expect((await replaceAgentSession(h.deps, put)).ok).toBe(true);
		h.deps.limits = { maxLineQuantity: 1 };
		const replay = await replaceAgentSession(h.deps, put);
		expect(replay.ok && replay.replayed).toBe(true);
	});

	test("refuses an unknown, expired or canceled session", async () => {
		const h = harness();
		const first = await created(h);
		const put = (key: string) =>
			replaceAgentSession(h.deps, { ...keyed(first.session.id, key), content: content() });
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(agentSessionId("cs_nope"), "k"),
				content: content(),
			}),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
		h.clock.advance(DAY_MS);
		expect(await put("late")).toEqual({ ok: false, reason: "SESSION_EXPIRED" });
		await cancelAgentSession(h.deps, keyed(first.session.id, "c"));
		expect(await put("after-cancel")).toEqual({ ok: false, reason: "SESSION_CLOSED" });
	});
});

describe("idempotency key lifetime", () => {
	test("a key evicted from the kept records is refused on a late replay, never re-applied", async () => {
		const h = harness();
		const first = await created(h);
		const early = { ...keyed(first.session.id, "put-early"), content: content({ lines: [bowl] }) };
		expect((await replaceAgentSession(h.deps, early)).ok).toBe(true);
		for (let i = 0; i < AGENT_SESSION_MAX_WRITE_RECORDS; i++) {
			const r = await replaceAgentSession(h.deps, {
				...keyed(first.session.id, `put-${i}`),
				content: content(),
			});
			expect(r.ok).toBe(true);
		}
		const s = await stored(h, first.session.id);
		expect(s.writes).toHaveLength(AGENT_SESSION_MAX_WRITE_RECORDS);
		expect(s.retiredWriteKeys).toContainEqual({ key: "put-early" });
		expect(await replaceAgentSession(h.deps, early)).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_EXPIRED",
		});
		expect((await stored(h, first.session.id)).lines).toEqual([mug]);
		// The create's key was evicted too: its replay is refused, not re-created.
		expect(await createAgentSession(h.deps, { ...CREATE, content: content() })).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_EXPIRED",
		});
	});

	test("a session that has taken its lifetime maximum of writes refuses new ones", async () => {
		const h = harness();
		const first = await created(h);
		const s = await stored(h, first.session.id);
		const fill = Array.from({ length: AGENT_SESSION_MAX_WRITES - s.writes.length }, (_, i) => ({
			key: `old-${i}`,
		}));
		const seeded = await h.store.write({ ...s, retiredWriteKeys: fill }, s.revision);
		expect(seeded.ok).toBe(true);
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "one-more"),
				content: content(),
			}),
		).toEqual({ ok: false, reason: "WRITE_LIMIT_REACHED" });
		expect(await issueAgentHandoff(h.deps, keyed(first.session.id, "issue"))).toEqual({
			ok: false,
			reason: "WRITE_LIMIT_REACHED",
		});
		// Cancel is exempt: a session at the cap can still be canceled and its link killed.
		const c = await cancelAgentSession(h.deps, keyed(first.session.id, "cancel"));
		expect(c.ok && c.session.status).toBe("canceled");
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_CANCELED",
		});
	});
});

describe("caller-supplied key lengths", () => {
	test("Idempotency-Key 1..255, network key and fingerprint at most 128, else INVALID_REQUEST", async () => {
		const h = harness();
		const make = (over: { idempotencyKey?: string; fingerprint?: string; networkKey?: string }) =>
			createAgentSession(h.deps, { ...CREATE, ...over, content: content() });
		expect((await make({ idempotencyKey: "k".repeat(255) })).ok).toBe(true);
		expect((await make({ idempotencyKey: "j", networkKey: "n".repeat(128) })).ok).toBe(true);
		expect((await make({ idempotencyKey: "i", fingerprint: "f".repeat(128) })).ok).toBe(true);
		const invalid = { ok: false, reason: "INVALID_REQUEST" };
		expect(await make({ idempotencyKey: "k".repeat(256) })).toEqual(invalid);
		expect(await make({ idempotencyKey: "x", networkKey: "n".repeat(129) })).toEqual(invalid);
		expect(await make({ idempotencyKey: "y", fingerprint: "f".repeat(129) })).toEqual(invalid);
		expect(await make({ idempotencyKey: "" })).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_MISSING",
		});

		const first = await created(h);
		const put = (over: { idempotencyKey?: string; fingerprint?: string }) =>
			replaceAgentSession(h.deps, {
				...keyed(first.session.id, "p"),
				...over,
				content: content(),
			});
		expect(await put({ idempotencyKey: "k".repeat(256) })).toEqual(invalid);
		expect(await put({ fingerprint: "f".repeat(129) })).toEqual(invalid);
		expect(await cancelAgentSession(h.deps, keyed(first.session.id, "c".repeat(256)))).toEqual(
			invalid,
		);
		expect((await stored(h, first.session.id)).writes).toHaveLength(1);
	});
});

describe("completeAgentSession", () => {
	test("never completes: answers requires_escalation with the same live link create gave", async () => {
		const h = harness();
		const first = await created(h);
		const r = await completeAgentSession(h.deps, keyed(first.session.id, "done-1"));
		expect(r.ok && !r.replayed).toBe(true);
		if (!r.ok) return;
		expect(r.session.status).toBe("requires_escalation");
		expect(r.handoffToken).toBe(first.handoffToken);
		const replay = await completeAgentSession(h.deps, keyed(first.session.id, "done-1"));
		expect(replay.ok && replay.replayed && replay.handoffToken).toBe(first.handoffToken);
		expect((await redeemAgentHandoff(h.deps, { token: r.handoffToken ?? "" })).ok).toBe(true);
	});

	test("a session with no lines is SESSION_INCOMPLETE", async () => {
		const h = harness();
		const first = await created(h, content({ lines: [] }));
		expect(await completeAgentSession(h.deps, keyed(first.session.id, "done"))).toEqual({
			ok: false,
			reason: "SESSION_INCOMPLETE",
		});
	});

	test("a completed session (an order was placed) refuses every write as SESSION_CLOSED", async () => {
		const h = harness();
		const first = await created(h);
		const s = await stored(h, first.session.id);
		const done = await h.store.write({ ...s, status: "completed" }, s.revision);
		expect(done.ok).toBe(true);
		const closed = { ok: false, reason: "SESSION_CLOSED" };
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "put"),
				content: content({ lines: [bowl] }),
			}),
		).toEqual(closed);
		expect(await completeAgentSession(h.deps, keyed(first.session.id, "done"))).toEqual(closed);
		expect(await issueAgentHandoff(h.deps, keyed(first.session.id, "issue"))).toEqual(closed);
		expect(await cancelAgentSession(h.deps, keyed(first.session.id, "cancel"))).toEqual(closed);
		const after = await stored(h, first.session.id);
		expect(after.revision).toBe(s.revision + 1);
		expect(after.linkGeneration).toBe(1);
	});
});

describe("issueAgentHandoff", () => {
	test("keyed: mints a new generation, a replay answers the same link, the old unused link dies", async () => {
		const h = harness();
		const first = await created(h);
		const issued = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(issued.ok && !issued.replayed).toBe(true);
		if (!issued.ok) return;
		expect(issued.handoffToken).toBe(h.secrets.token(first.session.id, 2));
		const replay = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(replay.ok && replay.replayed && replay.handoffToken).toBe(issued.handoffToken);
		expect((await stored(h, first.session.id)).linkGeneration).toBe(2);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_INVALID",
		});
		expect((await redeemAgentHandoff(h.deps, { token: issued.handoffToken ?? "" })).ok).toBe(true);
	});

	test("a replay after a later issue answers its own stored session with the CURRENT link", async () => {
		const h = harness();
		const first = await created(h);
		const one = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		const two = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-2"));
		expect(two.ok && two.handoffToken).toBe(h.secrets.token(first.session.id, 3));
		const replay = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(replay.ok && replay.replayed).toBe(true);
		if (!replay.ok || !one.ok) return;
		// The stored answer is issue-1's ...
		expect(replay.session).toEqual(one.session);
		// ... but the token is the live generation-3 link: the site builds continue_url from it.
		expect(replay.handoffToken).toBe(h.secrets.token(first.session.id, 3));
		expect(replay.handoffToken).not.toBe(one.handoffToken);
		expect(await redeemAgentHandoff(h.deps, { token: one.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_INVALID",
		});
		expect((await redeemAgentHandoff(h.deps, { token: replay.handoffToken ?? "" })).ok).toBe(true);
	});

	test("a retry of issue_handoff from another network replays: no new generation, the link lives", async () => {
		const h = harness();
		const first = await created(h);
		const fromA = { ...keyed(first.session.id, "issue-x"), networkKey: "net-a" };
		const issued = await issueAgentHandoff(h.deps, fromA);
		const fromB = { ...fromA, networkKey: "net-b" };
		const retried = await issueAgentHandoff(h.deps, fromB);
		expect(retried.ok && retried.replayed).toBe(true);
		expect(retried.ok && retried.handoffToken).toBe(issued.ok && issued.handoffToken);
		expect((await stored(h, first.session.id)).linkGeneration).toBe(2);
		expect(
			(await redeemAgentHandoff(h.deps, { token: issued.ok ? (issued.handoffToken ?? "") : "" }))
				.ok,
		).toBe(true);
	});

	test("refuses a missing key, an incomplete, expired or canceled session", async () => {
		const h = harness();
		const empty = await created(h, content({ lines: [] }));
		expect(await issueAgentHandoff(h.deps, keyed(empty.session.id, ""))).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_MISSING",
		});
		expect(await issueAgentHandoff(h.deps, keyed(empty.session.id, "i1"))).toEqual({
			ok: false,
			reason: "SESSION_INCOMPLETE",
		});
		h.clock.advance(DAY_MS);
		expect(await issueAgentHandoff(h.deps, keyed(empty.session.id, "i2"))).toEqual({
			ok: false,
			reason: "SESSION_EXPIRED",
		});
		await cancelAgentSession(h.deps, keyed(empty.session.id, "c"));
		expect(await issueAgentHandoff(h.deps, keyed(empty.session.id, "i3"))).toEqual({
			ok: false,
			reason: "SESSION_CLOSED",
		});
	});
});

describe("redeemAgentHandoff", () => {
	test("redeems once; the second redeem fails typed", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		h.clock.advance(5000);
		const r = await redeemAgentHandoff(h.deps, { token });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.session.lines).toEqual([mug]);
		expect(r.session.handedOff).toBe(true);
		expect((await stored(h, first.session.id)).handoffUsedAt).toBe(
			new Date(T0.getTime() + 5000).toISOString(),
		);
		expect(await redeemAgentHandoff(h.deps, { token })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	test("racing redeems: exactly one wins", async () => {
		const h = harness();
		const first = await created(h);
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" }),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("HANDOFF_USED");
	});

	test("a wrong or empty token fails typed and changes nothing", async () => {
		const h = harness();
		const first = await created(h);
		const before = await stored(h, first.session.id);
		for (const token of ["link:guess", ""]) {
			expect(await redeemAgentHandoff(h.deps, { token })).toEqual({
				ok: false,
				reason: "HANDOFF_INVALID",
			});
		}
		expect(await stored(h, first.session.id)).toEqual(before);
	});

	test("expires 24 h after create, failing typed without mutating; works 1 ms before", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(DAY_MS - 1);
		const before = await stored(h, first.session.id);
		h.clock.advance(1);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_EXPIRED",
		});
		expect(await stored(h, first.session.id)).toEqual(before);
		h.clock.advance(-1);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
	});

	test("cancel kills the link", async () => {
		const h = harness();
		const first = await created(h);
		const c = await cancelAgentSession(h.deps, keyed(first.session.id, "cancel-1"));
		expect(c.ok && c.session.status).toBe("canceled");
		expect(c.ok && c.handoffToken).toBeUndefined();
		const before = await stored(h, first.session.id);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_CANCELED",
		});
		expect(await stored(h, first.session.id)).toEqual(before);
	});

	test("a completed session answers HANDOFF_USED whether the pre-check or the atomic mark sees it", async () => {
		const h = harness();
		const first = await created(h);
		const s = await stored(h, first.session.id);
		const open = structuredClone(s);
		const done = await h.store.write({ ...s, status: "completed" }, s.revision);
		expect(done.ok).toBe(true);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		// A lookup that read the session before it completed: only the mark sees it.
		const stale = staleLookup(h.store, open);
		expect(
			await redeemAgentHandoff({ ...h.deps, store: stale }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_USED" });
	});

	test("a session emptied after the lookup is refused by the mark: HANDOFF_INCOMPLETE, link not burned", async () => {
		const h = harness();
		const first = await created(h);
		const withLines = await stored(h, first.session.id);
		await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-empty"),
			content: content({ lines: [] }),
		});
		const stale = staleLookup(h.store, withLines);
		expect(
			await redeemAgentHandoff({ ...h.deps, store: stale }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_INCOMPLETE" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
		await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-refill"),
			content: content({ lines: [bowl] }),
		});
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
	});

	test("a session that expired after the lookup is refused by the mark, typed as expired", async () => {
		const h = harness();
		const first = await created(h);
		const open = await stored(h, first.session.id);
		h.clock.advance(DAY_MS);
		const stale = staleLookup(h.store, { ...open, expiresAt: "9999-12-31T00:00:00.000Z" });
		expect(
			await redeemAgentHandoff({ ...h.deps, store: stale }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_EXPIRED" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
	});
});

describe("cancelAgentSession", () => {
	test("replays on its key; canceling again under a new key answers it and records only the key", async () => {
		const h = harness();
		const first = await created(h);
		const req = keyed(first.session.id, "c1");
		const a = await cancelAgentSession(h.deps, req);
		expect(a.ok && !a.replayed).toBe(true);
		expect(await cancelAgentSession(h.deps, req)).toEqual({
			ok: true,
			replayed: true,
			session: a.ok && a.session,
		});
		const before = await stored(h, first.session.id);
		h.clock.advance(1000);
		const again = keyed(first.session.id, "c2");
		const b = await cancelAgentSession(h.deps, again);
		expect(b).toEqual({ ok: true, replayed: false, session: a.ok && a.session });
		const after = await stored(h, first.session.id);
		const { writes: beforeWrites, revision: _rb, ...beforeState } = before;
		const { writes: afterWrites, revision: _ra, ...afterState } = after;
		expect(afterState).toEqual(beforeState);
		expect(afterWrites.slice(0, -1)).toEqual(beforeWrites);
		expect(afterWrites.at(-1)).toMatchObject({ key: "c2", operation: "cancel" });
		// The key is now taken: the same key with another body is refused.
		expect(await cancelAgentSession(h.deps, { ...again, fingerprint: "fp-other" })).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_REUSED",
		});
		expect(await cancelAgentSession(h.deps, again)).toEqual({ ...b, replayed: true });
	});

	test("re-canceling at the lifetime write cap answers without recording", async () => {
		const h = harness();
		const first = await created(h);
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "c1"))).ok).toBe(true);
		const s = await stored(h, first.session.id);
		const fill = Array.from({ length: AGENT_SESSION_MAX_WRITES - s.writes.length }, (_, i) => ({
			key: `old-${i}`,
		}));
		const seeded = await h.store.write({ ...s, retiredWriteKeys: fill }, s.revision);
		if (!seeded.ok) throw new Error("seed failed");
		const r = await cancelAgentSession(h.deps, keyed(first.session.id, "c2"));
		expect(r.ok && r.session.status).toBe("canceled");
		expect(await stored(h, first.session.id)).toEqual(seeded.session);
	});
});

describe("getAgentSession and verifyAgentOrderSecret", () => {
	test("get reads a session; an unknown id is SESSION_NOT_FOUND", async () => {
		const h = harness();
		const first = await created(h);
		expect((await getAgentSession(h.deps, { sessionId: first.session.id })).ok).toBe(true);
		expect(await getAgentSession(h.deps, { sessionId: agentSessionId("cs_unknown") })).toEqual({
			ok: false,
			reason: "SESSION_NOT_FOUND",
		});
	});

	test("accepts the secret returned at create; refuses wrong, empty and unknown alike", async () => {
		const h = harness();
		const first = await created(h);
		const ok = await verifyAgentOrderSecret(h.deps, {
			sessionId: first.session.id,
			secret: first.orderSecret,
		});
		expect(ok.ok && ok.session.id).toBe(first.session.id);
		const invalid = { ok: false, reason: "ORDER_SECRET_INVALID" };
		for (const [sessionId, secret] of [
			[first.session.id, "wrong"],
			[first.session.id, ""],
			[agentSessionId("cs_unknown"), first.orderSecret],
		] as const) {
			expect(await verifyAgentOrderSecret(h.deps, { sessionId, secret })).toEqual(invalid);
		}
	});
});

/** Swap the harness onto a different server key (a key rotation). */
function rotated(h: Harness): FakeSecrets {
	const secrets = new FakeSecrets(new Uint8Array(TEST_SERVER_KEY.length).fill(9));
	h.deps.secrets = secrets;
	return secrets;
}

describe("secrets re-derived for return are checked against their stored hashes", () => {
	test("after a key change, replays fail closed with SECRET_KEY_MISMATCH and write nothing", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		expect((await replaceAgentSession(h.deps, put)).ok).toBe(true);
		const before = await stored(h, first.session.id);
		rotated(h);
		const mismatch = { ok: false, reason: "SECRET_KEY_MISMATCH" };
		expect(await createAgentSession(h.deps, { ...CREATE, content: content() })).toEqual(mismatch);
		expect(await replaceAgentSession(h.deps, put)).toEqual(mismatch);
		expect(await stored(h, first.session.id)).toEqual(before);
		// What a holder already has still verifies: verification compares hashes.
		const verified = await verifyAgentOrderSecret(h.deps, {
			sessionId: first.session.id,
			secret: first.orderSecret,
		});
		expect(verified.ok).toBe(true);
	});

	test("after a key change, a fresh complete mints a new link under the new key that redeems", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		expect((await replaceAgentSession(h.deps, put)).ok).toBe(true);
		const secrets = rotated(h);
		// Before any fresh write, a replay still fails closed.
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: false,
			reason: "SECRET_KEY_MISMATCH",
		});
		const done = await completeAgentSession(h.deps, keyed(first.session.id, "done"));
		expect(done.ok && !done.replayed).toBe(true);
		expect(done.ok && done.handoffToken).toBe(secrets.token(first.session.id, 2));
		expect((await stored(h, first.session.id)).handoffTokenHash).toBe(
			`h(${secrets.token(first.session.id, 2)})`,
		);
		// The old link died with the new generation.
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_INVALID",
		});
		// The create replay still fails closed: the order_secret is never re-issued.
		expect(await createAgentSession(h.deps, { ...CREATE, content: content() })).toEqual({
			ok: false,
			reason: "SECRET_KEY_MISMATCH",
		});
		// A replay now answers the new live link.
		const replay = await completeAgentSession(h.deps, keyed(first.session.id, "done"));
		expect(replay.ok && replay.replayed && replay.handoffToken).toBe(
			secrets.token(first.session.id, 2),
		);
		expect(
			(await redeemAgentHandoff(h.deps, { token: done.ok ? (done.handoffToken ?? "") : "" })).ok,
		).toBe(true);
	});

	test("after a key change, a fresh replace mints a new link too", async () => {
		const h = harness();
		const first = await created(h);
		const secrets = rotated(h);
		const r = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-2"),
			content: content({ lines: [mug, bowl] }),
		});
		expect(r.ok && r.handoffToken).toBe(secrets.token(first.session.id, 2));
		expect(r.ok && r.session.lines).toEqual([mug, bowl]);
	});

	test("after a key change, issue_handoff mints a link under the new key that redeems", async () => {
		const h = harness();
		const first = await created(h);
		const secrets = rotated(h);
		const issued = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(issued.ok && issued.handoffToken).toBe(secrets.token(first.session.id, 2));
		const replay = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(replay.ok && replay.handoffToken).toBe(secrets.token(first.session.id, 2));
		expect(
			(await redeemAgentHandoff(h.deps, { token: issued.ok ? (issued.handoffToken ?? "") : "" }))
				.ok,
		).toBe(true);
	});

	test("a replay under the original key still answers the same secret and link", async () => {
		const h = harness();
		const first = await created(h);
		h.deps.secrets = new FakeSecrets(TEST_SERVER_KEY);
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again.ok && again.orderSecret).toBe(first.orderSecret);
		expect(again.ok && again.handoffToken).toBe(first.handoffToken);
	});
});

describe("the public view", () => {
	const ALL_KEYS = [...AGENT_SESSION_VIEW_KEYS].toSorted();
	const REQUIRED = ["currency", "expiresAt", "handedOff", "id", "lines", "status"];
	function expectView(session: object | false | undefined) {
		expect(session).toBeTruthy();
		if (!session) return;
		const keys = Object.keys(session);
		for (const k of keys) expect(ALL_KEYS).toContain(k);
		for (const k of REQUIRED) expect(keys).toContain(k);
	}

	test("the view's key set is exactly the allowlist", async () => {
		expect(ALL_KEYS).toEqual([
			"buyer",
			"cartId",
			"couponCode",
			"currency",
			"destination",
			"expiresAt",
			"handedOff",
			"id",
			"lines",
			"orderId",
			"quote",
			"shippingMethodId",
			"status",
		]);
		const h = harness();
		const first = await created(
			h,
			content({
				buyer: { email: "a@example.test" },
				destination: {
					name: "Ada",
					line1: "1 Main St",
					line2: null,
					city: "Austin",
					region: "TX",
					postalCode: "78701",
					country: "US",
					email: null,
					phone: null,
				},
				shippingMethodId: "std",
				couponCode: "SAVE",
				cartId: "cart-1",
				quote: {
					currency: USD,
					subtotal: cents(3000),
					discount: cents(0),
					fulfillment: null,
					tax: null,
					total: null,
					quotedAt: T0.toISOString(),
				},
			}),
		);
		const redeemed = await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" });
		const recorded = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		// A fully populated session: every allowlisted key, and nothing else.
		expect(recorded.ok && Object.keys(recorded.session).toSorted()).toEqual(ALL_KEYS);
		expect(redeemed.ok && Object.keys(redeemed.session).toSorted()).toEqual(
			ALL_KEYS.filter((k) => k !== "orderId"),
		);
	});

	test("every result and every stored answer carries the view, never the document", async () => {
		const h = harness();
		const first = await created(h, content({ buyer: { email: "a@example.test" } }));
		expectView(first.session);
		const put = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-1"),
			content: content({ lines: [bowl] }),
		});
		expectView(put.ok && put.session);
		const replay = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expectView(replay.ok && replay.session);
		const got = await getAgentSession(h.deps, { sessionId: first.session.id });
		expectView(got.ok && got.session);
		expect(got.ok && got.session.buyer).toBeUndefined();
		const verified = await verifyAgentOrderSecret(h.deps, {
			sessionId: first.session.id,
			secret: first.orderSecret,
		});
		expectView(verified.ok && verified.session);
		const issued = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expectView(issued.ok && issued.session);
		const redeemed = await redeemAgentHandoff(h.deps, {
			token: issued.ok ? (issued.handoffToken ?? "") : "",
		});
		expectView(redeemed.ok && redeemed.session);
		expect(redeemed.ok && redeemed.session.lines).toEqual([bowl]);
		const canceled = await cancelAgentSession(h.deps, keyed(first.session.id, "cancel-1"));
		expectView(canceled.ok && canceled.session);
		for (const w of (await stored(h, first.session.id)).writes) expectView(w.answer);
	});
});

describe("hand-off is terminal for the agent", () => {
	test("after a redeem, replace, complete and issue_handoff are SESSION_HANDED_OFF and write nothing", async () => {
		const h = harness();
		const first = await created(h);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		const before = await stored(h, first.session.id);
		const handedOff = { ok: false, reason: "SESSION_HANDED_OFF" };
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "put"),
				content: content({ lines: [bowl] }),
			}),
		).toEqual(handedOff);
		expect(await completeAgentSession(h.deps, keyed(first.session.id, "done"))).toEqual(handedOff);
		expect(await issueAgentHandoff(h.deps, keyed(first.session.id, "issue"))).toEqual(handedOff);
		expect(await stored(h, first.session.id)).toEqual(before);
		const got = await getAgentSession(h.deps, { sessionId: first.session.id });
		expect(got.ok && got.session.handedOff).toBe(true);
		expect(got.ok && got.handoffToken).toBeUndefined();
		// Cancel stays.
		const c = await cancelAgentSession(h.deps, keyed(first.session.id, "cancel"));
		expect(c.ok && c.session.status).toBe("canceled");
	});

	test("a replay of a write made before the hand-off is still answered, with no link", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		const applied = await replaceAgentSession(h.deps, put);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: true,
			replayed: true,
			session: applied.ok && applied.session,
		});
	});
});

describe("recordAgentSessionOrder", () => {
	async function redeemed(h: Harness) {
		const first = await created(h);
		h.clock.advance(1000);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		return first;
	}

	test("completes a redeemed session with the order (and cart); the same order again replays", async () => {
		const h = harness();
		const first = await redeemed(h);
		const r = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
			cartId: "cart-rebuilt",
		});
		expect(r.ok && !r.replayed).toBe(true);
		expect(r.ok && r.session.status).toBe("completed");
		expect(r.ok && r.session.orderId).toBe("ord-1");
		expect(r.ok && r.session.cartId).toBe("cart-rebuilt");
		const after = await stored(h, first.session.id);
		const again = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		expect(again).toEqual({ ok: true, replayed: true, session: r.ok && r.session });
		expect(await stored(h, first.session.id)).toEqual(after);
		// A completed session refuses every agent write.
		expect(await cancelAgentSession(h.deps, keyed(first.session.id, "c"))).toEqual({
			ok: false,
			reason: "SESSION_CLOSED",
		});
	});

	test("a different order is ORDER_ALREADY_RECORDED and changes nothing", async () => {
		const h = harness();
		const first = await redeemed(h);
		await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		const after = await stored(h, first.session.id);
		expect(
			await recordAgentSessionOrder(h.deps, {
				sessionId: first.session.id,
				orderId: orderId("ord-2"),
			}),
		).toEqual({ ok: false, reason: "ORDER_ALREADY_RECORDED" });
		expect(await stored(h, first.session.id)).toEqual(after);
	});

	test("refuses a never-redeemed, canceled or unknown session, and a bad cart id", async () => {
		const h = harness();
		const first = await created(h);
		const record = (sessionId: AgentSessionId, cartId?: string) =>
			recordAgentSessionOrder(h.deps, {
				sessionId,
				orderId: orderId("ord-1"),
				...(cartId === undefined ? {} : { cartId }),
			});
		expect(await record(first.session.id)).toEqual({
			ok: false,
			reason: "HANDOFF_NOT_REDEEMED",
		});
		expect(await record(agentSessionId("cs_nope"))).toEqual({
			ok: false,
			reason: "SESSION_NOT_FOUND",
		});
		expect(await record(first.session.id, "c".repeat(129))).toEqual({
			ok: false,
			reason: "INVALID_REQUEST",
		});
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		await cancelAgentSession(h.deps, keyed(first.session.id, "c"));
		expect(await record(first.session.id)).toEqual({ ok: false, reason: "SESSION_CLOSED" });
	});

	test("allowed past expiresAt: the shopper may pay after the agent's 24 h", async () => {
		const h = harness();
		const first = await redeemed(h);
		h.clock.advance(2 * DAY_MS);
		const r = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		expect(r.ok && r.session.status).toBe("completed");
	});

	test("compare-and-set: racing records of two orders, exactly one wins", async () => {
		const h = harness();
		const first = await redeemed(h);
		const results = await Promise.all(
			["ord-1", "ord-2", "ord-1", "ord-2"].map((o) =>
				recordAgentSessionOrder(h.deps, { sessionId: first.session.id, orderId: orderId(o) }),
			),
		);
		const won = (await stored(h, first.session.id)).orderId;
		for (const r of results) {
			if (r.ok) expect(r.session.orderId).toBe(won);
			else expect(r.reason).toBe("ORDER_ALREADY_RECORDED");
		}
		expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
	});

	test("a lost compare-and-set re-reads: a concurrent different order is refused, not overwritten", async () => {
		const h = harness();
		const first = await redeemed(h);
		const s = await stored(h, first.session.id);
		let raced = false;
		const racing: AgentSessionStore = {
			...staleLookup(h.store, s),
			write: async (session, expected) => {
				if (!raced) {
					raced = true;
					await h.store.write(
						{ ...s, status: "completed", orderId: orderId("ord-other") },
						s.revision,
					);
				}
				return h.store.write(session, expected);
			},
		};
		expect(
			await recordAgentSessionOrder(
				{ ...h.deps, store: racing },
				{ sessionId: first.session.id, orderId: orderId("ord-1") },
			),
		).toEqual({ ok: false, reason: "ORDER_ALREADY_RECORDED" });
		expect((await stored(h, first.session.id)).orderId).toBe("ord-other");
	});
});

describe("getAgentSession's live link", () => {
	test("returns the current link while unused, unexpired and re-derivable; else none", async () => {
		const h = harness();
		const first = await created(h);
		const got = await getAgentSession(h.deps, { sessionId: first.session.id });
		expect(got.ok && got.handoffToken).toBe(first.handoffToken);
		expect(got.ok && got.session.handedOff).toBe(false);
		// A rotated key: no token, never an error.
		const original = h.deps.secrets;
		rotated(h);
		const afterRotation = await getAgentSession(h.deps, { sessionId: first.session.id });
		expect(afterRotation.ok).toBe(true);
		expect(afterRotation.ok && afterRotation.handoffToken).toBeUndefined();
		h.deps.secrets = original;
		h.clock.advance(DAY_MS);
		const expired = await getAgentSession(h.deps, { sessionId: first.session.id });
		expect(expired.ok && expired.handoffToken).toBeUndefined();
	});

	test("no token for an empty or canceled session", async () => {
		const h = harness();
		const empty = await created(h, content({ lines: [] }));
		const got = await getAgentSession(h.deps, { sessionId: empty.session.id });
		expect(got.ok && got.handoffToken).toBeUndefined();
		const h2 = harness();
		const first = await created(h2);
		await cancelAgentSession(h2.deps, keyed(first.session.id, "c"));
		const canceled = await getAgentSession(h2.deps, { sessionId: first.session.id });
		expect(canceled.ok && canceled.handoffToken).toBeUndefined();
	});
});

describe("content and key caps", () => {
	test("content strings over their caps are INVALID_REQUEST; at the cap they pass", async () => {
		const h = harness();
		const address = {
			name: "Ada",
			line1: "1 Main St",
			line2: null,
			city: "Austin",
			region: "TX",
			postalCode: "78701",
			country: "US",
			email: null,
			phone: null,
		};
		let n = 0;
		const make = (over: Partial<AgentSessionContent>) =>
			createAgentSession(h.deps, {
				...CREATE,
				idempotencyKey: `cap-${++n}`,
				content: content(over),
			});
		const invalid = { ok: false, reason: "INVALID_REQUEST" };
		const cases: [Partial<AgentSessionContent>, Partial<AgentSessionContent>][] = [
			[{ buyer: { email: "e".repeat(256) } }, { buyer: { email: "e".repeat(257) } }],
			[{ buyer: { firstName: "f".repeat(256) } }, { buyer: { firstName: "f".repeat(257) } }],
			[{ buyer: { lastName: "l".repeat(256) } }, { buyer: { lastName: "l".repeat(257) } }],
			[{ buyer: { phone: "1".repeat(256) } }, { buyer: { phone: "1".repeat(257) } }],
			[{ couponCode: "C".repeat(64) }, { couponCode: "C".repeat(65) }],
			[{ shippingMethodId: "s".repeat(128) }, { shippingMethodId: "s".repeat(129) }],
			[{ cartId: "c".repeat(128) }, { cartId: "c".repeat(129) }],
		];
		for (const field of [
			"name",
			"line1",
			"line2",
			"city",
			"region",
			"postalCode",
			"country",
			"email",
			"phone",
		] as const) {
			cases.push([
				{ destination: { ...address, [field]: "a".repeat(256) } },
				{ destination: { ...address, [field]: "a".repeat(257) } },
			]);
		}
		for (const [ok, tooLong] of cases) {
			expect((await make(ok)).ok).toBe(true);
			expect(await make(tooLong)).toEqual(invalid);
		}
		// Replace validates the same way.
		const h2 = harness();
		const s2 = await created(h2);
		expect(
			await replaceAgentSession(h2.deps, {
				...keyed(s2.session.id, "p"),
				content: content({ couponCode: "C".repeat(65) }),
			}),
		).toEqual(invalid);
	});

	test("an empty fingerprint or network key is INVALID_REQUEST", async () => {
		const h = harness();
		const invalid = { ok: false, reason: "INVALID_REQUEST" };
		expect(
			await createAgentSession(h.deps, { ...CREATE, fingerprint: "", content: content() }),
		).toEqual(invalid);
		expect(
			await createAgentSession(h.deps, { ...CREATE, networkKey: "", content: content() }),
		).toEqual(invalid);
		const first = await created(h);
		expect(
			await completeAgentSession(h.deps, { ...keyed(first.session.id, "d"), fingerprint: "" }),
		).toEqual(invalid);
	});
});

describe("redeem classification after a refused mark", () => {
	test("a mark refused as incomplete whose re-read shows lines again is HANDOFF_INCOMPLETE", async () => {
		const h = harness();
		const first = await created(h);
		// The mark sees an emptied session; by the re-read it has lines again.
		const racing: AgentSessionStore = {
			...staleLookup(h.store, await stored(h, first.session.id)),
			markHandoffUsed: async () => ({ ok: false, reason: "incomplete" }),
		};
		expect(
			await redeemAgentHandoff({ ...h.deps, store: racing }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_INCOMPLETE" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
	});
});

describe("recordAgentHandoffCart (the redeem marks the shopper's cart)", () => {
	test("refuses before redemption; after it, points the session at the cart once", async () => {
		const h = harness();
		const r = await created(h, content({ cartId: "cart-agent" }));
		const id = r.session.id;
		expect(await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "cart-shopper" })).toEqual(
			{ ok: false, reason: "HANDOFF_NOT_REDEEMED" },
		);
		if (r.handoffToken === undefined) throw new Error("no link");
		expect((await redeemAgentHandoff(h.deps, { token: r.handoffToken })).ok).toBe(true);
		const marked = await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "cart-shopper" });
		expect(marked.ok && marked.session.cartId).toBe("cart-shopper");
		expect((await h.store.findByCartId("cart-shopper"))?.id).toBe(id);
		const revision = (await h.store.get(id))?.revision;
		await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "cart-shopper" });
		expect((await h.store.get(id))?.revision).toBe(revision);
	});

	test("the order placed from the marked cart completes the session; the cart is then settled", async () => {
		const h = harness();
		const r = await created(h);
		const id = r.session.id;
		if (r.handoffToken === undefined) throw new Error("no link");
		expect((await redeemAgentHandoff(h.deps, { token: r.handoffToken })).ok).toBe(true);
		expect((await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "cart-1" })).ok).toBe(
			true,
		);
		const placed = await recordAgentSessionOrder(h.deps, {
			sessionId: id,
			orderId: orderId("ord-1"),
			cartId: "cart-1",
		});
		expect(placed.ok && placed.session.status).toBe("completed");
		expect(await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "cart-2" })).toEqual({
			ok: false,
			reason: "SESSION_CLOSED",
		});
		expect(
			await recordAgentHandoffCart(h.deps, { sessionId: id, cartId: "x".repeat(10_000) }),
		).toEqual({ ok: false, reason: "INVALID_REQUEST" });
	});
});
