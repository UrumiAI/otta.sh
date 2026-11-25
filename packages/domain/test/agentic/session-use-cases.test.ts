import { describe, expect, test } from "vitest";
import {
	AGENT_SESSION_MAX_LINES,
	AGENT_SESSION_VIEW_KEYS,
	AGENT_SESSION_MAX_WRITE_RECORDS,
	AGENT_SESSION_MAX_WRITES,
	agentSessionId,
	cancelAgentSession,
	cents,
	DEFAULT_AGENT_SESSION_LIMITS,
	completeAgentSession,
	createAgentSession,
	currency,
	getAgentSession,
	issueAgentHandoff,
	orderId,
	productId,
	recordAgentSessionOrder,
	claimAgentHandoff,
	finalizeAgentHandoff,
	releaseAgentHandoffClaim,
	AGENT_HANDOFF_CLAIM_LEASE_MS,
	AGENT_HANDOFF_FINALIZE_GRACE_MS,
	AGENT_HANDOFF_REENTRY_WINDOW_MS,
	AGENT_SESSION_DOCUMENT_RESERVE_BYTES,
	AGENT_SESSION_MAX_CONTENT_BYTES,
	AGENT_SESSION_MAX_DOCUMENT_BYTES,
	AGENT_SESSION_MAX_LINE_ID_LENGTH,
	agentSessionDocumentBytes,
	replaceAgentSession,
	sku,
	verifyAgentOrderSecret,
	type AgentCheckoutSession,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionId,
	type AgentSessionQuote,
	type AgentSessionStore,
	type AgentSessionView,
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
	return { ...bindStore(store), findByHandoffTokenHash: async () => structuredClone(seen) };
}

/** The cart a test redeem "builds" for the shopper. */
const SHOPPER_CART = "cart-shopper";
/** The shopper's browser nonce (the site's httpOnly cookie). */
const SHOPPER = "nonce-shopper";

/**
 * A whole successful redeem as the plugin runs it: claim, then (the cart work
 * succeeding) finalize with {@link SHOPPER_CART}. A re-entry answers the session.
 */
async function redeemAgentHandoff(
	deps: Pick<AgentSessionDeps, "store" | "clock" | "secrets">,
	input: { token: string; redeemer?: string },
): Promise<
	{ ok: true; session: AgentSessionView; shopperCartId: string } | { ok: false; reason: string }
> {
	const claim = await claimAgentHandoff(deps, {
		token: input.token,
		redeemer: input.redeemer ?? SHOPPER,
	});
	if (!claim.ok) return claim;
	if (claim.status === "reentered") {
		return { ok: true, session: claim.session, shopperCartId: claim.shopperCartId };
	}
	const done = await finalizeAgentHandoff(deps, {
		sessionId: claim.session.id,
		claimId: claim.claimId,
		cartId: SHOPPER_CART,
	});
	return done.ok ? { ok: true, session: done.session, shopperCartId: done.shopperCartId } : done;
}

describe("createAgentSession", () => {
	test("mints a cs_ session: 24 h expiry, purge 1 h after expiry, channel other, hashes only", async () => {
		const h = harness();
		const r = await created(h);
		expect(r.session.status).toBe("requires_escalation");
		expect(Date.parse(r.session.expiresAt) - T0.getTime()).toBe(DAY_MS);
		expect(r.orderSecret).toBe(h.secrets.orderSecret(r.session.id));
		expect(r.handoffToken).toBe(h.secrets.token(r.session.id, 1));
		const s = await stored(h, r.session.id);
		expect(s.channel).toBe("other");
		expect(s.createdAt).toBe(T0.toISOString());
		expect(Date.parse(s.purgeAt) - T0.getTime()).toBe(DAY_MS + HOUR_MS);
		expect((await h.store.getIdempotency("net-a", CREATE.idempotencyKey))?.purgeAt).toBe(s.purgeAt);
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
		// The id, then the create attempt's id (for releasing its record).
		expect(h.secrets.minted).toHaveLength(2);
		expect(r.session.id).toBe(`cs_${h.secrets.minted[0]}`);
		expect((await h.store.getIdempotency("net-a", CREATE.idempotencyKey))?.attemptId).toBe(
			h.secrets.minted[1],
		);
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
		// The agent's cart is stored but never projected.
		expect(r.ok && "cartId" in r.session).toBe(false);
		expect(r.ok && (await stored(h, r.session.id)).cartId).toBe("cart-1");
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
		expect(h.secrets.minted).toHaveLength(2); // nothing new minted by the replay
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
			attemptId: "attempt-test",
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
			attemptId: "attempt-test",
			key: "k-late",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		});
		h.clock.advance(2 * HOUR_MS);
		const r = await createAgentSession(h.deps, {
			idempotencyKey: "k-late",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(r.ok && r.session.id).toBe(sessionId);
		const session = await stored(h, sessionId);
		expect(session.purgeAt).toBe(
			new Date(T0.getTime() + 2 * HOUR_MS + DAY_MS + HOUR_MS).toISOString(),
		);
		const record = await h.store.getIdempotency("net-a", "k-late");
		expect(record?.purgeAt).toBe(session.purgeAt);
		// Adopted: only the finishing attempt could have released it.
		expect(record?.attemptId).not.toBe("attempt-test");
		// The sweep at the record's original purge time leaves it, so a retry still replays.
		await h.store.purgeIdempotencyDue(new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(), 10);
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
			attemptId: "attempt-test",
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
		// A racer that finds the record while the first insert is in flight is told
		// to retry (WRITE_CONFLICT); none makes a second session.
		const ids = new Set(results.flatMap((r) => (r.ok ? [r.session.id] : [])));
		expect(ids.size).toBe(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("WRITE_CONFLICT");
		expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
		const secrets = new Set(results.flatMap((r) => (r.ok ? [r.orderSecret] : [])));
		expect(secrets.size).toBe(1);
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
		const retry = await createAgentSession(h.deps, {
			...CREATE,
			idempotencyKey: "k-race",
			content: content(),
		});
		expect(retry.ok && retry.replayed && retry.session.id).toBe([...ids][0]);
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

	test("the defaults: 500 live slots, 50 per network, 60 creates per network per hour", () => {
		expect(DEFAULT_AGENT_SESSION_LIMITS).toEqual({
			maxLiveSessions: 500,
			maxLivePerNetwork: 50,
			maxCreatesPerNetwork: 60,
			createWindowMs: HOUR_MS,
			maxLineQuantity: 10_000,
		});
	});

	test("a canceled session keeps its live slot until it expires (no create-cancel loop)", async () => {
		const h = harness({ maxLiveSessions: 1 });
		const first = await created(h);
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "c"))).ok).toBe(true);
		const make = (key: string) =>
			createAgentSession(h.deps, {
				idempotencyKey: key,
				fingerprint: "x",
				networkKey: "net-b",
				content: content(),
			});
		expect(await make("other")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(await h.store.getIdempotency("net-b", "other")).toBeNull();
		h.clock.advance(DAY_MS);
		expect((await make("later")).ok).toBe(true);
	});

	test("store-wide cap on live sessions", async () => {
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

describe("claimAgentHandoff + finalizeAgentHandoff (redeem)", () => {
	test("redeems once; the second redeem fails typed", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		h.clock.advance(5000);
		const r = await redeemAgentHandoff(h.deps, { token });
		if (!r.ok) throw new Error(`redeem failed: ${r.reason}`);
		expect(r.session.lines).toEqual([mug]);
		expect(r.session.handedOff).toBe(true);
		expect(r.shopperCartId).toBe(SHOPPER_CART);
		expect("cartId" in r.session).toBe(false);
		expect((await stored(h, first.session.id)).handoffUsedAt).toBe(
			new Date(T0.getTime() + 5000).toISOString(),
		);
		// Past the re-entry window the link is used.
		h.clock.advance(AGENT_HANDOFF_REENTRY_WINDOW_MS);
		expect(await claimAgentHandoff(h.deps, { token, redeemer: SHOPPER })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	test("racing claims: exactly one claims, the rest are HANDOFF_IN_PROGRESS", async () => {
		const h = harness();
		const first = await created(h);
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				claimAgentHandoff(h.deps, { token: first.handoffToken ?? "", redeemer: SHOPPER }),
			),
		);
		expect(results.filter((r) => r.ok && r.status === "claimed")).toHaveLength(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("HANDOFF_IN_PROGRESS");
		expect(results.filter((r) => !r.ok)).toHaveLength(5);
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

	test("a completed session answers HANDOFF_USED whether the pre-check or the atomic claim sees it", async () => {
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
		// A lookup that read the session before it completed: only the claim sees it.
		const stale = staleLookup(h.store, open);
		expect(
			await redeemAgentHandoff({ ...h.deps, store: stale }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_USED" });
	});

	test("a session emptied after the lookup is refused by the claim: HANDOFF_INCOMPLETE, link not burned", async () => {
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
		expect(r.ok && "cartId" in r.session).toBe(false);
		expect((await stored(h, first.session.id)).shopperCartId).toBe("cart-rebuilt");
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

	test("refused at or after expiresAt (attribution is for orders within the 24 h); a replay still answers", async () => {
		const h = harness();
		const first = await redeemed(h);
		const ok = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		expect(ok.ok && ok.session.status).toBe("completed");
		h.clock.advance(DAY_MS);
		const replay = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
		});
		expect(replay.ok && replay.replayed).toBe(true);
		const h2 = harness();
		const s2 = await redeemed(h2);
		h2.clock.advance(DAY_MS);
		expect(
			await recordAgentSessionOrder(h2.deps, { sessionId: s2.session.id, orderId: orderId("o") }),
		).toEqual({ ok: false, reason: "SESSION_EXPIRED" });
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

describe("redeem classification after a refused claim", () => {
	test("a claim refused as incomplete whose re-read shows lines again is HANDOFF_INCOMPLETE", async () => {
		const h = harness();
		const first = await created(h);
		// The mark sees an emptied session; by the re-read it has lines again.
		const racing: AgentSessionStore = {
			...staleLookup(h.store, await stored(h, first.session.id)),
			claimHandoff: async () => ({ ok: false, reason: "incomplete" }),
		};
		expect(
			await redeemAgentHandoff({ ...h.deps, store: racing }, { token: first.handoffToken ?? "" }),
		).toEqual({ ok: false, reason: "HANDOFF_INCOMPLETE" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
	});
});

describe("replay edge cases", () => {
	test("a create record left past its purge time, with no session, is expired: never re-created", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_purgedlinger000000000");
		await h.store.putIdempotency({
			networkKey: "net-a",
			attemptId: "attempt-test",
			key: "k-linger",
			fingerprint: "fp",
			sessionId,
			createdAt: new Date(T0.getTime() - 31 * DAY_MS).toISOString(),
			purgeAt: new Date(T0.getTime() - DAY_MS).toISOString(),
		});
		const r = await createAgentSession(h.deps, {
			idempotencyKey: "k-linger",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(r).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_EXPIRED" });
		expect(await h.store.get(sessionId)).toBeNull();
	});

	test("a create replay on a session past its purge time (not yet swept) is expired, never answered", async () => {
		const h = harness();
		const first = await created(h, content({ buyer: { email: "pii@example.test" } }));
		h.clock.advance(30 * DAY_MS);
		expect(
			await createAgentSession(h.deps, {
				...CREATE,
				content: content({ buyer: { email: "pii@example.test" } }),
			}),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_EXPIRED" });
		const put = keyed(first.session.id, "late");
		expect(await cancelAgentSession(h.deps, put)).toEqual({
			ok: false,
			reason: "SESSION_NOT_FOUND",
		});
		expect(await getAgentSession(h.deps, { sessionId: first.session.id })).toEqual({
			ok: false,
			reason: "SESSION_NOT_FOUND",
		});
	});

	test("a create record that outlives its purge-due session answers no replay", async () => {
		const h = harness();
		const first = await created(h);
		// A record moved out past its session (e.g. by a late orphan adopter elsewhere).
		expect(
			await h.store.adoptIdempotency("net-a", CREATE.idempotencyKey, {
				sessionId: first.session.id,
				attemptId: "attempt-late",
				purgeAt: new Date(T0.getTime() + 60 * DAY_MS).toISOString(),
				now: new Date(T0.getTime() + DAY_MS).toISOString(), // its slots expired
			}),
		).toBe("adopted");
		h.clock.advance(30 * DAY_MS);
		expect(await createAgentSession(h.deps, { ...CREATE, content: content() })).toEqual({
			ok: false,
			reason: "IDEMPOTENCY_KEY_EXPIRED",
		});
		expect(await h.store.get(first.session.id)).not.toBeNull();
	});

	test("a keyed replay on a session past its purge time is not answered", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		expect((await replaceAgentSession(h.deps, put)).ok).toBe(true);
		h.clock.advance(30 * DAY_MS);
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: false,
			reason: "SESSION_NOT_FOUND",
		});
	});

	test("after the sweep purges a session, its create key is fresh: a new session, never the old one", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(30 * DAY_MS);
		expect(await h.store.purge(first.session.id, h.clock.now().toISOString())).toBe(true);
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again.ok && !again.replayed).toBe(true);
		expect(again.ok && again.session.id).not.toBe(first.session.id);
	});

	test("replays after cancel and after expiry answer the stored answer with no live link", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-1"), content: content({ lines: [bowl] }) };
		const applied = await replaceAgentSession(h.deps, put);
		if (!applied.ok) throw new Error("replace failed");
		h.clock.advance(DAY_MS);
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: true,
			replayed: true,
			session: applied.session,
		});
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "c"))).ok).toBe(true);
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: true,
			replayed: true,
			session: applied.session,
		});
		const createReplay = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(createReplay).toEqual({
			ok: true,
			replayed: true,
			session: first.session,
			orderSecret: first.orderSecret,
		});
	});

	test("a refused write records nothing: the same key then applies a corrected body", async () => {
		const h = harness();
		const first = await created(h);
		const bad = {
			...keyed(first.session.id, "k"),
			content: content({ lines: [{ ...mug, quantity: 0 }] }),
		};
		expect(await replaceAgentSession(h.deps, bad)).toEqual({
			ok: false,
			reason: "INVALID_QUANTITY",
		});
		const fixed = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "k"),
			fingerprint: "fp-fixed",
			content: content({ lines: [bowl] }),
		});
		expect(fixed.ok && !fixed.replayed && fixed.session.lines).toEqual([bowl]);
	});

	test("a create refused by the store's live cap at insert keeps no record: the key is free again", async () => {
		const h = harness({ maxLiveSessions: 1 });
		const first = await created(h);
		// The soft pre-count misses a racer: the insert itself must refuse.
		const racy: AgentSessionStore = {
			...bindStore(h.store),
			occupiedSlots: async () => ({ store: 0, network: 0 }),
		};
		const deps = { ...h.deps, store: racy };
		const make = (fingerprint: string) =>
			createAgentSession(deps, {
				idempotencyKey: "k-cap",
				fingerprint,
				networkKey: "net-b",
				content: content(),
			});
		expect(await make("fp-1")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
		expect(await h.store.getIdempotency("net-b", "k-cap")).toBeNull();
		// The slot frees when the session expires (a cancel would not free it).
		expect(first.session.id).toBeDefined();
		h.clock.advance(DAY_MS);
		const r = await make("fp-2");
		expect(r.ok && !r.replayed).toBe(true);
	});

	test("one key across operations is refused, nothing written, whichever came first", async () => {
		const ops = {
			replace: (h: Harness, id: AgentSessionId, key: string) =>
				replaceAgentSession(h.deps, { ...keyed(id, key), content: content({ lines: [bowl] }) }),
			complete: (h: Harness, id: AgentSessionId, key: string) =>
				completeAgentSession(h.deps, keyed(id, key)),
			issue_handoff: (h: Harness, id: AgentSessionId, key: string) =>
				issueAgentHandoff(h.deps, keyed(id, key)),
			cancel: (h: Harness, id: AgentSessionId, key: string) =>
				cancelAgentSession(h.deps, keyed(id, key)),
		};
		const names = Object.keys(ops) as (keyof typeof ops)[];
		for (const firstOp of names) {
			for (const secondOp of names) {
				if (firstOp === secondOp) continue;
				const h = harness();
				const s = await created(h);
				// The same fingerprint on purpose: an empty body hashes alike for every operation.
				expect((await ops[firstOp](h, s.session.id, "shared")).ok).toBe(true);
				const before = await stored(h, s.session.id);
				expect(await ops[secondOp](h, s.session.id, "shared"), `${firstOp}→${secondOp}`).toEqual({
					ok: false,
					reason: "IDEMPOTENCY_KEY_REUSED",
				});
				expect(await stored(h, s.session.id)).toEqual(before);
			}
			// The create's own key, reused on a session write, is refused too.
			const h = harness();
			const s = await created(h);
			const before = await stored(h, s.session.id);
			expect(await ops[firstOp](h, s.session.id, CREATE.idempotencyKey)).toEqual({
				ok: false,
				reason: "IDEMPOTENCY_KEY_REUSED",
			});
			expect(await stored(h, s.session.id)).toEqual(before);
		}
	});

	test("racing writes on one key with different bodies: one applies, the other is refused", async () => {
		const h = harness();
		const s = await created(h);
		const [a, b] = await Promise.all([
			replaceAgentSession(h.deps, {
				...keyed(s.session.id, "k"),
				fingerprint: "fp-a",
				content: content({ lines: [bowl] }),
			}),
			replaceAgentSession(h.deps, {
				...keyed(s.session.id, "k"),
				fingerprint: "fp-b",
				content: content({ lines: [mug, bowl] }),
			}),
		]);
		const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.reason)).toSorted();
		expect(outcomes).toEqual(["IDEMPOTENCY_KEY_REUSED", "ok"]);
		expect((await stored(h, s.session.id)).writes.filter((w) => w.key === "k")).toHaveLength(1);
	});

	test("finishing an orphan whose record a racer released puts the record back", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_orphanrace00000000000");
		const record = {
			networkKey: "net-a",
			attemptId: "attempt-test",
			key: "k-orphan",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + 30 * DAY_MS).toISOString(),
		};
		await h.store.putIdempotency(record);
		// The record is released (by whoever owns it) just before our insert takes a
		// slot, so the release saw no live slot: the landed session must get its
		// record back, or a replay of the key would make a second session.
		let released = "";
		const racing: AgentSessionStore = {
			...bindStore(h.store),
			insert: async (session, capacity) => {
				const owner = (await h.store.getIdempotency("net-a", "k-orphan"))?.attemptId ?? "";
				released = await h.store.releaseIdempotency("net-a", "k-orphan", owner, capacity.now);
				return h.store.insert(session, capacity);
			},
		};
		const req = { idempotencyKey: "k-orphan", fingerprint: "fp", networkKey: "net-a" };
		const r = await createAgentSession(
			{ ...h.deps, store: racing },
			{ ...req, content: content() },
		);
		expect(released).toBe("released");
		expect(r.ok && r.session.id).toBe(sessionId);
		expect((await h.store.getIdempotency("net-a", "k-orphan"))?.sessionId).toBe(sessionId);
		const replay = await createAgentSession(h.deps, { ...req, content: content() });
		expect(replay.ok && replay.replayed && replay.session.id).toBe(sessionId);
	});

	test("a create retried from another network never answers the first network's session", async () => {
		const h = harness();
		const first = await created(h);
		const other = await createAgentSession(h.deps, {
			...CREATE,
			networkKey: "net-b",
			content: content(),
		});
		expect(other.ok && other.session.id).not.toBe(first.session.id);
		expect(other.ok && other.orderSecret).not.toBe(first.orderSecret);
		// and net-b's replay answers net-b's session, net-a's answers net-a's.
		const replayB = await createAgentSession(h.deps, {
			...CREATE,
			networkKey: "net-b",
			content: content(),
		});
		expect(replayB.ok && replayB.session.id).toBe(other.ok && other.session.id);
		const replayA = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(replayA.ok && replayA.session.id).toBe(first.session.id);
	});
});

/** Every method of `store`, bound, so a test can override one. */
function bindStore(store: AgentSessionStore): AgentSessionStore {
	const bound: Record<string, unknown> = {};
	let proto: object | null = store;
	while (proto !== null && proto !== Object.prototype) {
		for (const name of Object.getOwnPropertyNames(proto)) {
			const value = (store as unknown as Record<string, unknown>)[name];
			if (name !== "constructor" && typeof value === "function" && !(name in bound)) {
				bound[name] = (value as (...a: unknown[]) => unknown).bind(store);
			}
		}
		proto = Object.getPrototypeOf(proto) as object | null;
	}
	return bound as unknown as AgentSessionStore;
}

async function claimed(h: Harness, token: string) {
	const r = await claimAgentHandoff(h.deps, { token, redeemer: SHOPPER });
	if (!r.ok || r.status !== "claimed") throw new Error("claim failed");
	return r;
}

describe("hand-off claim (lease) and finalize", () => {
	test("a claim leases the link for the lease time and does not use it", async () => {
		const h = harness();
		const first = await created(h);
		const c = await claimed(h, first.handoffToken ?? "");
		expect(c.leaseUntil).toBe(new Date(T0.getTime() + AGENT_HANDOFF_CLAIM_LEASE_MS).toISOString());
		expect(c.session.handedOff).toBe(false);
		const s = await stored(h, first.session.id);
		expect(s.handoffUsedAt).toBeUndefined();
		expect(s.handoffClaim).toEqual({
			tokenHash: `h(${first.handoffToken})`,
			claimId: c.claimId,
			redeemerHash: `h(${SHOPPER})`,
			claimedAt: T0.toISOString(),
			leaseUntil: c.leaseUntil,
		});
		// The claim id is minted by the secrets port, not guessable from the session.
		expect(h.secrets.minted).toContain(c.claimId);
	});

	test("a second redeem during a live claim is HANDOFF_IN_PROGRESS and writes nothing", async () => {
		const h = harness();
		const first = await created(h);
		await claimed(h, first.handoffToken ?? "");
		const before = await stored(h, first.session.id);
		const minted = h.secrets.minted.length;
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS - 1);
		expect(
			await claimAgentHandoff(h.deps, { token: first.handoffToken ?? "", redeemer: SHOPPER }),
		).toEqual({
			ok: false,
			reason: "HANDOFF_IN_PROGRESS",
		});
		expect(await stored(h, first.session.id)).toEqual(before);
		// Refused on the read: no claim was even attempted.
		expect(h.secrets.minted).toHaveLength(minted);
	});

	test("a transient failure after the claim never kills the link: after the lease the same token redeems", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const lost = await claimed(h, token); // the cart work then throws: no finalize
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS);
		const retry = await claimed(h, token);
		expect(retry.claimId).not.toBe(lost.claimId);
		const done = await finalizeAgentHandoff(h.deps, {
			sessionId: first.session.id,
			claimId: retry.claimId,
			cartId: SHOPPER_CART,
		});
		expect(done.ok && done.session.handedOff && done.shopperCartId).toBe(SHOPPER_CART);
		// The first attempt, coming back late, cannot finalize a second cart.
		expect(
			await finalizeAgentHandoff(h.deps, {
				sessionId: first.session.id,
				claimId: lost.claimId,
				cartId: "cart-late",
			}),
		).toEqual({ ok: false, reason: "HANDOFF_CLAIM_LOST" });
		expect((await stored(h, first.session.id)).shopperCartId).toBe(SHOPPER_CART);
	});

	test("a failed or no-lines attempt releases its claim: never finalized, redeemable at once", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const c = await claimed(h, token);
		expect(
			await releaseAgentHandoffClaim(h.deps, { sessionId: first.session.id, claimId: c.claimId }),
		).toEqual({ ok: true, released: true });
		const s = await stored(h, first.session.id);
		expect(s.handoffUsedAt).toBeUndefined();
		expect(s.handoffClaim).toBeUndefined();
		expect((await claimAgentHandoff(h.deps, { token, redeemer: SHOPPER })).ok).toBe(true);
		// Releasing a claim that is not the session's is a no-op.
		expect(
			await releaseAgentHandoffClaim(h.deps, { sessionId: first.session.id, claimId: c.claimId }),
		).toEqual({ ok: true, released: false });
	});

	test("agent writes are refused HANDOFF_IN_PROGRESS while a claim is live; replays still answer", async () => {
		const h = harness();
		const first = await created(h);
		const put = { ...keyed(first.session.id, "put-0"), content: content({ lines: [bowl] }) };
		const applied = await replaceAgentSession(h.deps, put);
		await claimed(h, first.handoffToken ?? "");
		const before = await stored(h, first.session.id);
		const inProgress = { ok: false, reason: "HANDOFF_IN_PROGRESS" };
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "put-1"),
				content: content({ lines: [] }),
			}),
		).toEqual(inProgress);
		expect(await completeAgentSession(h.deps, keyed(first.session.id, "done"))).toEqual(inProgress);
		expect(await issueAgentHandoff(h.deps, keyed(first.session.id, "issue"))).toEqual(inProgress);
		expect(await stored(h, first.session.id)).toEqual(before);
		expect(await replaceAgentSession(h.deps, put)).toEqual({
			ok: true,
			replayed: true,
			session: applied.ok && applied.session,
			handoffToken: first.handoffToken,
		});
		// A cancel is never held back by a claim.
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "cancel"))).ok).toBe(true);
	});

	test("after a lapse, an agent write clears the claim: its late finalize is HANDOFF_CLAIM_LOST", async () => {
		const h = harness();
		const first = await created(h);
		const c = await claimed(h, first.handoffToken ?? "");
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS);
		const r = await replaceAgentSession(h.deps, {
			...keyed(first.session.id, "put-after"),
			content: content({ lines: [bowl] }),
		});
		expect(r.ok).toBe(true);
		expect((await stored(h, first.session.id)).handoffClaim).toBeUndefined();
		expect(
			await finalizeAgentHandoff(h.deps, {
				sessionId: first.session.id,
				claimId: c.claimId,
				cartId: SHOPPER_CART,
			}),
		).toEqual({ ok: false, reason: "HANDOFF_CLAIM_LOST" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
	});

	test("finalize is exactly once: the same claim and cart replays, another cart is HANDOFF_USED", async () => {
		const h = harness();
		const first = await created(h);
		const c = await claimed(h, first.handoffToken ?? "");
		const fin = { sessionId: first.session.id, claimId: c.claimId, cartId: SHOPPER_CART };
		const results = await Promise.all([1, 2, 3].map(() => finalizeAgentHandoff(h.deps, fin)));
		expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
		expect(results.filter((r) => r.ok && r.replayed)).toHaveLength(2);
		const after = await stored(h, first.session.id);
		expect(after.shopperCartId).toBe(SHOPPER_CART);
		expect(await finalizeAgentHandoff(h.deps, { ...fin, cartId: "cart-2" })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		expect(await stored(h, first.session.id)).toEqual(after);
	});

	test("finalize refuses a bad cart id or an empty claim id, a canceled session and an unknown one", async () => {
		const h = harness();
		const first = await created(h);
		const c = await claimed(h, first.handoffToken ?? "");
		const fin = { sessionId: first.session.id, claimId: c.claimId, cartId: SHOPPER_CART };
		const invalid = { ok: false, reason: "INVALID_REQUEST" };
		expect(await finalizeAgentHandoff(h.deps, { ...fin, cartId: "" })).toEqual(invalid);
		expect(await finalizeAgentHandoff(h.deps, { ...fin, cartId: "c".repeat(129) })).toEqual(
			invalid,
		);
		expect(await finalizeAgentHandoff(h.deps, { ...fin, claimId: "" })).toEqual(invalid);
		expect(
			await finalizeAgentHandoff(h.deps, {
				...fin,
				sessionId: agentSessionId("cs_unknown00000000000000"),
			}),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
		// Canceled while the claim's lease lapsed (cancel waits for a live claim).
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS);
		const s = await stored(h, first.session.id);
		const closed = await h.store.write({ ...s, status: "canceled" }, s.revision);
		expect(closed.ok).toBe(true);
		expect(await finalizeAgentHandoff(h.deps, fin)).toEqual({
			ok: false,
			reason: "HANDOFF_CANCELED",
		});
	});

	test("re-redeeming a finalized link re-enters its cart within the window, before any order", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const done = await redeemAgentHandoff(h.deps, { token });
		if (!done.ok) throw new Error("redeem failed");
		const after = await stored(h, first.session.id);
		h.clock.advance(AGENT_HANDOFF_REENTRY_WINDOW_MS - 1);
		expect(await claimAgentHandoff(h.deps, { token, redeemer: SHOPPER })).toEqual({
			ok: true,
			status: "reentered",
			session: done.session,
			shopperCartId: SHOPPER_CART,
			handoffUsedAt: after.handoffUsedAt,
		});
		expect(await stored(h, first.session.id)).toEqual(after);
		h.clock.advance(1);
		expect(await claimAgentHandoff(h.deps, { token, redeemer: SHOPPER })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	test("no re-entry once an order is recorded, nor after cancel", async () => {
		const h = harness();
		const a = await created(h);
		expect((await redeemAgentHandoff(h.deps, { token: a.handoffToken ?? "" })).ok).toBe(true);
		const rec = await recordAgentSessionOrder(h.deps, {
			sessionId: a.session.id,
			orderId: orderId("ord-1"),
		});
		expect(rec.ok).toBe(true);
		expect(
			await claimAgentHandoff(h.deps, { token: a.handoffToken ?? "", redeemer: SHOPPER }),
		).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		const b = await createAgentSession(h.deps, {
			...CREATE,
			idempotencyKey: "create-2",
			content: content(),
		});
		if (!b.ok) throw new Error("create failed");
		expect((await redeemAgentHandoff(h.deps, { token: b.handoffToken ?? "" })).ok).toBe(true);
		expect((await cancelAgentSession(h.deps, keyed(b.session.id, "c"))).ok).toBe(true);
		expect(
			await claimAgentHandoff(h.deps, { token: b.handoffToken ?? "", redeemer: SHOPPER }),
		).toEqual({
			ok: false,
			reason: "HANDOFF_CANCELED",
		});
	});

	test("a claim racing a finalize: the loser re-reads and re-enters the finalized cart", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const c = await claimed(h, token);
		const open = await stored(h, first.session.id);
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS);
		await finalizeAgentHandoff(h.deps, {
			sessionId: first.session.id,
			claimId: c.claimId,
			cartId: SHOPPER_CART,
		});
		// The second tab looked the link up before the finalize landed.
		const r = await claimAgentHandoff(
			{ ...h.deps, store: staleLookup(h.store, open) },
			{ token, redeemer: SHOPPER },
		);
		expect(r.ok && r.status === "reentered" && r.shopperCartId).toBe(SHOPPER_CART);
	});
});

describe("storage bounds per session", () => {
	test("a line's product id and sku are capped; empty ones are refused", async () => {
		const h = harness();
		const make = (line: AgentSessionContent["lines"][number], key: string) =>
			createAgentSession(h.deps, {
				...CREATE,
				idempotencyKey: key,
				content: content({ lines: [line] }),
			});
		const long = "p".repeat(AGENT_SESSION_MAX_LINE_ID_LENGTH);
		expect((await make({ ...mug, productId: productId(long), sku: sku(long) }, "ok")).ok).toBe(
			true,
		);
		const invalid = { ok: false, reason: "INVALID_REQUEST" };
		expect(await make({ ...mug, productId: productId(`${long}x`) }, "a")).toEqual(invalid);
		expect(await make({ ...mug, sku: sku(`${long}x`) }, "b")).toEqual(invalid);
		expect(await make({ ...mug, sku: "" as typeof mug.sku }, "c")).toEqual(invalid);
	});

	test("content over its byte cap is CONTENT_TOO_LARGE, measured in UTF-8 bytes", async () => {
		const h = harness();
		// Every field at its character cap, in three-byte characters.
		const wide = "€";
		const lines = Array.from({ length: AGENT_SESSION_MAX_LINES }, (_, i) => ({
			productId: productId(`${i}`.padEnd(AGENT_SESSION_MAX_LINE_ID_LENGTH, wide)),
			sku: sku(`${i}`.padEnd(AGENT_SESSION_MAX_LINE_ID_LENGTH, wide)),
			quantity: 1,
		}));
		expect(await createAgentSession(h.deps, { ...CREATE, content: content({ lines }) })).toEqual({
			ok: false,
			reason: "CONTENT_TOO_LARGE",
		});
		expect(await h.store.getIdempotency("net-a", CREATE.idempotencyKey)).toBeNull();
		const r = await created(h);
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(r.session.id, "big"),
				content: content({ lines }),
			}),
		).toEqual({ ok: false, reason: "CONTENT_TOO_LARGE" });
		expect(AGENT_SESSION_MAX_CONTENT_BYTES).toBe(32 * 1024);
	});

	test("an order id over 128 characters is INVALID_REQUEST", async () => {
		const h = harness();
		const first = await created(h);
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		expect(
			await recordAgentSessionOrder(h.deps, {
				sessionId: first.session.id,
				orderId: orderId("o".repeat(129)),
			}),
		).toEqual({ ok: false, reason: "INVALID_REQUEST" });
	});

	/** Content near its byte cap: every write record then weighs about as much. */
	function heavyContent(tag: string): AgentSessionContent {
		const lines = Array.from({ length: AGENT_SESSION_MAX_LINES }, (_, i) => ({
			productId: productId(`${tag}-${i}`.padEnd(AGENT_SESSION_MAX_LINE_ID_LENGTH, "p")),
			sku: sku(`${tag}-${i}`.padEnd(AGENT_SESSION_MAX_LINE_ID_LENGTH, "s")),
			quantity: 1,
		}));
		return content({ lines });
	}

	test("heavy writes evict the oldest records to keep the document under its budget less the reserve", async () => {
		const h = harness();
		const first = await created(h, heavyContent("c"));
		const budget = AGENT_SESSION_MAX_DOCUMENT_BYTES - AGENT_SESSION_DOCUMENT_RESERVE_BYTES;
		for (let i = 0; i < 12; i++) {
			const r = await replaceAgentSession(h.deps, {
				...keyed(first.session.id, `put-${i}`),
				content: heavyContent(`r${i}`),
			});
			expect(r.ok, `write ${i}`).toBe(true);
			const s = await stored(h, first.session.id);
			expect(agentSessionDocumentBytes(s)).toBeLessThanOrEqual(budget);
			expect(s.writes.at(-1)?.key).toBe(`put-${i}`);
			expect(s.writes.length + s.retiredWriteKeys.length).toBe(i + 2);
		}
		const s = await stored(h, first.session.id);
		expect(s.writes.length).toBeLessThan(AGENT_SESSION_MAX_WRITE_RECORDS);
		// An evicted key is refused on a late replay, never re-applied.
		expect(s.retiredWriteKeys).toContainEqual({ key: "put-0" });
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "put-0"),
				content: heavyContent("r0"),
			}),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_EXPIRED" });
		// The newest record still replays.
		expect(
			(
				await replaceAgentSession(h.deps, {
					...keyed(first.session.id, "put-11"),
					content: heavyContent("r11"),
				})
			).ok,
		).toBe(true);
	});

	test("a write that cannot fit even alone is WRITE_LIMIT_REACHED; cancel still fits, and so does a hand-off", async () => {
		const h = harness();
		const first = await created(h);
		const s = await stored(h, first.session.id);
		// Retired keys heavy enough that a full record no longer fits under the budget.
		const budget = AGENT_SESSION_MAX_DOCUMENT_BYTES - AGENT_SESSION_DOCUMENT_RESERVE_BYTES;
		const fill: { key: string }[] = [];
		let doc: AgentCheckoutSession = s;
		while (agentSessionDocumentBytes(doc) < budget - 64) {
			fill.push({ key: `r${fill.length}`.padEnd(250, "k") });
			doc = { ...s, retiredWriteKeys: fill };
		}
		fill.pop();
		const seeded = await h.store.write({ ...s, retiredWriteKeys: fill }, s.revision);
		if (!seeded.ok) throw new Error("seed failed");
		expect(agentSessionDocumentBytes(seeded.session)).toBeLessThanOrEqual(budget);
		expect(
			await replaceAgentSession(h.deps, {
				...keyed(first.session.id, "one-more"),
				content: heavyContent("z"),
			}),
		).toEqual({ ok: false, reason: "WRITE_LIMIT_REACHED" });
		expect(await stored(h, first.session.id)).toEqual(seeded.session);
		// A hand-off (claim, finalize, order) adds a few bytes the reserve covers.
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		const c = await cancelAgentSession(h.deps, keyed(first.session.id, "cancel"));
		expect(c.ok && c.session.status).toBe("canceled");
		expect(agentSessionDocumentBytes(await stored(h, first.session.id))).toBeLessThanOrEqual(
			AGENT_SESSION_MAX_DOCUMENT_BYTES,
		);
	});

	test("a store that refuses a write as too large is answered WRITE_LIMIT_REACHED, never a conflict loop", async () => {
		const h = harness();
		const first = await created(h);
		const tooLarge: AgentSessionStore = {
			...bindStore(h.store),
			write: async () => ({ ok: false, reason: "too_large" }),
		};
		expect(
			await replaceAgentSession(
				{ ...h.deps, store: tooLarge },
				{ ...keyed(first.session.id, "p"), content: content({ lines: [bowl] }) },
			),
		).toEqual({ ok: false, reason: "WRITE_LIMIT_REACHED" });
	});
});

describe("review round 2", () => {
	const BROWSER = "nonce-browser-1";
	const OTHER = "nonce-agent";

	async function redeemAs(h: Harness, token: string, redeemer: string) {
		const claim = await claimAgentHandoff(h.deps, { token, redeemer });
		if (!claim.ok || claim.status !== "claimed") throw new Error("claim failed");
		const done = await finalizeAgentHandoff(h.deps, {
			sessionId: claim.session.id,
			claimId: claim.claimId,
			cartId: SHOPPER_CART,
		});
		if (!done.ok) throw new Error(`finalize failed: ${done.reason}`);
		return { claim, done };
	}

	test("A: re-entry is per browser: the redeemer re-enters, any other holder of the token gets HANDOFF_USED", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const { done } = await redeemAs(h, token, BROWSER);
		expect(await claimAgentHandoff(h.deps, { token, redeemer: OTHER })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
		const again = await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		expect(again).toEqual({
			ok: true,
			status: "reentered",
			session: done.session,
			shopperCartId: SHOPPER_CART,
			handoffUsedAt: T0.toISOString(),
		});
	});

	test("A: during a live claim every claimant, the same browser included, gets HANDOFF_IN_PROGRESS", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		expect((await claimAgentHandoff(h.deps, { token, redeemer: BROWSER })).ok).toBe(true);
		for (const redeemer of [BROWSER, OTHER]) {
			expect(await claimAgentHandoff(h.deps, { token, redeemer })).toEqual({
				ok: false,
				reason: "HANDOFF_IN_PROGRESS",
			});
		}
	});

	test("1b: a claim that lapsed without finalizing is unbound: any browser may claim it again", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const lost = await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		if (!lost.ok || lost.status !== "claimed") throw new Error("claim failed");
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS);
		// e.g. the in-app webview failed and the shopper opened the link in Safari.
		const other = await claimAgentHandoff(h.deps, { token, redeemer: OTHER });
		if (!other.ok || other.status !== "claimed") throw new Error("re-claim refused");
		expect((await stored(h, first.session.id)).handoffClaim?.redeemerHash).toBe(`h(${OTHER})`);
		const done = await finalizeAgentHandoff(h.deps, {
			sessionId: first.session.id,
			claimId: other.claimId,
			cartId: SHOPPER_CART,
		});
		expect(done.ok).toBe(true);
		// Binding applies to re-entry only: now the first browser is refused.
		expect(await claimAgentHandoff(h.deps, { token, redeemer: BROWSER })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	test("A: the domain stores only the redeemer's hash; an empty redeemer is refused", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		// No nonce cookie on the POST: retryable (the site reloads the landing page).
		expect(await claimAgentHandoff(h.deps, { token, redeemer: "" })).toEqual({
			ok: false,
			reason: "HANDOFF_REDEEMER_MISSING",
		});
		expect(await claimAgentHandoff(h.deps, { token, redeemer: "x".repeat(257) })).toEqual({
			ok: false,
			reason: "HANDOFF_INVALID",
		});
		await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		const s = await stored(h, first.session.id);
		expect(s.handoffClaim?.redeemerHash).toBe(`h(${BROWSER})`);
		expect(JSON.stringify(s)).not.toContain(`"${BROWSER}"`);
	});

	test("B: no agent-facing view carries a cart id; the plugin gets the carts separately", async () => {
		const h = harness();
		const first = await created(h, content({ cartId: "cart-agent" }));
		expect("cartId" in first.session).toBe(false);
		expect(AGENT_SESSION_VIEW_KEYS).not.toContain("cartId");
		const replay = await createAgentSession(h.deps, {
			...CREATE,
			content: content({ cartId: "cart-agent" }),
		});
		expect(replay.ok && "cartId" in replay.session).toBe(false);
		const got = await getAgentSession(h.deps, { sessionId: first.session.id });
		expect(got.ok && "cartId" in got.session).toBe(false);
		const claim = await claimAgentHandoff(h.deps, {
			token: first.handoffToken ?? "",
			redeemer: BROWSER,
		});
		if (!claim.ok || claim.status !== "claimed") throw new Error("claim failed");
		expect(claim.agentCartId).toBe("cart-agent");
		expect("cartId" in claim.session).toBe(false);
		const done = await finalizeAgentHandoff(h.deps, {
			sessionId: first.session.id,
			claimId: claim.claimId,
			cartId: SHOPPER_CART,
		});
		expect(done.ok && done.shopperCartId).toBe(SHOPPER_CART);
		expect(done.ok && "cartId" in done.session).toBe(false);
		const s = await stored(h, first.session.id);
		expect(s.cartId).toBe("cart-agent");
		expect(s.shopperCartId).toBe(SHOPPER_CART);
		for (const w of s.writes) expect("cartId" in w.answer).toBe(false);
		expect((await h.store.findByCartId(SHOPPER_CART))?.id).toBe(first.session.id);
		const order = await recordAgentSessionOrder(h.deps, {
			sessionId: first.session.id,
			orderId: orderId("ord-1"),
			cartId: "cart-placed",
		});
		expect(order.ok && "cartId" in order.session).toBe(false);
		expect((await stored(h, first.session.id)).shopperCartId).toBe("cart-placed");
	});

	test("C: unredeemed and handed-off sessions purge an hour after expiry, also when canceled", async () => {
		const h = harness();
		const a = await created(h);
		expect((await stored(h, a.session.id)).purgeAt).toBe(
			new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		);
		expect((await h.store.getIdempotency("net-a", CREATE.idempotencyKey))?.purgeAt).toBe(
			new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		);
		await redeemAs(h, a.handoffToken ?? "", BROWSER);
		expect((await stored(h, a.session.id)).purgeAt).toBe(
			new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		);
		h.clock.advance(HOUR_MS);
		expect((await cancelAgentSession(h.deps, keyed(a.session.id, "c"))).ok).toBe(true);
		expect((await stored(h, a.session.id)).purgeAt).toBe(
			new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		);
		h.clock.advance(2 * DAY_MS - HOUR_MS);
		const b = await createAgentSession(h.deps, {
			...CREATE,
			idempotencyKey: "k-b",
			content: content(),
		});
		if (!b.ok) throw new Error("create failed");
		h.clock.advance(2 * HOUR_MS);
		expect((await cancelAgentSession(h.deps, keyed(b.session.id, "c"))).ok).toBe(true);
		// An unredeemed one canceled keeps the short retention: an hour after expiry.
		expect((await stored(h, b.session.id)).purgeAt).toBe(
			new Date(T0.getTime() + 3 * DAY_MS + HOUR_MS).toISOString(),
		);
	});

	test("C: a hard per-network live bound at insert; cancel does not free a slot, expiry does", async () => {
		const h = harness({ maxLivePerNetwork: 2, maxCreatesPerNetwork: 100 });
		const make = (key: string, networkKey = "net-a") =>
			createAgentSession(h.deps, {
				idempotencyKey: key,
				fingerprint: key,
				networkKey,
				content: content(),
			});
		const one = await make("1");
		expect((await make("2")).ok).toBe(true);
		expect(await make("3")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect((await make("4", "net-b")).ok).toBe(true);
		if (!one.ok) throw new Error("create failed");
		expect((await cancelAgentSession(h.deps, keyed(one.session.id, "c"))).ok).toBe(true);
		expect(await make("5")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		h.clock.advance(DAY_MS);
		expect((await make("6")).ok).toBe(true);
	});

	test("C: the defaults: 500 live, 50 live per network, 60 creates per network per hour", () => {
		expect(DEFAULT_AGENT_SESSION_LIMITS).toEqual({
			maxLiveSessions: 500,
			maxLivePerNetwork: 50,
			maxCreatesPerNetwork: 60,
			createWindowMs: HOUR_MS,
			maxLineQuantity: 10_000,
		});
	});

	test("C: a refused insert's record release cannot delete a record an orphan finisher adopted", async () => {
		const h = harness({ maxLiveSessions: 1 });
		const blocker = await created(h);
		// A's create puts its record, then its insert is refused (full). Before A
		// releases, B (same key) adopts the record and the capacity frees.
		let adopted = false;
		const racing: AgentSessionStore = {
			...bindStore(h.store),
			occupiedSlots: async () => ({ store: 0, network: 0 }),
			releaseIdempotency: async (networkKey, key, attemptId, now) => {
				if (!adopted) {
					adopted = true;
					expect((await cancelAgentSession(h.deps, keyed(blocker.session.id, "c"))).ok).toBe(true);
					h.clock.advance(DAY_MS);
					const b = await createAgentSession(h.deps, {
						idempotencyKey: "k-adopt",
						fingerprint: "fp",
						networkKey: "net-b",
						content: content(),
					});
					expect(b.ok && !b.replayed).toBe(true);
				}
				return h.store.releaseIdempotency(networkKey, key, attemptId, now);
			},
		};
		const a = await createAgentSession(
			{ ...h.deps, store: racing },
			{ idempotencyKey: "k-adopt", fingerprint: "fp", networkKey: "net-b", content: content() },
		);
		expect(a).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		const record = await h.store.getIdempotency("net-b", "k-adopt");
		expect(record).not.toBeNull();
		expect(await h.store.get(record?.sessionId ?? agentSessionId("cs_x"))).not.toBeNull();
	});

	test("F: an orphan finisher that loses the record (released or adopted away) writes nothing: WRITE_CONFLICT", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_lostadopt000000000000");
		await h.store.putIdempotency({
			networkKey: "net-a",
			attemptId: "attempt-test",
			key: "k-lost",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		});
		const losing: AgentSessionStore = {
			...bindStore(h.store),
			adoptIdempotency: async (networkKey, key) => {
				await h.store.releaseIdempotency(networkKey, key, "attempt-test", T0.toISOString());
				return "lost";
			},
		};
		expect(
			await createAgentSession(
				{ ...h.deps, store: losing },
				{ idempotencyKey: "k-lost", fingerprint: "fp", networkKey: "net-a", content: content() },
			),
		).toEqual({ ok: false, reason: "WRITE_CONFLICT" });
		expect(await h.store.get(sessionId)).toBeNull();
		// The retry starts over from what is stored: the key is free, a fresh create.
		const retry = await createAgentSession(h.deps, {
			idempotencyKey: "k-lost",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(retry.ok && !retry.replayed).toBe(true);
	});

	test("F: cancel is allowed during a live claim, and the claim's finalize then fails canceled", async () => {
		const h = harness();
		const first = await created(h);
		const claim = await claimAgentHandoff(h.deps, {
			token: first.handoffToken ?? "",
			redeemer: BROWSER,
		});
		if (!claim.ok || claim.status !== "claimed") throw new Error("claim failed");
		const c = await cancelAgentSession(h.deps, keyed(first.session.id, "c"));
		expect(c.ok && c.session.status).toBe("canceled");
		expect(
			await finalizeAgentHandoff(h.deps, {
				sessionId: first.session.id,
				claimId: claim.claimId,
				cartId: SHOPPER_CART,
			}),
		).toEqual({ ok: false, reason: "HANDOFF_CANCELED" });
	});

	test("F: a lapsed claim finalizes only within a short grace after its lease, and never after expiresAt", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		const fin = (claimId: string) =>
			finalizeAgentHandoff(h.deps, { sessionId: first.session.id, claimId, cartId: SHOPPER_CART });
		const c1 = await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		if (!c1.ok || c1.status !== "claimed") throw new Error("claim failed");
		h.clock.advance(AGENT_HANDOFF_CLAIM_LEASE_MS + AGENT_HANDOFF_FINALIZE_GRACE_MS);
		expect(await fin(c1.claimId)).toEqual({ ok: false, reason: "HANDOFF_CLAIM_LOST" });
		// Claimed again a few seconds before the session expires: finalize after expiry fails.
		h.clock.advance(T0.getTime() + DAY_MS - 5000 - h.clock.now().getTime());
		const c2 = await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		if (!c2.ok || c2.status !== "claimed") throw new Error("claim failed");
		h.clock.advance(5000);
		expect(await fin(c2.claimId)).toEqual({ ok: false, reason: "HANDOFF_EXPIRED" });
		expect((await stored(h, first.session.id)).handoffUsedAt).toBeUndefined();
	});

	test("F: order record, finalize and release read purge-aware", async () => {
		const h = harness();
		const first = await created(h);
		const claim = await claimAgentHandoff(h.deps, {
			token: first.handoffToken ?? "",
			redeemer: BROWSER,
		});
		if (!claim.ok || claim.status !== "claimed") throw new Error("claim failed");
		h.clock.advance(DAY_MS + HOUR_MS);
		const id = first.session.id;
		expect(
			await finalizeAgentHandoff(h.deps, { sessionId: id, claimId: claim.claimId, cartId: "c" }),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
		expect(
			await releaseAgentHandoffClaim(h.deps, { sessionId: id, claimId: claim.claimId }),
		).toEqual({ ok: true, released: false });
		expect(
			await recordAgentSessionOrder(h.deps, { sessionId: id, orderId: orderId("ord-1") }),
		).toEqual({ ok: false, reason: "SESSION_NOT_FOUND" });
		expect((await h.store.get(id))?.handoffClaim?.claimId).toBe(claim.claimId);
	});

	test("F: a store refusing a claim or finalize as too large answers HANDOFF_UNAVAILABLE", async () => {
		const h = harness();
		const first = await created(h);
		const tooLarge: AgentSessionStore = {
			...bindStore(h.store),
			claimHandoff: async () => ({ ok: false, reason: "too_large" }),
			finalizeHandoff: async () => ({ ok: false, reason: "too_large" }),
		};
		const deps = { ...h.deps, store: tooLarge };
		expect(
			await claimAgentHandoff(deps, { token: first.handoffToken ?? "", redeemer: BROWSER }),
		).toEqual({ ok: false, reason: "HANDOFF_UNAVAILABLE" });
		expect(
			await finalizeAgentHandoff(deps, { sessionId: first.session.id, claimId: "c", cartId: "x" }),
		).toEqual({ ok: false, reason: "HANDOFF_UNAVAILABLE" });
	});
});

describe("review round 4", () => {
	const BROWSER = "nonce-browser-1";

	async function redeem(h: Harness, token: string) {
		const claim = await claimAgentHandoff(h.deps, { token, redeemer: BROWSER });
		if (!claim.ok || claim.status !== "claimed") throw new Error("claim failed");
		const done = await finalizeAgentHandoff(h.deps, {
			sessionId: claim.session.id,
			claimId: claim.claimId,
			cartId: SHOPPER_CART,
		});
		if (!done.ok) throw new Error(`finalize failed: ${done.reason}`);
		return done;
	}

	const other = (h: Harness, networkKey: string, key = `k-${networkKey}`) =>
		createAgentSession(h.deps, {
			idempotencyKey: key,
			fingerprint: "fp",
			networkKey,
			content: content(),
		});

	test("2: a hand-off keeps its live slots; only a recorded order frees them; a cancel does not", async () => {
		const h = harness({ maxLiveSessions: 1, maxLivePerNetwork: 1 });
		const first = await created(h);
		expect(await other(h, "net-a", "k-2")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		await redeem(h, first.handoffToken ?? "");
		expect(await other(h, "net-a", "k-3")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(
			(
				await recordAgentSessionOrder(h.deps, {
					sessionId: first.session.id,
					orderId: orderId("o-1"),
				})
			).ok,
		).toBe(true);
		const second = await other(h, "net-a", "k-4");
		if (!second.ok) throw new Error("create after order failed");
		expect((await cancelAgentSession(h.deps, keyed(second.session.id, "c"))).ok).toBe(true);
		expect(await other(h, "net-b")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
	});

	test("4: the early refusal counts occupied slots (a canceled session's included): no insert is tried", async () => {
		const h = harness({ maxLiveSessions: 1 });
		const first = await created(h);
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "c"))).ok).toBe(true);
		let inserts = 0;
		const spy: AgentSessionStore = {
			...bindStore(h.store),
			insert: async (s, c) => {
				inserts++;
				return h.store.insert(s, c);
			},
		};
		expect(
			await createAgentSession(
				{ ...h.deps, store: spy },
				{ idempotencyKey: "k-x", fingerprint: "fp", networkKey: "net-b", content: content() },
			),
		).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(inserts).toBe(0);
		expect(await h.store.getIdempotency("net-b", "k-x")).toBeNull();
	});

	test("4: the early refusal counts the network's own slots too", async () => {
		const h = harness({ maxLivePerNetwork: 1 });
		await created(h);
		let inserts = 0;
		const spy: AgentSessionStore = {
			...bindStore(h.store),
			insert: async (s, c) => {
				inserts++;
				return h.store.insert(s, c);
			},
		};
		expect(
			await createAgentSession(
				{ ...h.deps, store: spy },
				{ idempotencyKey: "k-y", fingerprint: "fp", networkKey: "net-a", content: content() },
			),
		).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		expect(inserts).toBe(0);
	});

	test("5: a hand-off with no order keeps the short retention; a recorded order moves session and record to 30 days", async () => {
		const h = harness();
		const first = await created(h);
		await redeem(h, first.handoffToken ?? "");
		const short = new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString();
		expect((await stored(h, first.session.id)).purgeAt).toBe(short);
		expect((await h.store.getIdempotency("net-a", CREATE.idempotencyKey))?.purgeAt).toBe(short);
		h.clock.advance(HOUR_MS);
		expect(
			(
				await recordAgentSessionOrder(h.deps, {
					sessionId: first.session.id,
					orderId: orderId("o-1"),
				})
			).ok,
		).toBe(true);
		const long = new Date(T0.getTime() + 30 * DAY_MS).toISOString();
		expect((await stored(h, first.session.id)).purgeAt).toBe(long);
		expect((await h.store.getIdempotency("net-a", CREATE.idempotencyKey))?.purgeAt).toBe(long);
		// So the record survives the short sweep and the create still replays.
		h.clock.advance(2 * DAY_MS);
		await h.store.purgeIdempotencyDue(h.clock.now().toISOString(), 100);
		const again = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(again.ok && again.replayed).toBe(true);
	});

	test("5: an order is attributed only before the session expires; re-entry ends at expiry too", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		h.clock.advance(DAY_MS - 5 * 60 * 1000);
		await redeem(h, token);
		h.clock.advance(5 * 60 * 1000); // at expiresAt, inside the 15-minute re-entry window
		expect(await claimAgentHandoff(h.deps, { token, redeemer: BROWSER })).toEqual({
			ok: false,
			reason: "HANDOFF_EXPIRED",
		});
		expect(
			await recordAgentSessionOrder(h.deps, {
				sessionId: first.session.id,
				orderId: orderId("o-late"),
			}),
		).toEqual({ ok: false, reason: "SESSION_EXPIRED" });
	});

	test("6: a release refused busy (another attempt's insert is in flight) answers retryable WRITE_CONFLICT", async () => {
		const h = harness();
		const busy: AgentSessionStore = {
			...bindStore(h.store),
			insert: async () => ({ ok: false, reason: "capacity" }),
			releaseIdempotency: async () => "busy",
		};
		expect(
			await createAgentSession(
				{ ...h.deps, store: busy },
				{ idempotencyKey: "k-busy", fingerprint: "fp", networkKey: "net-a", content: content() },
			),
		).toEqual({ ok: false, reason: "WRITE_CONFLICT" });
	});

	test("6: an adoption refused busy answers retryable WRITE_CONFLICT and writes nothing", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_busyadopt0000000000000");
		await h.store.putIdempotency({
			networkKey: "net-a",
			attemptId: "attempt-test",
			key: "k-ad",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		});
		const busy: AgentSessionStore = { ...bindStore(h.store), adoptIdempotency: async () => "busy" };
		expect(
			await createAgentSession(
				{ ...h.deps, store: busy },
				{ idempotencyKey: "k-ad", fingerprint: "fp", networkKey: "net-a", content: content() },
			),
		).toEqual({ ok: false, reason: "WRITE_CONFLICT" });
		expect(await h.store.get(sessionId)).toBeNull();
	});

	test("7: cancel after a hand-off never moves its purge (expiresAt + 1 h), even after expiry", async () => {
		const h = harness();
		const first = await created(h);
		await redeem(h, first.handoffToken ?? "");
		const before = (await stored(h, first.session.id)).purgeAt;
		expect(before).toBe(new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString());
		h.clock.advance(DAY_MS + 30 * 60 * 1000);
		expect((await cancelAgentSession(h.deps, keyed(first.session.id, "c"))).ok).toBe(true);
		const after = await stored(h, first.session.id);
		expect(after.status).toBe("canceled");
		expect(after.purgeAt).toBe(before);
	});

	test("8: a lowered cap refuses at once through the early count, while older slots run out", async () => {
		const h = harness({ maxLiveSessions: 3 });
		await created(h);
		expect((await other(h, "net-b")).ok).toBe(true);
		expect((await other(h, "net-c")).ok).toBe(true);
		h.deps.limits = { maxLiveSessions: 1 };
		expect(await other(h, "net-d")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
		h.clock.advance(DAY_MS);
		expect((await other(h, "net-e")).ok).toBe(true);
		expect(await other(h, "net-f")).toEqual({ ok: false, reason: "TOO_MANY_SESSIONS" });
	});
});

async function crashedCreate(h: Harness, sessionId: AgentSessionId): Promise<void> {
	await h.store.putIdempotency({
		networkKey: "net-a",
		attemptId: "attempt-test",
		key: "k-crash",
		fingerprint: "fp",
		sessionId,
		createdAt: T0.toISOString(),
		purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
	});
	const probe = await createAgentSession(h.deps, {
		idempotencyKey: "probe",
		fingerprint: "fp",
		networkKey: "net-a",
		content: content(),
	});
	if (!probe.ok) throw new Error("probe failed");
	const shape = await stored(h, probe.session.id);
	await h.store.insertCrashingBeforeLanding(
		{
			...shape,
			id: sessionId,
			orderSecretHash: `h(${h.secrets.orderSecret(sessionId)})`,
			handoffTokenHash: `h(${h.secrets.token(sessionId, shape.linkGeneration)})`,
			writes: shape.writes.map((w) => ({ ...w, key: "k-crash" })),
		},
		{ now: T0.toISOString(), maxLive: 500, maxLivePerNetwork: 50 },
	);
}

describe("review round 6", () => {
	test("a create whose insert crashed before landing: the replay lands it (retryable once), then replays", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_crashland000000000000");
		await crashedCreate(h, sessionId);
		h.clock.advance(2 * 60 * 1000);
		const req = {
			idempotencyKey: "k-crash",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		};
		const first = await createAgentSession(h.deps, req);
		expect(first).toEqual({ ok: false, reason: "WRITE_CONFLICT" });
		expect((await h.store.get(sessionId))?.id).toBe(sessionId);
		expect(await h.store.occupiedSlots("net-a", h.clock.now().toISOString())).toEqual({
			store: 2,
			network: 2,
		});
		const retry = await createAgentSession(h.deps, req);
		expect(retry.ok && retry.replayed).toBe(true);
	});

	test("a replay of a crashed create at a full pool is landed, not refused TOO_MANY_SESSIONS", async () => {
		const h = harness({ maxLiveSessions: 2, maxLivePerNetwork: 2 });
		const sessionId = agentSessionId("cs_crashfull000000000000");
		await crashedCreate(h, sessionId);
		h.clock.advance(2 * 60 * 1000);
		const req = {
			idempotencyKey: "k-crash",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		};
		expect(await createAgentSession(h.deps, req)).toEqual({ ok: false, reason: "WRITE_CONFLICT" });
		const retry = await createAgentSession(h.deps, req);
		expect(retry.ok && retry.replayed).toBe(true);
		// A fresh create is still refused at the full pool, and its key stays free.
		const fresh = { ...req, idempotencyKey: "k-fresh" };
		expect(await createAgentSession(h.deps, fresh)).toEqual({
			ok: false,
			reason: "TOO_MANY_SESSIONS",
		});
		expect(await h.store.getIdempotency("net-a", "k-fresh")).toBeNull();
	});

	test("an orphan create record replayed at a full pool is refused and kept under its id", async () => {
		const h = harness({ maxLiveSessions: 1 });
		const full = await createAgentSession(h.deps, {
			idempotencyKey: "k-full",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(full.ok).toBe(true);
		const orphan = agentSessionId("cs_orphanfull00000000000");
		await h.store.putIdempotency({
			networkKey: "net-a",
			attemptId: "attempt-test",
			key: "k-orphan",
			fingerprint: "fp",
			sessionId: orphan,
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		});
		const req = {
			idempotencyKey: "k-orphan",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		};
		expect(await createAgentSession(h.deps, req)).toEqual({
			ok: false,
			reason: "TOO_MANY_SESSIONS",
		});
		expect((await h.store.getIdempotency("net-a", "k-orphan"))?.sessionId).toBe(orphan);
		expect(await h.store.get(orphan)).toBeNull();
	});
});
