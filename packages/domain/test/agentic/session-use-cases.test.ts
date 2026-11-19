import { describe, expect, test } from "vitest";
import {
	AGENT_SESSION_MAX_LINES,
	agentSessionId,
	cancelSession,
	cents,
	completeSession,
	createSession,
	currency,
	getSession,
	issueHandoff,
	productId,
	redeemHandoff,
	replaceSession,
	sku,
	verifyOrderSecret,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionSecrets,
} from "@urumi.ai/otta-domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryAgentSessionStore,
} from "@urumi.ai/otta-domain/testing";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = new Date("2026-11-18T10:00:00.000Z");
const USD = currency("USD");

/** Deterministic secrets: counted tokens, a reversible "hash" that is never the token. */
class FakeSecrets implements AgentSessionSecrets {
	#n = 0;
	mintToken(): string {
		return `tok-${++this.#n}`;
	}
	async hash(token: string): Promise<string> {
		return `h(${token})`;
	}
	constantTimeEqual(a: string, b: string): boolean {
		let diff = a.length ^ b.length;
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
		}
		return diff === 0;
	}
}

function harness(limits?: AgentSessionDeps["limits"]) {
	const clock = new FixedClock(T0);
	const store = new InMemoryAgentSessionStore();
	const deps: AgentSessionDeps = {
		store,
		clock,
		idGen: new CountingIdGen("r"),
		secrets: new FakeSecrets(),
	};
	if (limits !== undefined) deps.limits = limits;
	return { clock, store, deps };
}

const mug = { productId: productId("p-mug"), sku: sku("MUG-1"), quantity: 2 };
const bowl = { productId: productId("p-bowl"), sku: sku("BOWL-1"), quantity: 1 };

function content(overrides: Partial<AgentSessionContent> = {}): AgentSessionContent {
	return { currency: USD, lines: [mug], ...overrides };
}

async function created(h: ReturnType<typeof harness>, c: AgentSessionContent = content()) {
	const r = await createSession(h.deps, {
		idempotencyKey: "create-1",
		fingerprint: "fp-create-1",
		networkKey: "net-a",
		content: c,
	});
	if (!r.ok || r.replayed) throw new Error("create failed");
	return r;
}

describe("createSession", () => {
	test("mints a cs_ session: 24 h expiry, 30 d purge, channel other, hashes only", async () => {
		const h = harness();
		const r = await created(h);
		expect(r.session.id.startsWith("cs_")).toBe(true);
		expect(r.session.status).toBe("requires_escalation");
		expect(r.session.channel).toBe("other");
		expect(r.session.createdAt).toBe(T0.toISOString());
		expect(Date.parse(r.session.expiresAt) - T0.getTime()).toBe(DAY_MS);
		expect(Date.parse(r.session.purgeAt) - T0.getTime()).toBe(30 * DAY_MS);
		expect(r.handoffToken).toBeDefined();
		expect(r.session.orderSecretHash).toBe(`h(${r.orderSecret})`);
		expect(r.session.handoffTokenHash).toBe(`h(${r.handoffToken})`);
		expect(JSON.stringify(r.session)).not.toContain(`"${r.orderSecret}"`);
		expect(JSON.stringify(r.session)).not.toContain(`"${r.handoffToken}"`);
	});

	test("no lines → incomplete, with no hand-off link", async () => {
		const h = harness();
		const r = await created(h, content({ lines: [] }));
		expect(r.session.status).toBe("incomplete");
		expect(r.handoffToken).toBeUndefined();
		expect(r.session.handoffTokenHash).toBeUndefined();
	});

	test("an unquoted session has no quote (never a zero total); a given quote is kept", async () => {
		const h = harness();
		const unquoted = await created(h);
		expect(unquoted.session.quote).toBeUndefined();

		const quote = {
			currency: USD,
			subtotal: cents(3000),
			discount: cents(0),
			fulfillment: null,
			tax: null,
			total: cents(3000),
			quotedAt: T0.toISOString(),
		};
		const r = await createSession(h.deps, {
			idempotencyKey: "create-q",
			fingerprint: "fp-q",
			networkKey: "net-a",
			content: content({ quote, cartId: "cart-1" }),
		});
		expect(r.ok && r.session.quote).toEqual(quote);
		expect(r.ok && r.session.cartId).toBe("cart-1");
	});

	test("same key + same fingerprint replays the session without minting anything", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(1000);
		const again = await createSession(h.deps, {
			idempotencyKey: "create-1",
			fingerprint: "fp-create-1",
			networkKey: "net-a",
			content: content(),
		});
		expect(again).toEqual({ ok: true, replayed: true, session: first.session });
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
	});

	test("same key + different fingerprint → idempotency_key_reused, nothing written", async () => {
		const h = harness();
		await created(h);
		const r = await createSession(h.deps, {
			idempotencyKey: "create-1",
			fingerprint: "fp-different",
			networkKey: "net-a",
			content: content({ lines: [bowl] }),
		});
		expect(r).toEqual({ ok: false, code: "idempotency_key_reused" });
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
	});

	test("a create recorded but never written is finished by its replay", async () => {
		const h = harness();
		const sessionId = agentSessionId("cs_crashed");
		await h.store.putIdempotency({
			key: "k-crash",
			fingerprint: "fp",
			sessionId,
			createdAt: T0.toISOString(),
		});
		const r = await createSession(h.deps, {
			idempotencyKey: "k-crash",
			fingerprint: "fp",
			networkKey: "net-a",
			content: content(),
		});
		expect(r.ok && !r.replayed && r.session.id).toBe(sessionId);
	});

	test("racing creates with one key make one session", async () => {
		const h = harness();
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				createSession(h.deps, {
					idempotencyKey: "k-race",
					fingerprint: "fp",
					networkKey: "net-a",
					content: content(),
				}),
			),
		);
		const ids = new Set(results.map((r) => (r.ok ? r.session.id : r.code)));
		expect(ids.size).toBe(1);
		expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
		expect(await h.store.countLive(T0.toISOString())).toBe(1);
	});

	test("refuses bad lines and a quote in another currency", async () => {
		const h = harness();
		const base = { fingerprint: "fp", networkKey: "net-a" };
		const tooMany = Array.from({ length: AGENT_SESSION_MAX_LINES + 1 }, (_, i) => ({
			productId: productId(`p${i}`),
			sku: sku(`S${i}`),
			quantity: 1,
		}));
		expect(
			await createSession(h.deps, {
				...base,
				idempotencyKey: "a",
				content: content({ lines: tooMany }),
			}),
		).toEqual({ ok: false, code: "invalid_request", reason: "too_many_lines" });
		for (const quantity of [0, -1, 1.5, 10_001]) {
			expect(
				await createSession(h.deps, {
					...base,
					idempotencyKey: `q${quantity}`,
					content: content({ lines: [{ ...mug, quantity }] }),
				}),
			).toEqual({ ok: false, code: "invalid_request", reason: "invalid_quantity" });
		}
		expect(
			await createSession(h.deps, {
				...base,
				idempotencyKey: "d",
				content: content({ lines: [mug, mug] }),
			}),
		).toEqual({ ok: false, code: "invalid_request", reason: "duplicate_sku" });
		const eurQuote = {
			currency: currency("EUR"),
			subtotal: cents(1),
			discount: cents(0),
			fulfillment: null,
			tax: null,
			total: cents(1),
			quotedAt: T0.toISOString(),
		};
		expect(
			await createSession(h.deps, {
				...base,
				idempotencyKey: "e",
				content: content({ quote: eurQuote }),
			}),
		).toEqual({ ok: false, code: "invalid_request", reason: "quote_currency_mismatch" });
		expect(
			await createSession(h.deps, { ...base, idempotencyKey: "", content: content() }),
		).toEqual({ ok: false, code: "invalid_request", reason: "idempotency_key_missing" });
		expect(await h.store.countLive(T0.toISOString())).toBe(0);
	});

	test("per-network create cap within the window, then it lapses", async () => {
		const h = harness({ maxCreatesPerNetwork: 2 });
		const make = (key: string, networkKey = "net-a") =>
			createSession(h.deps, {
				idempotencyKey: key,
				fingerprint: key,
				networkKey,
				content: content(),
			});
		expect((await make("1")).ok).toBe(true);
		expect((await make("2")).ok).toBe(true);
		expect(await make("3")).toEqual({ ok: false, code: "rate_limited" });
		expect((await make("4", "net-b")).ok).toBe(true);
		h.clock.advance(HOUR_MS + 1);
		expect((await make("5")).ok).toBe(true);
	});

	test("store-wide cap on live sessions", async () => {
		const h = harness({ maxLiveSessions: 1 });
		await created(h);
		const r = await createSession(h.deps, {
			idempotencyKey: "other",
			fingerprint: "x",
			networkKey: "net-b",
			content: content(),
		});
		expect(r).toEqual({ ok: false, code: "too_many_sessions" });
	});
});

describe("replaceSession", () => {
	test("full replacement: absent fields are cleared, status follows lines, old link dies", async () => {
		const h = harness();
		const first = await created(h, content({ couponCode: "SAVE", shippingMethodId: "std" }));
		const r = await replaceSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "put-1",
			fingerprint: "fp-put-1",
			content: content({ lines: [bowl] }),
		});
		expect(r.ok && !r.replayed).toBe(true);
		if (!r.ok || r.replayed) return;
		expect(r.session.lines).toEqual([bowl]);
		expect(r.session.couponCode).toBeUndefined();
		expect(r.session.shippingMethodId).toBeUndefined();
		expect(r.session.status).toBe("requires_escalation");
		expect(r.handoffToken).toBeDefined();
		expect(r.handoffToken).not.toBe(first.handoffToken);
		expect(await redeemHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			code: "handoff_invalid",
		});

		const emptied = await replaceSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "put-2",
			fingerprint: "fp-put-2",
			content: content({ lines: [] }),
		});
		expect(emptied.ok && emptied.session.status).toBe("incomplete");
		expect(emptied.ok && emptied.session.handoffTokenHash).toBeUndefined();
	});

	test("replay answers the session; a reused key with another body is refused", async () => {
		const h = harness();
		const first = await created(h);
		const put = {
			sessionId: first.session.id,
			idempotencyKey: "put-1",
			fingerprint: "fp-put-1",
			content: content({ lines: [bowl] }),
		};
		const applied = await replaceSession(h.deps, put);
		const replay = await replaceSession(h.deps, put);
		expect(replay).toEqual({ ok: true, replayed: true, session: applied.ok && applied.session });

		const conflict = await replaceSession(h.deps, { ...put, fingerprint: "fp-other" });
		expect(conflict).toEqual({ ok: false, code: "idempotency_key_reused" });
		const crossOp = await cancelSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "put-1",
			fingerprint: "fp-put-1",
		});
		expect(crossOp).toEqual({ ok: false, code: "idempotency_key_reused" });
		// The create's own key cannot be reused for an update either.
		const createKey = await replaceSession(h.deps, { ...put, idempotencyKey: "create-1" });
		expect(createKey).toEqual({ ok: false, code: "idempotency_key_reused" });
		expect((await getSession(h.deps, { sessionId: first.session.id })).ok).toBe(true);
	});

	test("refuses an unknown, canceled or expired session", async () => {
		const h = harness();
		const first = await created(h);
		const put = (key: string) =>
			replaceSession(h.deps, {
				sessionId: first.session.id,
				idempotencyKey: key,
				fingerprint: key,
				content: content(),
			});
		expect(
			await replaceSession(h.deps, {
				sessionId: agentSessionId("cs_nope"),
				idempotencyKey: "k",
				fingerprint: "k",
				content: content(),
			}),
		).toEqual({ ok: false, code: "session_not_found" });
		h.clock.advance(DAY_MS);
		expect(await put("late")).toEqual({ ok: false, code: "session_expired" });
		await cancelSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "c",
			fingerprint: "c",
		});
		expect(await put("after-cancel")).toEqual({ ok: false, code: "session_closed" });
	});
});

describe("completeSession", () => {
	test("never completes: answers requires_escalation with a fresh link", async () => {
		const h = harness();
		const first = await created(h);
		const r = await completeSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "done-1",
			fingerprint: "fp-done",
		});
		expect(r.ok && !r.replayed).toBe(true);
		if (!r.ok || r.replayed) return;
		expect(r.session.status).toBe("requires_escalation");
		expect(r.handoffToken).toBeDefined();
		expect((await getSession(h.deps, { sessionId: first.session.id })).ok && r.session.status).toBe(
			"requires_escalation",
		);
		const redeemed = await redeemHandoff(h.deps, { token: r.handoffToken ?? "" });
		expect(redeemed.ok).toBe(true);
	});

	test("a session with no lines is session_incomplete", async () => {
		const h = harness();
		const first = await created(h, content({ lines: [] }));
		expect(
			await completeSession(h.deps, {
				sessionId: first.session.id,
				idempotencyKey: "done",
				fingerprint: "f",
			}),
		).toEqual({ ok: false, code: "session_incomplete" });
	});
});

describe("hand-off link", () => {
	test("redeems once; the second redeem fails typed", async () => {
		const h = harness();
		const first = await created(h);
		const token = first.handoffToken ?? "";
		h.clock.advance(5000);
		const r = await redeemHandoff(h.deps, { token });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.session.lines).toEqual([mug]);
		expect(r.session.handoffUsedAt).toBe(new Date(T0.getTime() + 5000).toISOString());
		expect(await redeemHandoff(h.deps, { token })).toEqual({ ok: false, code: "handoff_used" });
	});

	test("racing redeems: exactly one wins", async () => {
		const h = harness();
		const first = await created(h);
		const results = await Promise.all(
			Array.from({ length: 6 }, () => redeemHandoff(h.deps, { token: first.handoffToken ?? "" })),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const r of results) if (!r.ok) expect(r.code).toBe("handoff_used");
	});

	test("a wrong token fails typed and changes nothing", async () => {
		const h = harness();
		const first = await created(h);
		const before = await h.store.get(first.session.id);
		expect(await redeemHandoff(h.deps, { token: "tok-guess" })).toEqual({
			ok: false,
			code: "handoff_invalid",
		});
		expect(await redeemHandoff(h.deps, { token: "" })).toEqual({
			ok: false,
			code: "handoff_invalid",
		});
		expect(await h.store.get(first.session.id)).toEqual(before);
	});

	test("expires 24 h after create, failing typed without mutating", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(DAY_MS - 1);
		const before = await h.store.get(first.session.id);
		h.clock.advance(1);
		expect(await redeemHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			code: "handoff_expired",
		});
		expect(await h.store.get(first.session.id)).toEqual(before);
	});

	test("a link still works one millisecond before expiry", async () => {
		const h = harness();
		const first = await created(h);
		h.clock.advance(DAY_MS - 1);
		expect((await redeemHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
	});

	test("cancel kills the link", async () => {
		const h = harness();
		const first = await created(h);
		const c = await cancelSession(h.deps, {
			sessionId: first.session.id,
			idempotencyKey: "cancel-1",
			fingerprint: "fp-c",
		});
		expect(c.ok && c.session.status).toBe("canceled");
		const before = await h.store.get(first.session.id);
		expect(await redeemHandoff(h.deps, { token: first.handoffToken ?? "" })).toEqual({
			ok: false,
			code: "handoff_canceled",
		});
		expect(await h.store.get(first.session.id)).toEqual(before);
		expect(await issueHandoff(h.deps, { sessionId: first.session.id })).toEqual({
			ok: false,
			code: "session_closed",
		});
	});

	test("issueHandoff rotates the link: only the new one redeems, and a used session gets a new one", async () => {
		const h = harness();
		const first = await created(h);
		const old = first.handoffToken ?? "";
		expect((await redeemHandoff(h.deps, { token: old })).ok).toBe(true);
		const issued = await issueHandoff(h.deps, { sessionId: first.session.id });
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		expect(issued.session.handoffTokenHash).toBe(`h(${issued.handoffToken})`);
		expect(issued.session.handoffUsedAt).toBeUndefined();
		expect(await redeemHandoff(h.deps, { token: old })).toEqual({
			ok: false,
			code: "handoff_invalid",
		});
		expect((await redeemHandoff(h.deps, { token: issued.handoffToken })).ok).toBe(true);
	});

	test("issueHandoff refuses an incomplete or expired session", async () => {
		const h = harness();
		const empty = await created(h, content({ lines: [] }));
		expect(await issueHandoff(h.deps, { sessionId: empty.session.id })).toEqual({
			ok: false,
			code: "session_incomplete",
		});
		h.clock.advance(DAY_MS);
		expect(await issueHandoff(h.deps, { sessionId: empty.session.id })).toEqual({
			ok: false,
			code: "session_expired",
		});
	});
});

describe("cancelSession", () => {
	test("replays on its key; canceling again under a new key answers it canceled", async () => {
		const h = harness();
		const first = await created(h);
		const req = { sessionId: first.session.id, idempotencyKey: "c1", fingerprint: "f" };
		const a = await cancelSession(h.deps, req);
		expect(a.ok && !a.replayed).toBe(true);
		expect(await cancelSession(h.deps, req)).toEqual({
			ok: true,
			replayed: true,
			session: a.ok && a.session,
		});
		const b = await cancelSession(h.deps, { ...req, idempotencyKey: "c2" });
		expect(b.ok && b.session.status).toBe("canceled");
	});
});

describe("verifyOrderSecret", () => {
	test("accepts the secret returned at create; refuses wrong, empty and unknown alike", async () => {
		const h = harness();
		const first = await created(h);
		const ok = await verifyOrderSecret(h.deps, {
			sessionId: first.session.id,
			secret: first.orderSecret,
		});
		expect(ok.ok && ok.session.id).toBe(first.session.id);
		const invalid = { ok: false, code: "order_secret_invalid" };
		expect(
			await verifyOrderSecret(h.deps, { sessionId: first.session.id, secret: "wrong" }),
		).toEqual(invalid);
		expect(await verifyOrderSecret(h.deps, { sessionId: first.session.id, secret: "" })).toEqual(
			invalid,
		);
		expect(
			await verifyOrderSecret(h.deps, {
				sessionId: agentSessionId("cs_unknown"),
				secret: first.orderSecret,
			}),
		).toEqual(invalid);
	});
});
