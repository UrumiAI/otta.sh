import { describe, expect, test } from "vitest";
import {
	agentSessionId,
	claimAgentHandoff,
	createAgentSession,
	currency,
	detachAgentSessionCart,
	finalizeAgentHandoff,
	precheckAgentSessionCreate,
	precheckAgentSessionReplace,
	productId,
	replaceAgentSession,
	sku,
	type AgentCheckoutSession,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionId,
} from "@urumi.ai/otta-domain";
import { FixedClock, InMemoryAgentSessionStore } from "@urumi.ai/otta-domain/testing";
import { FakeSecrets } from "./fake-secrets.js";

/**
 * The plugin's own steps around the session use-cases (#712): prechecks before
 * cart work, recorded write messages, and detaching the agent's cart.
 */

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

function content(overrides: Partial<AgentSessionContent> = {}): AgentSessionContent {
	return { currency: USD, lines: [mug], ...overrides };
}

const CREATE = { idempotencyKey: "create-1", fingerprint: "fp-create-1", networkKey: "net-a" };

async function created(h: Harness, c: AgentSessionContent = content()) {
	const r = await createAgentSession(h.deps, { ...CREATE, content: c });
	if (!r.ok || r.replayed) throw new Error("create failed");
	return r;
}

function keyed(sessionId: AgentSessionId, key: string) {
	return { sessionId, idempotencyKey: key, fingerprint: `fp-${key}` };
}

async function stored(h: Harness, id: AgentSessionId): Promise<AgentCheckoutSession> {
	const s = await h.store.get(id);
	if (s === null) throw new Error("missing session");
	return s;
}

/** Claim, then finalize into a shopper cart: a whole successful redeem. */
async function redeemAgentHandoff(
	deps: AgentSessionDeps,
	input: { token: string },
): Promise<{ ok: boolean }> {
	const claim = await claimAgentHandoff(deps, { token: input.token, redeemer: "nonce" });
	if (!claim.ok || claim.status !== "claimed") return { ok: false };
	return finalizeAgentHandoff(deps, {
		sessionId: claim.session.id,
		claimId: claim.claimId,
		cartId: "cart-shopper",
	});
}

describe("prechecks: decide before any side work (ADR-0047)", () => {
	test("create: a fresh key proceeds; a replay answers the stored session; another body is refused; the caps refuse", async () => {
		const h = harness({ maxLiveSessions: 1 });
		expect(await precheckAgentSessionCreate(h.deps, CREATE)).toEqual({ proceed: true });
		const first = await created(h);
		const replay = await precheckAgentSessionCreate(h.deps, CREATE);
		expect(replay).toEqual({
			proceed: false,
			result: {
				ok: true,
				replayed: true,
				session: first.session,
				orderSecret: first.orderSecret,
				handoffToken: first.handoffToken,
			},
		});
		expect(await precheckAgentSessionCreate(h.deps, { ...CREATE, fingerprint: "other" })).toEqual({
			proceed: false,
			result: { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" },
		});
		expect(
			await precheckAgentSessionCreate(h.deps, { ...CREATE, idempotencyKey: "create-2" }),
		).toEqual({ proceed: false, result: { ok: false, reason: "TOO_MANY_SESSIONS" } });
	});

	test("replace: proceeds while writable; replays without work; refuses a reused key, a handed-off or a missing session", async () => {
		const h = harness();
		const first = await created(h);
		const id = first.session.id;
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-1"))).toEqual({
			proceed: true,
		});
		const put = await replaceAgentSession(h.deps, { ...keyed(id, "put-1"), content: content() });
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-1"))).toEqual({
			proceed: false,
			result: { ...put, replayed: true },
		});
		// The create's key on a replace: reused, never a fresh write.
		expect(await precheckAgentSessionReplace(h.deps, { sessionId: id, ...CREATE })).toEqual({
			proceed: false,
			result: { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" },
		});
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-2"))).toEqual({
			proceed: false,
			result: { ok: false, reason: "SESSION_HANDED_OFF" },
		});
		expect(
			await precheckAgentSessionReplace(h.deps, keyed(agentSessionId("cs_missing"), "put-3")),
		).toEqual({ proceed: false, result: { ok: false, reason: "SESSION_NOT_FOUND" } });
	});
});

describe("recorded messages (codes and paths only) replay with their write", () => {
	const MSGS = [
		{ code: "OUT_OF_STOCK", path: "lines[1]" },
		{ code: "COUPON_NOT_FOUND", path: "couponCode" },
	];

	test("a create and a replace record their messages; each replay answers them", async () => {
		const h = harness();
		const first = await createAgentSession(h.deps, {
			...CREATE,
			content: content(),
			messages: MSGS,
		});
		expect(first).toMatchObject({ ok: true, replayed: false, messages: MSGS });
		const replay = await createAgentSession(h.deps, { ...CREATE, content: content() });
		expect(replay).toMatchObject({ ok: true, replayed: true, messages: MSGS });
		if (!first.ok) throw new Error("create failed");
		const id = first.session.id;
		const put = await replaceAgentSession(h.deps, {
			...keyed(id, "put-m"),
			content: content(),
			messages: [MSGS[0]!],
		});
		expect(put).toMatchObject({ ok: true, messages: [MSGS[0]] });
		expect(
			await replaceAgentSession(h.deps, { ...keyed(id, "put-m"), content: content() }),
		).toMatchObject({ ok: true, replayed: true, messages: [MSGS[0]] });
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-m"))).toMatchObject({
			proceed: false,
			result: { replayed: true, messages: [MSGS[0]] },
		});
		// None recorded: absent, not [].
		const plain = await replaceAgentSession(h.deps, { ...keyed(id, "put-n"), content: content() });
		expect(plain).not.toHaveProperty("messages");
	});

	test("a message that is not token-shaped, or too many, is INVALID_REQUEST and writes nothing", async () => {
		const h = harness();
		for (const messages of [
			[{ code: "out of stock", path: "lines[0]" }],
			[{ code: "OUT_OF_STOCK", path: "a@example.com" }],
			Array.from({ length: 65 }, () => ({ code: "X", path: "lines[0]" })),
		]) {
			expect(await createAgentSession(h.deps, { ...CREATE, content: content(), messages })).toEqual(
				{ ok: false, reason: "INVALID_REQUEST" },
			);
		}
		expect(await h.store.getIdempotency(CREATE.networkKey, CREATE.idempotencyKey)).toBeNull();
	});
});

describe("detachAgentSessionCart", () => {
	test("detaches the cart and its quote once; refused after a redeem", async () => {
		const h = harness();
		const first = await created(h, content({ cartId: "cart-a" }));
		const id = first.session.id;
		expect(await detachAgentSessionCart(h.deps, keyed(id, "put-d"))).toEqual({
			ok: true,
			detached: true,
			cartId: "cart-a",
		});
		const after = await stored(h, id);
		expect(after.cartId).toBeUndefined();
		expect(after.quote).toBeUndefined();
		expect(await detachAgentSessionCart(h.deps, keyed(id, "put-d"))).toEqual({
			ok: true,
			detached: true,
		});
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		expect(await detachAgentSessionCart(h.deps, keyed(id, "put-e"))).toEqual({
			ok: false,
			reason: "SESSION_HANDED_OFF",
		});
	});

	test("a key already recorded never detaches: the same body replays (even after a redeem), another is IDEMPOTENCY_KEY_REUSED", async () => {
		const h = harness();
		const first = await created(h, content({ cartId: "cart-a" }));
		const id = first.session.id;
		const put = await replaceAgentSession(h.deps, {
			...keyed(id, "put-1"),
			content: content({ cartId: "cart-b" }),
		});
		expect(put.ok).toBe(true);
		// The duplicate racing the first: nothing detached, the first's answer.
		expect(await detachAgentSessionCart(h.deps, keyed(id, "put-1"))).toEqual({
			ok: true,
			detached: false,
			replay: { ...put, replayed: true },
		});
		expect((await stored(h, id)).cartId).toBe("cart-b");
		expect(
			await detachAgentSessionCart(h.deps, {
				sessionId: id,
				idempotencyKey: "put-1",
				fingerprint: "other",
			}),
		).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		// A same-key retry after a redeem replays the first answer, not SESSION_HANDED_OFF.
		expect((await redeemAgentHandoff(h.deps, { token: first.handoffToken ?? "" })).ok).toBe(true);
		const late = await detachAgentSessionCart(h.deps, keyed(id, "put-1"));
		expect(late).toMatchObject({ ok: true, detached: false, replay: { ok: true, replayed: true } });
		expect((await stored(h, id)).cartId).toBe("cart-b");
	});
});

describe("prechecks and detach under the claim-then-finalize redeem", () => {
	test("a live claim refuses a replace precheck and a detach HANDOFF_IN_PROGRESS; a lapsed one does not", async () => {
		const h = harness();
		const first = await created(h, content({ cartId: "cart-a" }));
		const id = first.session.id;
		const claim = await claimAgentHandoff(h.deps, {
			token: first.handoffToken ?? "",
			redeemer: "nonce",
		});
		expect(claim).toMatchObject({ ok: true, status: "claimed", agentCartId: "cart-a" });
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-1"))).toEqual({
			proceed: false,
			result: { ok: false, reason: "HANDOFF_IN_PROGRESS" },
		});
		expect(await detachAgentSessionCart(h.deps, keyed(id, "put-1"))).toEqual({
			ok: false,
			reason: "HANDOFF_IN_PROGRESS",
		});
		expect((await stored(h, id)).cartId).toBe("cart-a");
		h.clock.advance(2 * 60 * 1000);
		expect(await precheckAgentSessionReplace(h.deps, keyed(id, "put-1"))).toEqual({
			proceed: true,
		});
	});

	test("a create precheck on a purge-due record or session is expired; an orphan record proceeds", async () => {
		const h = harness();
		await created(h);
		h.clock.advance(DAY_MS + HOUR_MS);
		expect(await precheckAgentSessionCreate(h.deps, CREATE)).toEqual({
			proceed: false,
			result: { ok: false, reason: "IDEMPOTENCY_KEY_EXPIRED" },
		});
		const fresh = harness({ maxLiveSessions: 1 });
		await created(fresh);
		await fresh.store.putIdempotency({
			networkKey: "net-a",
			key: "orphan",
			fingerprint: "fp-o",
			sessionId: agentSessionId("cs_never_written"),
			attemptId: "a-1",
			createdAt: T0.toISOString(),
			purgeAt: new Date(T0.getTime() + DAY_MS + HOUR_MS).toISOString(),
		});
		// The pool is full, but an orphan's create adopts before any cap check.
		expect(
			await precheckAgentSessionCreate(fresh.deps, {
				...CREATE,
				idempotencyKey: "orphan",
				fingerprint: "fp-o",
			}),
		).toEqual({ proceed: true });
	});
});
