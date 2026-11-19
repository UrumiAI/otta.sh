import { describe, expect, test } from "vitest";
import {
	AGENT_SESSION_MAX_LINES,
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
	productId,
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
import { FakeSecrets } from "./fake-secrets.js";

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

/** A keyed request on `sessionId` from net-a; the key doubles as the fingerprint. */
function keyed(sessionId: AgentSessionId, key: string, networkKey = "net-a") {
	return { sessionId, idempotencyKey: key, fingerprint: `fp-${key}`, networkKey };
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
		expect(r.session.channel).toBe("other");
		expect(r.session.createdAt).toBe(T0.toISOString());
		expect(Date.parse(r.session.expiresAt) - T0.getTime()).toBe(DAY_MS);
		expect(Date.parse(r.session.purgeAt) - T0.getTime()).toBe(30 * DAY_MS);
		expect(r.session.linkGeneration).toBe(1);
		expect(r.orderSecret).toBe(`order:${r.session.id}`);
		expect(r.handoffToken).toBe(`link:${r.session.id}:1`);
		expect(r.session.orderSecretHash).toBe(`h(${r.orderSecret})`);
		expect(r.session.handoffTokenHash).toBe(`h(${r.handoffToken})`);
		const doc = JSON.stringify(await stored(h, r.session.id));
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
		expect(r.session.linkGeneration).toBe(0);
		expect(r.session.handoffTokenHash).toBeUndefined();
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
		expect(r.ok && r.session.networkKey).toBe("net-a");
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
		expect(r.session.linkGeneration).toBe(1);
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

	test("after a redeem, a replace mints a new link; the old one still answers used and its record stays", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(1000);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		const r = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-after"),
			content: content({ lines: [bowl] }),
		});
		expect(r.ok && r.session.linkGeneration).toBe(2);
		expect(r.ok && r.handoffToken).toBe(`link:${first.session.id}:2`);
		expect(r.ok && r.session.handoffUsedAt).toBeUndefined();
		expect(r.ok && r.session.redeemedHandoffs).toEqual([
			{
				tokenHash: `h(${first.handoffToken})`,
				usedAt: new Date(T0.getTime() + 1000).toISOString(),
			},
		]);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		expect(
			(await redeemAgentHandoff(h.deps, { token: r.ok ? (r.handoffToken ?? "") : "" })).ok,
		).toBe(true);
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

	test("the same key from another network is a fresh write, not a replay of the first", async () => {
		const h = harness();
		const first = await created(h);
		await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-1"),
			content: content({ lines: [bowl] }),
		});
		const other = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-1", "net-b"),
			fingerprint: "fp-different",
			content: content({ lines: [mug] }),
		});
		expect(other.ok && other.replayed).toBe(false);
		expect(other.ok && other.session.lines).toEqual([mug]);
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
		expect(s.retiredWriteKeys).toContainEqual({ key: "put-early", networkKey: "net-a" });
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
			networkKey: "net-a",
		}));
		const seeded = await h.store.write({ ...s, retiredWriteKeys: fill }, s.revision);
		expect(seeded.ok).toBe(true);
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "one-more"),
				content: content(),
			}),
		).toEqual({ ok: false, reason: "WRITE_LIMIT_REACHED" });
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

	test("after the link was redeemed, complete answers a fresh one", async () => {
		const h = harness();
		const first = await created(h);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		const r = await completeAgentSession(h.deps, keyed(first.session.id, "done-2"));
		expect(r.ok && r.handoffToken).toBe(`link:${first.session.id}:2`);
	});

	test("a session with no lines is SESSION_INCOMPLETE", async () => {
		const h = harness();
		const first = await created(h, content({ lines: [] }));
		expect(await completeAgentSession(h.deps, keyed(first.session.id, "done"))).toEqual({
			ok: false,
			reason: "SESSION_INCOMPLETE",
		});
	});
});

describe("issueAgentHandoff", () => {
	test("keyed: mints a new generation, a replay answers the same link, the old unused link dies", async () => {
		const h = harness();
		const first = await created(h);
		const issued = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(issued.ok && !issued.replayed).toBe(true);
		if (!issued.ok) return;
		expect(issued.session.linkGeneration).toBe(2);
		expect(issued.handoffToken).toBe(`link:${first.session.id}:2`);
		const replay = await issueAgentHandoff(h.deps, keyed(first.session.id, "issue-1"));
		expect(replay.ok && replay.replayed && replay.handoffToken).toBe(issued.handoffToken);
		expect((await stored(h, first.session.id)).linkGeneration).toBe(2);
		expect(await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			reason: "HANDOFF_INVALID",
		});
		expect((await redeemAgentHandoff(h.deps, { token: issued.handoffToken ?? "" })).ok).toBe(true);
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
		expect(r.session.handoffUsedAt).toBe(new Date(T0.getTime() + 5000).toISOString());
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
	test("replays on its key; canceling again under a new key answers it and writes nothing", async () => {
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
		const b = await cancelAgentSession(h.deps, keyed(first.session.id, "c2"));
		expect(b).toEqual({ ok: true, replayed: false, session: a.ok && a.session });
		expect(await stored(h, first.session.id)).toEqual(before);
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
