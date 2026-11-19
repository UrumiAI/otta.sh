import { describe, expect, test } from "vitest";
import {
	agentSessionId,
	type AgentCheckoutSession,
	type AgentSessionId,
} from "../agentic/model.js";
import { currency } from "../money/cents.js";
import { productId, sku } from "../money/ids.js";
import type { AgentSessionStore } from "../ports/agent-session-store.js";

export interface AgentSessionStoreHarness {
	store: AgentSessionStore;
}

export interface AgentSessionStoreContractOptions {
	dialect: string;
}

const T0 = "2026-11-18T10:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function at(offsetMs: number): string {
	return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** A stored-shape session for the contract; `createdAt` defaults to {@link T0}. */
function sample(id: string, overrides: Partial<AgentCheckoutSession> = {}): AgentCheckoutSession {
	const createdAt = overrides.createdAt ?? T0;
	const created = Date.parse(createdAt);
	return {
		id: agentSessionId(id),
		revision: 0,
		status: "requires_escalation",
		currency: currency("USD"),
		lines: [{ productId: productId("p-1"), sku: sku("MUG-1"), quantity: 1 }],
		orderSecretHash: `secret-hash-${id}`,
		channel: "other",
		networkKey: "net-a",
		createdAt,
		updatedAt: createdAt,
		expiresAt: new Date(created + DAY_MS).toISOString(),
		purgeAt: new Date(created + 30 * DAY_MS).toISOString(),
		writes: [],
		...overrides,
	};
}

async function seed(
	store: AgentSessionStore,
	session: AgentCheckoutSession,
): Promise<AgentCheckoutSession> {
	const r = await store.write(session, null);
	if (!r.ok) throw new Error(`seed of ${session.id} lost`);
	return r.session;
}

/**
 * The `AgentSessionStore` behavioural spec (ADR-0047): compare-and-set writes,
 * the hashed hand-off index, the create idempotency index, the single-winner
 * hand-off mark, the counts behind the abuse limits, and the bounded purge.
 */
export function agentSessionStoreContract(
	makeHarness: () => Promise<AgentSessionStoreHarness>,
	options: AgentSessionStoreContractOptions,
): void {
	describe(`AgentSessionStore contract [${options.dialect}]`, () => {
		test("an unknown id reads null", async () => {
			const { store } = await makeHarness();
			expect(await store.get(agentSessionId("cs_missing"))).toBeNull();
		});

		test("insert wins once at revision 1; a second insert loses and sees the first", async () => {
			const { store } = await makeHarness();
			const first = await store.write(sample("cs_a", { couponCode: "ONE" }), null);
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			expect(first.session.revision).toBe(1);
			expect(await store.get(first.session.id)).toEqual(first.session);

			const second = await store.write(sample("cs_a", { couponCode: "TWO" }), null);
			expect(second).toEqual({ ok: false, current: first.session });
		});

		test("compare-and-set wins on the stored revision and loses on a stale one", async () => {
			const { store } = await makeHarness();
			const s1 = await seed(store, sample("cs_b"));
			const won = await store.write({ ...s1, couponCode: "NEW" }, 1);
			expect(won.ok).toBe(true);
			if (!won.ok) return;
			expect(won.session.revision).toBe(2);
			expect(won.session.couponCode).toBe("NEW");

			const stale = await store.write({ ...s1, couponCode: "STALE" }, 1);
			expect(stale).toEqual({ ok: false, current: won.session });
			expect((await store.get(s1.id))?.couponCode).toBe("NEW");
		});

		test("a compare-and-set against a missing session loses with null", async () => {
			const { store } = await makeHarness();
			expect(await store.write(sample("cs_none"), 1)).toEqual({ ok: false, current: null });
			expect(await store.get(agentSessionId("cs_none"))).toBeNull();
		});

		test("racing writes on one revision: exactly one wins", async () => {
			const { store } = await makeHarness();
			const s1 = await seed(store, sample("cs_race"));
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) => store.write({ ...s1, couponCode: `C${i}` }, 1)),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect((await store.get(s1.id))?.revision).toBe(2);
		});

		test("optional fields round-trip, and an absent one stays absent", async () => {
			const { store } = await makeHarness();
			const s = await seed(
				store,
				sample("cs_full", {
					buyer: { email: "shopper@example.test", firstName: "Ada" },
					destination: {
						name: "Ada L",
						line1: "1 Main St",
						line2: null,
						city: "Austin",
						region: "TX",
						postalCode: "78701",
						country: "US",
						email: null,
						phone: null,
					},
					shippingMethodId: "ship-std",
					cartId: "cart-1",
					writes: [{ key: "k", operation: "create", fingerprint: "f", revision: 1 }],
				}),
			);
			const read = await store.get(s.id);
			expect(read).toEqual(s);
			expect(read && "quote" in read).toBe(false);
			expect(read && "handoffTokenHash" in read).toBe(false);
		});

		test("a returned session is a copy: changing it changes nothing stored", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_copy"));
			s.lines.push({ productId: productId("p-2"), sku: sku("X"), quantity: 2 });
			const read = await store.get(s.id);
			expect(read?.lines).toHaveLength(1);
		});

		test("finds a session by its live hand-off token hash only", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_tok", { handoffTokenHash: "hash-1" }));
			expect((await store.findByHandoffTokenHash("hash-1"))?.id).toBe(s.id);
			expect(await store.findByHandoffTokenHash("hash-unknown")).toBeNull();

			const rotated = await store.write({ ...s, handoffTokenHash: "hash-2" }, s.revision);
			expect(rotated.ok).toBe(true);
			expect(await store.findByHandoffTokenHash("hash-1")).toBeNull();
			expect((await store.findByHandoffTokenHash("hash-2"))?.id).toBe(s.id);
		});

		test("finds the most recently created session for a cart", async () => {
			const { store } = await makeHarness();
			await seed(store, sample("cs_old", { cartId: "cart-x" }));
			await seed(store, sample("cs_new", { cartId: "cart-x", createdAt: at(60_000) }));
			await seed(store, sample("cs_other", { cartId: "cart-y" }));
			expect((await store.findByCartId("cart-x"))?.id).toBe("cs_new");
			expect(await store.findByCartId("cart-none")).toBeNull();
		});

		test("the create idempotency index is insert-if-absent", async () => {
			const { store } = await makeHarness();
			const record = {
				key: "idem-1",
				fingerprint: "fp-1",
				sessionId: agentSessionId("cs_i1"),
				createdAt: T0,
			};
			expect(await store.getIdempotency("idem-1")).toBeNull();
			expect(await store.putIdempotency(record)).toEqual({ stored: true });
			expect(await store.getIdempotency("idem-1")).toEqual(record);

			const again = await store.putIdempotency({
				...record,
				fingerprint: "fp-2",
				sessionId: agentSessionId("cs_i2"),
			});
			expect(again).toEqual({ stored: false, existing: record });
		});

		test("racing idempotency puts for one key: exactly one is stored", async () => {
			const { store } = await makeHarness();
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					store.putIdempotency({
						key: "idem-race",
						fingerprint: "fp",
						sessionId: agentSessionId(`cs_r${i}`),
						createdAt: T0,
					}),
				),
			);
			const winners = results.filter((r) => r.stored);
			expect(winners).toHaveLength(1);
			const stored = await store.getIdempotency("idem-race");
			for (const r of results) {
				if (!r.stored) expect(r.existing).toEqual(stored);
			}
		});

		test("markHandoffUsed: racing marks have exactly one winner", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_mark", { handoffTokenHash: "h" }));
			const results = await Promise.all(
				Array.from({ length: 8 }, () => store.markHandoffUsed(s.id, "h", at(1000))),
			);
			const winners = results.filter((r) => r.ok);
			expect(winners).toHaveLength(1);
			for (const r of results) {
				if (!r.ok) expect(r.reason).toBe("already_used");
			}
			const read = await store.get(s.id);
			expect(read?.handoffUsedAt).toBe(at(1000));
			expect(read?.revision).toBeGreaterThan(s.revision);
		});

		test("markHandoffUsed refuses a wrong hash, a closed session and an unknown id", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_m2", { handoffTokenHash: "h" }));
			expect(await store.markHandoffUsed(s.id, "other", T0)).toEqual({
				ok: false,
				reason: "token_mismatch",
			});
			const canceled = await seed(
				store,
				sample("cs_m3", { handoffTokenHash: "h3", status: "canceled" }),
			);
			expect(await store.markHandoffUsed(canceled.id, "h3", T0)).toEqual({
				ok: false,
				reason: "closed",
			});
			expect(await store.markHandoffUsed(agentSessionId("cs_zz"), "h", T0)).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect((await store.get(s.id))?.handoffUsedAt).toBeUndefined();
			expect((await store.get(canceled.id))?.handoffUsedAt).toBeUndefined();
		});

		test("countLive counts open, unexpired sessions", async () => {
			const { store } = await makeHarness();
			await seed(store, sample("cs_l1"));
			await seed(store, sample("cs_l2", { status: "incomplete", lines: [] }));
			await seed(store, sample("cs_l3", { status: "canceled" }));
			await seed(store, sample("cs_l4", { status: "completed" }));
			await seed(store, sample("cs_l5", { createdAt: at(-2 * DAY_MS) }));
			expect(await store.countLive(at(1000))).toBe(2);
			expect(await store.countLive(at(DAY_MS))).toBe(0);
		});

		test("countCreatedSince counts one network's creates from a time on", async () => {
			const { store } = await makeHarness();
			await seed(store, sample("cs_n1", { networkKey: "net-a" }));
			await seed(store, sample("cs_n2", { networkKey: "net-a", createdAt: at(30 * 60_000) }));
			await seed(store, sample("cs_n3", { networkKey: "net-b", createdAt: at(30 * 60_000) }));
			expect(await store.countCreatedSince("net-a", T0)).toBe(2);
			expect(await store.countCreatedSince("net-a", at(1))).toBe(1);
			expect(await store.countCreatedSince("net-b", T0)).toBe(1);
			expect(await store.countCreatedSince("net-c", T0)).toBe(0);
		});

		test("listPurgeDue lists only due sessions, at most the limit", async () => {
			const { store } = await makeHarness();
			for (let i = 0; i < 5; i++) {
				await seed(store, sample(`cs_p${i}`, { createdAt: at(-31 * DAY_MS) }));
			}
			await seed(store, sample("cs_fresh"));
			const now = at(0);
			const first = await store.listPurgeDue(now, 3);
			expect(first).toHaveLength(3);
			const all = await store.listPurgeDue(now, 100);
			expect(new Set<AgentSessionId>(all)).toEqual(
				new Set(["cs_p0", "cs_p1", "cs_p2", "cs_p3", "cs_p4"]),
			);
		});

		test("purge deletes a due session and its create record; not before purgeAt", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_purge"));
			await store.putIdempotency({
				key: "idem-p",
				fingerprint: "f",
				sessionId: s.id,
				createdAt: T0,
			});

			expect(await store.purge(s.id, at(29 * DAY_MS))).toBe(false);
			expect(await store.get(s.id)).not.toBeNull();

			expect(await store.purge(s.id, s.purgeAt)).toBe(true);
			expect(await store.get(s.id)).toBeNull();
			expect(await store.getIdempotency("idem-p")).toBeNull();
			expect(await store.purge(s.id, s.purgeAt)).toBe(false);
		});
	});
}
