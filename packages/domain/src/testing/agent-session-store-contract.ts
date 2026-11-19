import { describe, expect, test } from "vitest";
import {
	agentSessionId,
	type AgentCheckoutSession,
	type AgentSessionId,
} from "../agentic/model.js";
import { currency } from "../money/cents.js";
import { productId, sku } from "../money/ids.js";
import {
	AGENT_SESSION_MIN_SERVER_KEY_BYTES,
	type AgentSessionSecrets,
} from "../agentic/secrets.js";
import type {
	AgentCreateIdempotencyRecord,
	AgentSessionStore,
} from "../ports/agent-session-store.js";

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
		linkGeneration: 0,
		redeemedHandoffs: [],
		channel: "other",
		networkKey: "net-a",
		createdAt,
		updatedAt: createdAt,
		expiresAt: new Date(created + DAY_MS).toISOString(),
		purgeAt: new Date(created + 30 * DAY_MS).toISOString(),
		writes: [],
		retiredWriteKeys: [],
		...overrides,
	};
}

function createRecord(
	key: string,
	sessionId: string,
	overrides: Partial<AgentCreateIdempotencyRecord> = {},
): AgentCreateIdempotencyRecord {
	return {
		networkKey: "net-a",
		key,
		fingerprint: "fp",
		sessionId: agentSessionId(sessionId),
		createdAt: T0,
		purgeAt: at(30 * DAY_MS),
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

		test("write ignores the passed revision: it stores expected + 1 (1 on insert)", async () => {
			const { store } = await makeHarness();
			const inserted = await store.write(sample("cs_rev", { revision: 7 }), null);
			expect(inserted.ok && inserted.session.revision).toBe(1);
			const s1 = await store.get(agentSessionId("cs_rev"));
			if (s1 === null) throw new Error("missing");
			const updated = await store.write({ ...s1, revision: 99, couponCode: "X" }, 1);
			expect(updated.ok && updated.session.revision).toBe(2);
			expect((await store.get(s1.id))?.revision).toBe(2);
			// A write whose passed revision matches the stored one but whose expected
			// revision does not still loses.
			const stale = await store.write({ ...s1, revision: 2 }, 1);
			expect(stale.ok).toBe(false);
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
					linkGeneration: 2,
					handoffTokenHash: "hash-2",
					redeemedHandoffs: [{ tokenHash: "hash-1", usedAt: T0 }],
					writes: [
						{
							key: "k",
							operation: "create",
							fingerprint: "f",
							revision: 1,
							answer: {
								id: agentSessionId("cs_full"),
								revision: 1,
								status: "incomplete",
								currency: currency("USD"),
								lines: [],
								linkGeneration: 0,
								channel: "other",
								createdAt: T0,
								updatedAt: T0,
								expiresAt: at(DAY_MS),
								purgeAt: at(30 * DAY_MS),
							},
						},
					],
					retiredWriteKeys: [{ key: "old" }],
				}),
			);
			const read = await store.get(s.id);
			expect(read).toEqual(s);
			expect(read && "quote" in read).toBe(false);
			expect(read && "handoffUsedAt" in read).toBe(false);
			expect(read && "orderId" in read).toBe(false);
		});

		test("a returned session is a copy: changing it changes nothing stored", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_copy"));
			s.lines.push({ productId: productId("p-2"), sku: sku("X"), quantity: 2 });
			const read = await store.get(s.id);
			expect(read?.lines).toHaveLength(1);
		});

		test("finds a session by its current hand-off token hash; a replaced unused hash is gone", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_tok", { handoffTokenHash: "hash-1" }));
			expect((await store.findByHandoffTokenHash("hash-1"))?.id).toBe(s.id);
			expect(await store.findByHandoffTokenHash("hash-unknown")).toBeNull();

			const rotated = await store.write({ ...s, handoffTokenHash: "hash-2" }, s.revision);
			expect(rotated.ok).toBe(true);
			expect(await store.findByHandoffTokenHash("hash-1")).toBeNull();
			expect((await store.findByHandoffTokenHash("hash-2"))?.id).toBe(s.id);
		});

		test("finds a session by a redeemed earlier link's hash", async () => {
			const { store } = await makeHarness();
			const s = await seed(
				store,
				sample("cs_hist", {
					handoffTokenHash: "hash-new",
					redeemedHandoffs: [{ tokenHash: "hash-old", usedAt: T0 }],
				}),
			);
			expect((await store.findByHandoffTokenHash("hash-old"))?.id).toBe(s.id);
			expect((await store.findByHandoffTokenHash("hash-new"))?.id).toBe(s.id);
		});

		test("finds a session by token hash whatever its status, use or expiry", async () => {
			const { store } = await makeHarness();
			await seed(store, sample("cs_f_can", { status: "canceled", handoffTokenHash: "h-can" }));
			await seed(store, sample("cs_f_done", { status: "completed", handoffTokenHash: "h-done" }));
			await seed(store, sample("cs_f_used", { handoffTokenHash: "h-used", handoffUsedAt: T0 }));
			await seed(
				store,
				sample("cs_f_exp", { handoffTokenHash: "h-exp", createdAt: at(-2 * DAY_MS) }),
			);
			expect((await store.findByHandoffTokenHash("h-can"))?.id).toBe("cs_f_can");
			expect((await store.findByHandoffTokenHash("h-done"))?.id).toBe("cs_f_done");
			expect((await store.findByHandoffTokenHash("h-used"))?.id).toBe("cs_f_used");
			expect((await store.findByHandoffTokenHash("h-exp"))?.id).toBe("cs_f_exp");
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
			const record = createRecord("idem-1", "cs_i1", { fingerprint: "fp-1" });
			expect(await store.getIdempotency("net-a", "idem-1")).toBeNull();
			expect(await store.putIdempotency(record)).toEqual({ stored: true });
			expect(await store.getIdempotency("net-a", "idem-1")).toEqual(record);

			const again = await store.putIdempotency({
				...record,
				fingerprint: "fp-2",
				sessionId: agentSessionId("cs_i2"),
			});
			expect(again).toEqual({ stored: false, existing: record });
		});

		test("create records are scoped to the network: one key, two networks, two records", async () => {
			const { store } = await makeHarness();
			const a = createRecord("idem-s", "cs_sa", { networkKey: "net-a" });
			const b = createRecord("idem-s", "cs_sb", { networkKey: "net-b", fingerprint: "other" });
			expect(await store.putIdempotency(a)).toEqual({ stored: true });
			expect(await store.putIdempotency(b)).toEqual({ stored: true });
			expect(await store.getIdempotency("net-a", "idem-s")).toEqual(a);
			expect(await store.getIdempotency("net-b", "idem-s")).toEqual(b);
			expect(await store.getIdempotency("net-c", "idem-s")).toBeNull();
		});

		test("racing idempotency puts for one key: exactly one is stored", async () => {
			const { store } = await makeHarness();
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					store.putIdempotency(createRecord("idem-race", `cs_r${i}`)),
				),
			);
			const winners = results.filter((r) => r.stored);
			expect(winners).toHaveLength(1);
			const stored = await store.getIdempotency("net-a", "idem-race");
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

		test("a compare-and-set at the pre-mark revision loses after a mark", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_mark_cas", { handoffTokenHash: "h" }));
			expect((await store.markHandoffUsed(s.id, "h", at(1000))).ok).toBe(true);
			const lost = await store.write({ ...s, couponCode: "LATE" }, s.revision);
			expect(lost.ok).toBe(false);
			const read = await store.get(s.id);
			expect(read?.handoffUsedAt).toBe(at(1000));
			expect(read?.couponCode).toBeUndefined();
		});

		test("markHandoffUsed refuses a wrong hash, canceled, completed and unknown", async () => {
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
				reason: "canceled",
			});
			const completed = await seed(
				store,
				sample("cs_m4", { handoffTokenHash: "h4", status: "completed" }),
			);
			expect(await store.markHandoffUsed(completed.id, "h4", T0)).toEqual({
				ok: false,
				reason: "completed",
			});
			expect(await store.markHandoffUsed(agentSessionId("cs_zz"), "h", T0)).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect((await store.get(s.id))?.handoffUsedAt).toBeUndefined();
			expect((await store.get(canceled.id))?.handoffUsedAt).toBeUndefined();
			expect((await store.get(completed.id))?.handoffUsedAt).toBeUndefined();
		});

		test("markHandoffUsed guards expiry inside the mark: refused at expiresAt, allowed just before", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_m5", { handoffTokenHash: "h5" }));
			expect(await store.markHandoffUsed(s.id, "h5", s.expiresAt)).toEqual({
				ok: false,
				reason: "expired",
			});
			expect((await store.get(s.id))?.handoffUsedAt).toBeUndefined();
			const justBefore = new Date(Date.parse(s.expiresAt) - 1).toISOString();
			expect((await store.markHandoffUsed(s.id, "h5", justBefore)).ok).toBe(true);
		});

		test("markHandoffUsed refuses a session with no lines, inside the mark", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_m6", { handoffTokenHash: "h6", lines: [] }));
			expect(await store.markHandoffUsed(s.id, "h6", at(1000))).toEqual({
				ok: false,
				reason: "incomplete",
			});
			const read = await store.get(s.id);
			expect(read?.handoffUsedAt).toBeUndefined();
			expect(read?.revision).toBe(s.revision);
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

		test("listPurgeDue includes a session whose purgeAt equals now, not one a millisecond later", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_edge"));
			const before = new Date(Date.parse(s.purgeAt) - 1).toISOString();
			expect(await store.listPurgeDue(before, 10)).toEqual([]);
			expect(await store.listPurgeDue(s.purgeAt, 10)).toEqual([s.id]);
		});

		test("purge deletes a due session and its create record; not before purgeAt", async () => {
			const { store } = await makeHarness();
			const s = await seed(store, sample("cs_purge"));
			await store.putIdempotency(createRecord("idem-p", s.id));

			expect(await store.purge(s.id, at(29 * DAY_MS))).toBe(false);
			expect(await store.get(s.id)).not.toBeNull();

			expect(await store.purge(s.id, s.purgeAt)).toBe(true);
			expect(await store.get(s.id)).toBeNull();
			expect(await store.getIdempotency("net-a", "idem-p")).toBeNull();
			expect(await store.purge(s.id, s.purgeAt)).toBe(false);
		});

		test("extendIdempotencyPurge moves a record's purge later, never earlier; a missing record is a no-op", async () => {
			const { store } = await makeHarness();
			const record = createRecord("idem-x", "cs_x");
			await store.putIdempotency(record);
			await store.extendIdempotencyPurge("net-a", "idem-x", at(31 * DAY_MS));
			expect((await store.getIdempotency("net-a", "idem-x"))?.purgeAt).toBe(at(31 * DAY_MS));
			await store.extendIdempotencyPurge("net-a", "idem-x", at(DAY_MS));
			expect((await store.getIdempotency("net-a", "idem-x"))?.purgeAt).toBe(at(31 * DAY_MS));
			// Scoped like every create record: another network's key is untouched.
			await store.putIdempotency(createRecord("idem-x", "cs_y", { networkKey: "net-b" }));
			await store.extendIdempotencyPurge("net-a", "idem-x", at(40 * DAY_MS));
			expect((await store.getIdempotency("net-b", "idem-x"))?.purgeAt).toBe(at(30 * DAY_MS));
			await store.extendIdempotencyPurge("net-a", "idem-none", at(40 * DAY_MS));
			expect(await store.getIdempotency("net-a", "idem-none")).toBeNull();
			// A sweep at the old purge time takes net-b's record but not the extended one.
			expect(await store.purgeIdempotencyDue(at(30 * DAY_MS), 10)).toBe(1);
			expect(await store.getIdempotency("net-a", "idem-x")).not.toBeNull();
			expect(await store.getIdempotency("net-b", "idem-x")).toBeNull();
		});

		test("purgeIdempotencyDue sweeps due create records, orphans included, at most the limit", async () => {
			const { store } = await makeHarness();
			// Orphans: recorded creates whose session was never written.
			for (let i = 0; i < 3; i++) {
				await store.putIdempotency(createRecord(`orphan-${i}`, `cs_o${i}`));
			}
			await store.putIdempotency(createRecord("fresh", "cs_fresh_o", { purgeAt: at(31 * DAY_MS) }));
			const due = at(30 * DAY_MS);
			expect(await store.purgeIdempotencyDue(at(30 * DAY_MS - 1), 10)).toBe(0);
			expect(await store.purgeIdempotencyDue(due, 2)).toBe(2);
			expect(await store.purgeIdempotencyDue(due, 10)).toBe(1);
			expect(await store.purgeIdempotencyDue(due, 10)).toBe(0);
			for (let i = 0; i < 3; i++) {
				expect(await store.getIdempotency("net-a", `orphan-${i}`)).toBeNull();
			}
			expect(await store.getIdempotency("net-a", "fresh")).not.toBeNull();
		});
	});
}

/** Builds the adapter under `serverKey`; MUST throw (or reject) on an empty or short key. */
export type AgentSessionSecretsFactory = (
	serverKey: Uint8Array,
) => AgentSessionSecrets | Promise<AgentSessionSecrets>;

function serverKey(fill: number, bytes = AGENT_SESSION_MIN_SERVER_KEY_BYTES): Uint8Array {
	return new Uint8Array(bytes).fill(fill);
}

/**
 * The `AgentSessionSecrets` behavioural spec: unguessable-shaped ids, derived
 * secrets that are KEYED (two adapters under the same key agree, under different
 * keys they differ for both purposes, and an empty or short key is refused at
 * construction), deterministic and separated by purpose, session and
 * generation, a hash that never echoes its input, and a constant-time compare
 * that answers false (never throws) on a length mismatch. A keyless derive, e.g.
 * SHA-256(purpose, id, generation), fails it.
 */
export function agentSessionSecretsContract(
	makeSecrets: AgentSessionSecretsFactory,
	options: AgentSessionStoreContractOptions,
): void {
	describe(`AgentSessionSecrets contract [${options.dialect}]`, () => {
		const a = agentSessionId("cs_aaaaaaaaaaaaaaaaaaaaaa");
		const b = agentSessionId("cs_bbbbbbbbbbbbbbbbbbbbbb");

		test("mintId: at least 22 base64url characters (128 bits), fresh each time", async () => {
			const secrets = await makeSecrets(serverKey(1));
			const ids = Array.from({ length: 20 }, () => secrets.mintId());
			for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22,}$/);
			expect(new Set(ids).size).toBe(ids.length);
		});

		test("derive is deterministic and separated by purpose, session and generation", async () => {
			const secrets = await makeSecrets(serverKey(1));
			const order = await secrets.derive("order", a);
			expect(order.length).toBeGreaterThan(0);
			expect(await secrets.derive("order", a)).toBe(order);
			expect(await secrets.derive("order", b)).not.toBe(order);
			const g1 = await secrets.derive("handoff", a, 1);
			expect(await secrets.derive("handoff", a, 1)).toBe(g1);
			expect(await secrets.derive("handoff", a, 2)).not.toBe(g1);
			expect(await secrets.derive("handoff", b, 1)).not.toBe(g1);
			expect(g1).not.toBe(order);
		});

		test("derive is keyed: the same key agrees across instances, a different key differs for both purposes", async () => {
			const one = await makeSecrets(serverKey(1));
			const same = await makeSecrets(serverKey(1));
			const other = await makeSecrets(serverKey(2));
			// Differs in its last byte only.
			const near = serverKey(1);
			near[near.length - 1] = 2;
			const nearly = await makeSecrets(near);
			expect(await same.derive("order", a)).toBe(await one.derive("order", a));
			expect(await same.derive("handoff", a, 1)).toBe(await one.derive("handoff", a, 1));
			for (const different of [other, nearly]) {
				expect(await different.derive("order", a)).not.toBe(await one.derive("order", a));
				expect(await different.derive("handoff", a, 1)).not.toBe(await one.derive("handoff", a, 1));
			}
		});

		test("construction refuses an empty or short server key", async () => {
			for (const bad of [new Uint8Array(0), serverKey(1, AGENT_SESSION_MIN_SERVER_KEY_BYTES - 1)]) {
				await expect(Promise.resolve().then(() => makeSecrets(bad))).rejects.toThrow();
			}
			await expect(
				Promise.resolve().then(() => makeSecrets(serverKey(1, AGENT_SESSION_MIN_SERVER_KEY_BYTES))),
			).resolves.toBeDefined();
		});

		test("derive's types demand a generation for a hand-off token and refuse one for the order secret", () => {
			const typeOnly = (secrets: AgentSessionSecrets): void => {
				// @ts-expect-error a hand-off token needs its generation
				void secrets.derive("handoff", a);
				// @ts-expect-error the order secret has no generation
				void secrets.derive("order", a, 1);
			};
			expect(typeof typeOnly).toBe("function");
		});

		test("hash is deterministic, distinct per input, and never the input", async () => {
			const secrets = await makeSecrets(serverKey(1));
			const h = await secrets.hash("token-1");
			expect(await secrets.hash("token-1")).toBe(h);
			expect(await secrets.hash("token-2")).not.toBe(h);
			expect(h).not.toBe("token-1");
		});

		test("constantTimeEqual: true on equal, false on differing, false (no throw) on a length mismatch", async () => {
			const secrets = await makeSecrets(serverKey(1));
			expect(secrets.constantTimeEqual("abcdef", "abcdef")).toBe(true);
			expect(secrets.constantTimeEqual("abcdef", "abcdeg")).toBe(false);
			expect(() => secrets.constantTimeEqual("abc", "abcdef")).not.toThrow();
			expect(secrets.constantTimeEqual("abc", "abcdef")).toBe(false);
			expect(secrets.constantTimeEqual("", "a")).toBe(false);
		});
	});
}
