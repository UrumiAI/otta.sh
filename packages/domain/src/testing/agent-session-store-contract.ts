import { describe, expect, test } from "vitest";
import {
	AGENT_SESSION_MAX_DOCUMENT_BYTES,
	agentSessionDocumentBytes,
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
	AgentSessionCapacity,
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

/** Caps no contract test reaches unless it means to. */
const ROOMY: Omit<AgentSessionCapacity, "now"> = { maxLive: 1_000_000, maxStored: 1_000_000 };

async function seed(
	store: AgentSessionStore,
	session: AgentCheckoutSession,
): Promise<AgentCheckoutSession> {
	const r = await store.insert(session, { now: T0, ...ROOMY });
	if (!r.ok) throw new Error(`seed of ${session.id} refused: ${r.reason}`);
	return r.session;
}

/** A session padded (in `couponCode`) to weigh exactly `bytes`. */
function weighing(id: string, bytes: number): AgentCheckoutSession {
	const base = sample(id, { couponCode: "", revision: 1 });
	const pad = bytes - agentSessionDocumentBytes(base);
	if (pad < 0) throw new Error("sample already heavier");
	return { ...base, couponCode: "x".repeat(pad) };
}

const CLAIM = (
	over: Partial<{ tokenHash: string; claimId: string; now: string; leaseUntil: string }> = {},
) => ({
	tokenHash: "h",
	claimId: "claim-1",
	now: at(1000),
	leaseUntil: at(61_000),
	...over,
});

/**
 * The `AgentSessionStore` behavioural spec (ADR-0047): compare-and-set writes,
 * the capped insert (live and stored caps, document weight), the hashed
 * hand-off index, the create idempotency index and its release, the leased
 * hand-off claim and its exactly-once finalize, the counts behind the abuse
 * limits, and the bounded purge.
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

		describe("insert", () => {
			test("wins once at revision 1, storing exactly what it answers; a second insert answers exists with the first", async () => {
				const { store } = await makeHarness();
				const first = await store.insert(sample("cs_a", { couponCode: "ONE", revision: 7 }), {
					now: T0,
					...ROOMY,
				});
				expect(first).toEqual({
					ok: true,
					session: sample("cs_a", { couponCode: "ONE", revision: 1 }),
				});
				expect(await store.get(agentSessionId("cs_a"))).toEqual(
					sample("cs_a", { couponCode: "ONE", revision: 1 }),
				);
				const second = await store.insert(sample("cs_a", { couponCode: "TWO" }), {
					now: T0,
					...ROOMY,
				});
				expect(second).toEqual({
					ok: false,
					reason: "exists",
					current: sample("cs_a", { couponCode: "ONE", revision: 1 }),
				});
			});

			test("exists wins over every cap: a racing create's replay is never refused for capacity", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_ex"));
				expect(await store.insert(sample("cs_ex"), { now: T0, maxLive: 0, maxStored: 0 })).toEqual({
					ok: false,
					reason: "exists",
					current: s,
				});
			});

			test("the live cap: refused at maxLive live sessions, admitted below it; nothing stored on refusal", async () => {
				const { store } = await makeHarness();
				const cap = { now: at(1000), maxLive: 2, maxStored: 100 };
				expect((await store.insert(sample("cs_c1"), cap)).ok).toBe(true);
				expect((await store.insert(sample("cs_c2"), cap)).ok).toBe(true);
				expect(await store.insert(sample("cs_c3"), cap)).toEqual({ ok: false, reason: "capacity" });
				expect(await store.get(agentSessionId("cs_c3"))).toBeNull();
				expect(await store.countLive(at(1000))).toBe(2);
			});

			test("only live sessions use the live cap: canceled, completed and expired ones do not", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_d1", { status: "canceled" }));
				await seed(store, sample("cs_d2", { status: "completed" }));
				await seed(store, sample("cs_d3", { createdAt: at(-DAY_MS) })); // expiresAt == T0
				const cap = { now: T0, maxLive: 1, maxStored: 100 };
				expect((await store.insert(sample("cs_d4"), cap)).ok).toBe(true);
				expect(await store.insert(sample("cs_d5"), cap)).toEqual({ ok: false, reason: "capacity" });
			});

			test("the stored cap counts every stored session whatever its status; a purge frees room", async () => {
				const { store } = await makeHarness();
				const old = await seed(
					store,
					sample("cs_s1", { status: "canceled", createdAt: at(-31 * DAY_MS) }),
				);
				await seed(store, sample("cs_s2", { status: "completed" }));
				const cap = { now: T0, maxLive: 100, maxStored: 2 };
				expect(await store.insert(sample("cs_s3"), cap)).toEqual({ ok: false, reason: "capacity" });
				expect(await store.purge(old.id, T0)).toBe(true);
				expect((await store.insert(sample("cs_s3"), cap)).ok).toBe(true);
				expect(await store.insert(sample("cs_s4"), cap)).toEqual({ ok: false, reason: "capacity" });
			});

			test("racing inserts at the live cap: the store never overshoots it", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_r0"));
				const cap = { now: at(1000), maxLive: 3, maxStored: 100 };
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) => store.insert(sample(`cs_rr${i}`), cap)),
				);
				expect(results.filter((r) => r.ok)).toHaveLength(2);
				for (const r of results) if (!r.ok) expect(r).toEqual({ ok: false, reason: "capacity" });
				expect(await store.countLive(at(1000))).toBe(3);
			});

			test("racing inserts at the stored cap: the store never overshoots it", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_q0", { status: "canceled" }));
				const cap = { now: at(1000), maxLive: 100, maxStored: 2 };
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) => store.insert(sample(`cs_qq${i}`), cap)),
				);
				expect(results.filter((r) => r.ok)).toHaveLength(1);
			});

			test("refuses a document over the byte cap, admits one exactly at it", async () => {
				const { store } = await makeHarness();
				const atCap = weighing("cs_w1", AGENT_SESSION_MAX_DOCUMENT_BYTES);
				expect(agentSessionDocumentBytes(atCap)).toBe(AGENT_SESSION_MAX_DOCUMENT_BYTES);
				expect((await store.insert(atCap, { now: T0, ...ROOMY })).ok).toBe(true);
				const over = weighing("cs_w2", AGENT_SESSION_MAX_DOCUMENT_BYTES + 1);
				expect(await store.insert(over, { now: T0, ...ROOMY })).toEqual({
					ok: false,
					reason: "too_large",
				});
				expect(await store.get(over.id)).toBeNull();
			});

			test("the byte cap measures UTF-8, not characters", async () => {
				const { store } = await makeHarness();
				const base = sample("cs_w3", { couponCode: "", revision: 1 });
				const room = AGENT_SESSION_MAX_DOCUMENT_BYTES - agentSessionDocumentBytes(base);
				// Three bytes per character: a third of the room in characters fits, one more does not.
				const fits = { ...base, couponCode: "€".repeat(Math.floor(room / 3)) };
				const over = {
					...base,
					id: agentSessionId("cs_w4"),
					couponCode: "€".repeat(Math.floor(room / 3) + 1),
				};
				expect((await store.insert(fits, { now: T0, ...ROOMY })).ok).toBe(true);
				expect(await store.insert(over, { now: T0, ...ROOMY })).toEqual({
					ok: false,
					reason: "too_large",
				});
			});
		});

		describe("write (compare-and-set)", () => {
			test("wins on the stored revision and loses on a stale one with the current document", async () => {
				const { store } = await makeHarness();
				const s1 = await seed(store, sample("cs_b"));
				const won = await store.write({ ...s1, couponCode: "NEW" }, 1);
				expect(won).toEqual({ ok: true, session: { ...s1, couponCode: "NEW", revision: 2 } });
				const stale = await store.write({ ...s1, couponCode: "STALE" }, 1);
				expect(stale).toEqual({
					ok: false,
					reason: "conflict",
					current: { ...s1, couponCode: "NEW", revision: 2 },
				});
				expect(await store.get(s1.id)).toEqual({ ...s1, couponCode: "NEW", revision: 2 });
			});

			test("ignores the passed revision: it stores expected + 1", async () => {
				const { store } = await makeHarness();
				const s1 = await seed(store, sample("cs_rev"));
				const updated = await store.write({ ...s1, revision: 99, couponCode: "X" }, 1);
				expect(updated.ok && updated.session.revision).toBe(2);
				expect((await store.get(s1.id))?.revision).toBe(2);
				// The passed revision matching the stored one does not rescue a stale expectation.
				const stale = await store.write({ ...s1, revision: 2 }, 1);
				expect(stale.ok).toBe(false);
				expect((await store.get(s1.id))?.couponCode).toBe("X");
			});

			test("against a missing session it loses with null and creates nothing", async () => {
				const { store } = await makeHarness();
				expect(await store.write(sample("cs_none"), 1)).toEqual({
					ok: false,
					reason: "conflict",
					current: null,
				});
				expect(await store.write(sample("cs_none"), 0)).toEqual({
					ok: false,
					reason: "conflict",
					current: null,
				});
				expect(await store.get(agentSessionId("cs_none"))).toBeNull();
			});

			test("racing writes on one revision: exactly one wins and every loser sees the winner", async () => {
				const { store } = await makeHarness();
				const s1 = await seed(store, sample("cs_race"));
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) => store.write({ ...s1, couponCode: `C${i}` }, 1)),
				);
				const winners = results.filter((r) => r.ok);
				expect(winners).toHaveLength(1);
				const stored = await store.get(s1.id);
				expect(winners[0]).toEqual({ ok: true, session: stored });
				for (const r of results) {
					if (!r.ok) expect(r).toEqual({ ok: false, reason: "conflict", current: stored });
				}
				expect(stored?.revision).toBe(2);
			});

			test("refuses a document over the byte cap and leaves the stored one as it was", async () => {
				const { store } = await makeHarness();
				const s1 = await seed(store, sample("cs_wb"));
				const heavy = weighing("cs_wb", AGENT_SESSION_MAX_DOCUMENT_BYTES + 1);
				expect(await store.write({ ...heavy, revision: 1 }, 1)).toEqual({
					ok: false,
					reason: "too_large",
				});
				expect(await store.get(s1.id)).toEqual(s1);
				const exact = weighing("cs_wb", AGENT_SESSION_MAX_DOCUMENT_BYTES);
				// The stored revision (2) has the same digit count as the passed one (1).
				expect((await store.write(exact, 1)).ok).toBe(true);
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
						handoffClaim: {
							tokenHash: "hash-2",
							claimId: "c",
							claimedAt: T0,
							leaseUntil: at(60_000),
						},
						redeemedHandoffs: [{ tokenHash: "hash-1", usedAt: T0 }],
						writes: [
							{
								key: "k",
								operation: "create",
								fingerprint: "f",
								revision: 1,
								answer: {
									id: agentSessionId("cs_full"),
									status: "incomplete",
									currency: currency("USD"),
									lines: [],
									expiresAt: at(DAY_MS),
									handedOff: false,
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
				// Clearing an optional field by a write removes it, not nulls it.
				const { handoffClaim: _c, cartId: _k, ...cleared } = s;
				expect((await store.write(cleared, s.revision)).ok).toBe(true);
				const after = await store.get(s.id);
				expect(after && "handoffClaim" in after).toBe(false);
				expect(after && "cartId" in after).toBe(false);
			});

			test("returned and passed sessions are copies: changing them changes nothing stored", async () => {
				const { store } = await makeHarness();
				const input = sample("cs_copy");
				const s = await seed(store, input);
				input.lines.push({ productId: productId("p-9"), sku: sku("Z"), quantity: 9 });
				s.lines.push({ productId: productId("p-2"), sku: sku("X"), quantity: 2 });
				const read = await store.get(s.id);
				read?.lines.push({ productId: productId("p-3"), sku: sku("Y"), quantity: 3 });
				const found = await store.findByCartId("none");
				expect(found).toBeNull();
				expect((await store.get(s.id))?.lines).toHaveLength(1);
				const record = createRecord("idem-copy", "cs_copy");
				await store.putIdempotency(record);
				record.fingerprint = "mutated";
				const got = await store.getIdempotency("net-a", "idem-copy");
				if (got !== null) got.fingerprint = "mutated-too";
				expect((await store.getIdempotency("net-a", "idem-copy"))?.fingerprint).toBe("fp");
			});
		});

		describe("lookups", () => {
			test("finds a session by its current hand-off token hash; a replaced unused hash is gone", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_tok", { handoffTokenHash: "hash-1" }));
				expect(await store.findByHandoffTokenHash("hash-1")).toEqual(s);
				expect(await store.findByHandoffTokenHash("hash-unknown")).toBeNull();
				const rotated = await store.write({ ...s, handoffTokenHash: "hash-2" }, s.revision);
				expect(rotated.ok).toBe(true);
				expect(await store.findByHandoffTokenHash("hash-1")).toBeNull();
				expect(await store.findByHandoffTokenHash("hash-2")).toEqual(rotated.ok && rotated.session);
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
				expect(await store.findByHandoffTokenHash("hash-old")).toEqual(s);
				expect(await store.findByHandoffTokenHash("hash-new")).toEqual(s);
			});

			test("finds a session by token hash whatever its status, claim, use or expiry", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_f_can", { status: "canceled", handoffTokenHash: "h-can" }));
				await seed(store, sample("cs_f_done", { status: "completed", handoffTokenHash: "h-done" }));
				await seed(store, sample("cs_f_used", { handoffTokenHash: "h-used", handoffUsedAt: T0 }));
				await seed(
					store,
					sample("cs_f_exp", { handoffTokenHash: "h-exp", createdAt: at(-2 * DAY_MS) }),
				);
				const claimed = await seed(store, sample("cs_f_clm", { handoffTokenHash: "h-clm" }));
				expect((await store.claimHandoff(claimed.id, CLAIM({ tokenHash: "h-clm" }))).ok).toBe(true);
				expect((await store.findByHandoffTokenHash("h-can"))?.id).toBe("cs_f_can");
				expect((await store.findByHandoffTokenHash("h-done"))?.id).toBe("cs_f_done");
				expect((await store.findByHandoffTokenHash("h-used"))?.id).toBe("cs_f_used");
				expect((await store.findByHandoffTokenHash("h-exp"))?.id).toBe("cs_f_exp");
				expect((await store.findByHandoffTokenHash("h-clm"))?.id).toBe("cs_f_clm");
			});

			test("finds the most recently created session for a cart; a cart moved away no longer finds it", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_old", { cartId: "cart-x" }));
				const newer = await seed(
					store,
					sample("cs_new", { cartId: "cart-x", createdAt: at(60_000) }),
				);
				await seed(store, sample("cs_other", { cartId: "cart-y" }));
				expect(await store.findByCartId("cart-x")).toEqual(newer);
				expect(await store.findByCartId("cart-none")).toBeNull();
				expect((await store.write({ ...newer, cartId: "cart-z" }, newer.revision)).ok).toBe(true);
				expect((await store.findByCartId("cart-x"))?.id).toBe("cs_old");
				expect((await store.findByCartId("cart-z"))?.id).toBe("cs_new");
			});
		});

		describe("create idempotency index", () => {
			test("is insert-if-absent; a second put answers the first record and changes nothing", async () => {
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
				expect(await store.getIdempotency("net-a", "idem-1")).toEqual(record);
			});

			test("records are scoped to the network: one key, two networks, two records", async () => {
				const { store } = await makeHarness();
				const a = createRecord("idem-s", "cs_sa", { networkKey: "net-a" });
				const b = createRecord("idem-s", "cs_sb", { networkKey: "net-b", fingerprint: "other" });
				expect(await store.putIdempotency(a)).toEqual({ stored: true });
				expect(await store.putIdempotency(b)).toEqual({ stored: true });
				expect(await store.getIdempotency("net-a", "idem-s")).toEqual(a);
				expect(await store.getIdempotency("net-b", "idem-s")).toEqual(b);
				expect(await store.getIdempotency("net-c", "idem-s")).toBeNull();
				// Keys and network keys are opaque: no separator can make two pairs collide.
				const c = createRecord("b", "cs_sc", { networkKey: "a:" });
				const d = createRecord(":b", "cs_sd", { networkKey: "a" });
				expect(await store.putIdempotency(c)).toEqual({ stored: true });
				expect(await store.putIdempotency(d)).toEqual({ stored: true });
				expect(await store.getIdempotency("a:", "b")).toEqual(c);
				expect(await store.getIdempotency("a", ":b")).toEqual(d);
			});

			test("racing puts for one key: exactly one is stored, every loser answers it", async () => {
				const { store } = await makeHarness();
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) =>
						store.putIdempotency(createRecord("idem-race", `cs_r${i}`)),
					),
				);
				expect(results.filter((r) => r.stored)).toHaveLength(1);
				const stored = await store.getIdempotency("net-a", "idem-race");
				expect(stored).not.toBeNull();
				for (const r of results) if (!r.stored) expect(r.existing).toEqual(stored);
			});

			test("releaseIdempotency deletes only a record that still points at a session never stored", async () => {
				const { store } = await makeHarness();
				await store.putIdempotency(createRecord("rel-1", "cs_rel1"));
				expect(await store.releaseIdempotency("net-a", "rel-1", agentSessionId("cs_other"))).toBe(
					false,
				);
				expect(await store.getIdempotency("net-a", "rel-1")).not.toBeNull();
				expect(await store.releaseIdempotency("net-b", "rel-1", agentSessionId("cs_rel1"))).toBe(
					false,
				);
				expect(await store.releaseIdempotency("net-a", "rel-1", agentSessionId("cs_rel1"))).toBe(
					true,
				);
				expect(await store.getIdempotency("net-a", "rel-1")).toBeNull();
				expect(await store.releaseIdempotency("net-a", "rel-1", agentSessionId("cs_rel1"))).toBe(
					false,
				);
				// A record whose session landed is kept: the key keeps answering it.
				await seed(store, sample("cs_rel2"));
				await store.putIdempotency(createRecord("rel-2", "cs_rel2"));
				expect(await store.releaseIdempotency("net-a", "rel-2", agentSessionId("cs_rel2"))).toBe(
					false,
				);
				expect(await store.getIdempotency("net-a", "rel-2")).not.toBeNull();
			});

			test("extendIdempotencyPurge moves a record's purge later, never earlier; a missing record is a no-op", async () => {
				const { store } = await makeHarness();
				await store.putIdempotency(createRecord("idem-x", "cs_x"));
				await store.extendIdempotencyPurge("net-a", "idem-x", at(31 * DAY_MS));
				expect((await store.getIdempotency("net-a", "idem-x"))?.purgeAt).toBe(at(31 * DAY_MS));
				await store.extendIdempotencyPurge("net-a", "idem-x", at(DAY_MS));
				expect((await store.getIdempotency("net-a", "idem-x"))?.purgeAt).toBe(at(31 * DAY_MS));
				// Every other field is untouched.
				expect(await store.getIdempotency("net-a", "idem-x")).toEqual(
					createRecord("idem-x", "cs_x", { purgeAt: at(31 * DAY_MS) }),
				);
				await store.putIdempotency(createRecord("idem-x", "cs_y", { networkKey: "net-b" }));
				await store.extendIdempotencyPurge("net-a", "idem-x", at(40 * DAY_MS));
				expect((await store.getIdempotency("net-b", "idem-x"))?.purgeAt).toBe(at(30 * DAY_MS));
				await store.extendIdempotencyPurge("net-a", "idem-none", at(40 * DAY_MS));
				expect(await store.getIdempotency("net-a", "idem-none")).toBeNull();
				expect(await store.purgeIdempotencyDue(at(30 * DAY_MS), 10)).toBe(1);
				expect(await store.getIdempotency("net-a", "idem-x")).not.toBeNull();
				expect(await store.getIdempotency("net-b", "idem-x")).toBeNull();
			});
		});

		describe("hand-off claim and finalize", () => {
			test("a claim stamps the lease and bumps the revision, changing nothing else", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c", { handoffTokenHash: "h" }));
				const claimed = await store.claimHandoff(s.id, CLAIM());
				const expected = {
					...s,
					revision: s.revision + 1,
					handoffClaim: {
						tokenHash: "h",
						claimId: "claim-1",
						claimedAt: at(1000),
						leaseUntil: at(61_000),
					},
				};
				expect(claimed).toEqual({ ok: true, session: expected });
				expect(await store.get(s.id)).toEqual(expected);
			});

			test("a second claim during the lease is refused claimed, with the lease end; nothing written", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c2", { handoffTokenHash: "h" }));
				await store.claimHandoff(s.id, CLAIM());
				const before = await store.get(s.id);
				expect(
					await store.claimHandoff(s.id, CLAIM({ claimId: "claim-2", now: at(60_999) })),
				).toEqual({
					ok: false,
					reason: "claimed",
					leaseUntil: at(61_000),
				});
				expect(await store.get(s.id)).toEqual(before);
			});

			test("after the lease lapses (at leaseUntil) the same token claims again and the old claim is gone", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c3", { handoffTokenHash: "h" }));
				await store.claimHandoff(s.id, CLAIM());
				const again = await store.claimHandoff(
					s.id,
					CLAIM({ claimId: "claim-2", now: at(61_000), leaseUntil: at(121_000) }),
				);
				expect(again.ok && again.session.handoffClaim).toEqual({
					tokenHash: "h",
					claimId: "claim-2",
					claimedAt: at(61_000),
					leaseUntil: at(121_000),
				});
				expect(
					await store.finalizeHandoff(s.id, { claimId: "claim-1", cartId: "c", now: at(62_000) }),
				).toEqual({
					ok: false,
					reason: "claim_lost",
				});
			});

			test("racing claims: exactly one wins, every loser is refused claimed", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c4", { handoffTokenHash: "h" }));
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) =>
						store.claimHandoff(s.id, CLAIM({ claimId: `claim-${i}` })),
					),
				);
				const winners = results.filter((r) => r.ok);
				expect(winners).toHaveLength(1);
				for (const r of results)
					if (!r.ok) expect(r).toEqual({ ok: false, reason: "claimed", leaseUntil: at(61_000) });
				const read = await store.get(s.id);
				expect(read?.revision).toBe(s.revision + 1);
				expect(winners[0]).toEqual({ ok: true, session: read });
			});

			test("a claim refuses, in order, unknown, wrong hash, canceled, completed, used, expired and empty; nothing written", async () => {
				const { store } = await makeHarness();
				expect(await store.claimHandoff(agentSessionId("cs_zz"), CLAIM())).toEqual({
					ok: false,
					reason: "not_found",
				});
				const cases: [string, Partial<AgentCheckoutSession>, string][] = [
					["cs_k1", { handoffTokenHash: "other" }, "token_mismatch"],
					[
						"cs_k2",
						{ status: "canceled", handoffUsedAt: T0, createdAt: at(-2 * DAY_MS), lines: [] },
						"canceled",
					],
					[
						"cs_k3",
						{ status: "completed", handoffUsedAt: T0, createdAt: at(-2 * DAY_MS) },
						"completed",
					],
					["cs_k4", { handoffUsedAt: T0, createdAt: at(-2 * DAY_MS), lines: [] }, "already_used"],
					["cs_k5", { createdAt: at(-DAY_MS + 1000), lines: [] }, "expired"],
					["cs_k6", { lines: [] }, "incomplete"],
				];
				for (const [id, over, reason] of cases) {
					const s = await seed(store, sample(id, { handoffTokenHash: "h", ...over }));
					expect(await store.claimHandoff(s.id, CLAIM()), id).toEqual({ ok: false, reason });
					expect(await store.get(s.id)).toEqual(s);
				}
			});

			test("a claim at one millisecond before expiresAt wins", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c5", { handoffTokenHash: "h" }));
				const justBefore = new Date(Date.parse(s.expiresAt) - 1).toISOString();
				expect((await store.claimHandoff(s.id, CLAIM({ now: justBefore }))).ok).toBe(true);
			});

			test("a compare-and-set at the pre-claim revision loses after a claim: agent writes cannot slip past it", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_c6", { handoffTokenHash: "h" }));
				expect((await store.claimHandoff(s.id, CLAIM())).ok).toBe(true);
				const lost = await store.write({ ...s, lines: [] }, s.revision);
				expect(lost.ok).toBe(false);
				expect((await store.get(s.id))?.lines).toEqual(s.lines);
			});

			test("finalize stamps use and cart in one step, keeps the claim, bumps the revision; then replays", async () => {
				const { store } = await makeHarness();
				const s = await seed(
					store,
					sample("cs_f1", { handoffTokenHash: "h", cartId: "cart-agent" }),
				);
				const claimed = await store.claimHandoff(s.id, CLAIM());
				if (!claimed.ok) throw new Error("claim failed");
				const done = await store.finalizeHandoff(s.id, {
					claimId: "claim-1",
					cartId: "cart-shopper",
					now: at(2000),
				});
				const expected = {
					...claimed.session,
					revision: claimed.session.revision + 1,
					handoffUsedAt: at(2000),
					cartId: "cart-shopper",
				};
				expect(done).toEqual({ ok: true, replayed: false, session: expected });
				expect(await store.get(s.id)).toEqual(expected);
				expect(await store.findByCartId("cart-shopper")).toEqual(expected);
				expect(
					await store.finalizeHandoff(s.id, {
						claimId: "claim-1",
						cartId: "cart-shopper",
						now: at(3000),
					}),
				).toEqual({
					ok: true,
					replayed: true,
					session: expected,
				});
				expect(
					await store.finalizeHandoff(s.id, {
						claimId: "claim-1",
						cartId: "cart-other",
						now: at(3000),
					}),
				).toEqual({
					ok: false,
					reason: "already_used",
				});
				expect(await store.get(s.id)).toEqual(expected);
				// A finalized link cannot be claimed again.
				expect(
					await store.claimHandoff(
						s.id,
						CLAIM({ claimId: "claim-9", now: at(200_000), leaseUntil: at(260_000) }),
					),
				).toEqual({
					ok: false,
					reason: "already_used",
				});
			});

			test("racing finalizes of one claim: exactly one writes, the rest replay or refuse", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_f2", { handoffTokenHash: "h" }));
				await store.claimHandoff(s.id, CLAIM());
				const results = await Promise.all(
					Array.from({ length: 8 }, (_, i) =>
						store.finalizeHandoff(s.id, {
							claimId: "claim-1",
							cartId: i % 2 === 0 ? "cart-a" : "cart-b",
							now: at(2000),
						}),
					),
				);
				const writers = results.filter((r) => r.ok && !r.replayed);
				expect(writers).toHaveLength(1);
				const read = await store.get(s.id);
				for (const r of results) {
					if (r.ok) expect(r.session.cartId).toBe(read?.cartId);
					else expect(r).toEqual({ ok: false, reason: "already_used" });
				}
				expect(read?.revision).toBe(s.revision + 2);
			});

			test("finalize refuses unknown, another claim, no claim, canceled and completed; nothing written", async () => {
				const { store } = await makeHarness();
				const fin = { claimId: "claim-1", cartId: "cart", now: at(2000) };
				expect(await store.finalizeHandoff(agentSessionId("cs_none"), fin)).toEqual({
					ok: false,
					reason: "not_found",
				});
				const unclaimed = await seed(store, sample("cs_f3", { handoffTokenHash: "h" }));
				expect(await store.finalizeHandoff(unclaimed.id, fin)).toEqual({
					ok: false,
					reason: "claim_lost",
				});
				const other = await seed(store, sample("cs_f4", { handoffTokenHash: "h" }));
				await store.claimHandoff(other.id, CLAIM({ claimId: "claim-2" }));
				expect(await store.finalizeHandoff(other.id, fin)).toEqual({
					ok: false,
					reason: "claim_lost",
				});
				for (const [id, status] of [
					["cs_f5", "canceled"],
					["cs_f6", "completed"],
				] as const) {
					const s = await seed(store, sample(id, { handoffTokenHash: "h" }));
					const claimed = await store.claimHandoff(s.id, CLAIM());
					if (!claimed.ok) throw new Error("claim failed");
					const closed = await store.write(
						{ ...claimed.session, status },
						claimed.session.revision,
					);
					if (!closed.ok) throw new Error("close failed");
					expect(await store.finalizeHandoff(s.id, fin)).toEqual({ ok: false, reason: status });
					expect(await store.get(s.id)).toEqual(closed.session);
				}
			});

			test("a lapsed claim nobody replaced still finalizes", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_f7", { handoffTokenHash: "h" }));
				await store.claimHandoff(s.id, CLAIM());
				const done = await store.finalizeHandoff(s.id, {
					claimId: "claim-1",
					cartId: "cart",
					now: at(10 * 60_000),
				});
				expect(done.ok && done.session.handoffUsedAt).toBe(at(10 * 60_000));
			});

			test("releaseHandoffClaim drops only that unfinalized claim; the link claims again at once", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_rl", { handoffTokenHash: "h" }));
				await store.claimHandoff(s.id, CLAIM());
				expect(await store.releaseHandoffClaim(s.id, "claim-other")).toBe(false);
				const claimed = await store.get(s.id);
				expect(await store.releaseHandoffClaim(s.id, "claim-1")).toBe(true);
				const released = await store.get(s.id);
				expect(released && "handoffClaim" in released).toBe(false);
				const { handoffClaim: _h, ...rest } = claimed ?? s;
				expect(released).toEqual({ ...rest, revision: (claimed?.revision ?? 0) + 1 });
				expect(await store.releaseHandoffClaim(s.id, "claim-1")).toBe(false);
				expect(
					(await store.claimHandoff(s.id, CLAIM({ claimId: "claim-2", now: at(1500) }))).ok,
				).toBe(true);
				expect(
					(await store.finalizeHandoff(s.id, { claimId: "claim-2", cartId: "c", now: at(2000) }))
						.ok,
				).toBe(true);
				// A finalized claim is never released.
				expect(await store.releaseHandoffClaim(s.id, "claim-2")).toBe(false);
				expect((await store.get(s.id))?.handoffUsedAt).toBe(at(2000));
				expect(await store.releaseHandoffClaim(agentSessionId("cs_nope"), "claim-1")).toBe(false);
			});
		});

		describe("counts", () => {
			test("countLive counts open sessions whose expiresAt is strictly after now", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_l1"));
				await seed(store, sample("cs_l2", { status: "incomplete", lines: [] }));
				await seed(store, sample("cs_l3", { status: "canceled" }));
				await seed(store, sample("cs_l4", { status: "completed" }));
				await seed(store, sample("cs_l5", { createdAt: at(-2 * DAY_MS) }));
				expect(await store.countLive(at(1000))).toBe(2);
				expect(await store.countLive(at(DAY_MS - 1))).toBe(2);
				expect(await store.countLive(at(DAY_MS))).toBe(0);
			});

			test("countCreatedSince counts one network's creates from a time on, every status included", async () => {
				const { store } = await makeHarness();
				await seed(store, sample("cs_n1", { networkKey: "net-a" }));
				await seed(
					store,
					sample("cs_n2", { networkKey: "net-a", createdAt: at(30 * 60_000), status: "canceled" }),
				);
				await seed(store, sample("cs_n3", { networkKey: "net-b", createdAt: at(30 * 60_000) }));
				await seed(store, sample("cs_n4", { networkKey: "net-a", createdAt: at(-1) }));
				expect(await store.countCreatedSince("net-a", T0)).toBe(2);
				expect(await store.countCreatedSince("net-a", at(1))).toBe(1);
				expect(await store.countCreatedSince("net-a", at(30 * 60_000))).toBe(1);
				expect(await store.countCreatedSince("net-a", at(30 * 60_000 + 1))).toBe(0);
				expect(await store.countCreatedSince("net-b", T0)).toBe(1);
				expect(await store.countCreatedSince("net-c", T0)).toBe(0);
			});
		});

		describe("purge and 30-day retention", () => {
			test("listPurgeDue lists only due sessions, exactly the limit when more are due", async () => {
				const { store } = await makeHarness();
				for (let i = 0; i < 5; i++)
					await seed(store, sample(`cs_p${i}`, { createdAt: at(-31 * DAY_MS) }));
				await seed(store, sample("cs_fresh"));
				const due = new Set(["cs_p0", "cs_p1", "cs_p2", "cs_p3", "cs_p4"]);
				const first = await store.listPurgeDue(T0, 3);
				expect(first).toHaveLength(3);
				expect(new Set(first).size).toBe(3);
				for (const id of first) expect(due.has(id)).toBe(true);
				expect(new Set<AgentSessionId>(await store.listPurgeDue(T0, 100))).toEqual(due);
			});

			test("listPurgeDue includes a session whose purgeAt equals now, not one a millisecond later", async () => {
				const { store } = await makeHarness();
				const s = await seed(store, sample("cs_edge"));
				const before = new Date(Date.parse(s.purgeAt) - 1).toISOString();
				expect(await store.listPurgeDue(before, 10)).toEqual([]);
				expect(await store.listPurgeDue(s.purgeAt, 10)).toEqual([s.id]);
			});

			test("purge deletes a due session, its create records and its lookups; not before purgeAt; idempotent", async () => {
				const { store } = await makeHarness();
				const s = await seed(
					store,
					sample("cs_purge", { handoffTokenHash: "h-p", cartId: "cart-p" }),
				);
				await store.putIdempotency(createRecord("idem-p", s.id));
				await store.putIdempotency(createRecord("idem-p", s.id, { networkKey: "net-b" }));
				const other = await seed(store, sample("cs_keep"));
				await store.putIdempotency(createRecord("idem-k", other.id));

				expect(await store.purge(s.id, new Date(Date.parse(s.purgeAt) - 1).toISOString())).toBe(
					false,
				);
				expect(await store.get(s.id)).toEqual(s);

				expect(await store.purge(s.id, s.purgeAt)).toBe(true);
				expect(await store.get(s.id)).toBeNull();
				expect(await store.getIdempotency("net-a", "idem-p")).toBeNull();
				expect(await store.getIdempotency("net-b", "idem-p")).toBeNull();
				expect(await store.findByHandoffTokenHash("h-p")).toBeNull();
				expect(await store.findByCartId("cart-p")).toBeNull();
				expect(await store.write(s, s.revision)).toEqual({
					ok: false,
					reason: "conflict",
					current: null,
				});
				expect(await store.purge(s.id, s.purgeAt)).toBe(false);
				// Nothing of another session's is touched.
				expect(await store.get(other.id)).toEqual(other);
				expect(await store.getIdempotency("net-a", "idem-k")).not.toBeNull();
			});

			test("purgeIdempotencyDue sweeps due create records, orphans included, at most the limit", async () => {
				const { store } = await makeHarness();
				for (let i = 0; i < 3; i++)
					await store.putIdempotency(createRecord(`orphan-${i}`, `cs_o${i}`));
				await store.putIdempotency(
					createRecord("fresh", "cs_fresh_o", { purgeAt: at(31 * DAY_MS) }),
				);
				const due = at(30 * DAY_MS);
				expect(await store.purgeIdempotencyDue(at(30 * DAY_MS - 1), 10)).toBe(0);
				expect(await store.purgeIdempotencyDue(due, 2)).toBe(2);
				expect(await store.purgeIdempotencyDue(due, 10)).toBe(1);
				expect(await store.purgeIdempotencyDue(due, 10)).toBe(0);
				for (let i = 0; i < 3; i++)
					expect(await store.getIdempotency("net-a", `orphan-${i}`)).toBeNull();
				expect(await store.getIdempotency("net-a", "fresh")).toEqual(
					createRecord("fresh", "cs_fresh_o", { purgeAt: at(31 * DAY_MS) }),
				);
			});
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
 * generation under an unambiguous encoding (no field-boundary collisions), a hash that never echoes its input, and a constant-time compare
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

		test("derive's encoding is unambiguous: field-boundary shifts never collide", async () => {
			// Plain concatenation of (purpose, id, generation) would make ("cs_x1", 1)
			// and ("cs_x", 11) derive alike; the encoding must length-prefix or delimit.
			const secrets = await makeSecrets(serverKey(1));
			const ids = [
				"cs_x",
				"cs_x1",
				"cs_x11",
				"cs_x1order",
				"cs_xorder",
				"cs_xhandoff",
				"cs_x1handoff",
			];
			const derived = new Map<string, string>();
			const add = (label: string, value: string): void => {
				expect(derived.get(value), `${label} collides with ${derived.get(value)}`).toBeUndefined();
				derived.set(value, label);
			};
			for (const raw of ids) {
				const id = agentSessionId(raw);
				add(`order(${raw})`, await secrets.derive("order", id));
				for (const generation of [1, 11, 111]) {
					add(`handoff(${raw}, ${generation})`, await secrets.derive("handoff", id, generation));
				}
			}
			expect(await secrets.derive("handoff", agentSessionId("cs_x1"), 1)).not.toBe(
				await secrets.derive("handoff", agentSessionId("cs_x"), 11),
			);
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
