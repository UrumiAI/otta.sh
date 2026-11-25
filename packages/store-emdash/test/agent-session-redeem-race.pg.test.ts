/**
 * The hand-off claim and the live caps under REAL concurrency (ADR-0047):
 *  - N browsers claim one link at once, through the domain use-case: exactly one
 *    claims, every loser is HANDOFF_IN_PROGRESS, and once it finalizes another
 *    browser is HANDOFF_USED while the same browser re-enters its cart;
 *  - N racing creates under one `Idempotency-Key` store one session;
 *  - N racing inserts against live caps of 3 (store-wide, then per network)
 *    admit exactly 3: the slot documents never overshoot.
 *
 * Postgres-required: better-sqlite3 serializes writes in-process, so it verifies
 * the statements (the dialect contract does) but cannot lose a race.
 */
import {
	agentSessionId,
	claimAgentHandoff,
	createAgentSession,
	currency,
	finalizeAgentHandoff,
	productId,
	sku,
	type AgentCheckoutSession,
	type AgentSessionDeps,
} from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { EmdashAgentSessionStore, WebCryptoAgentSessionSecrets } from "../src/index.js";
import { AGENT_SESSION_LAYOUT } from "./agent-session-collections.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";

type DialectDb = Awaited<ReturnType<typeof makePgStorage>>;

const N = 16;
const SUITE = PG_ENABLED
	? "agent hand-off claim and live-cap races [pg]"
	: "agent hand-off claim and live-cap races [pg] (skipped: PG_CONNECTION_STRING unset)";

describe.skipIf(!PG_ENABLED)(SUITE, () => {
	let db: DialectDb;
	let deps: AgentSessionDeps;

	beforeAll(async () => {
		db = await makePgStorage(AGENT_SESSION_LAYOUT, N + 4);
	});
	afterAll(async () => {
		await db?.close();
	});
	beforeEach(async () => {
		await db.reset();
		deps = {
			store: new EmdashAgentSessionStore({ storage: db.storage }),
			clock: new FixedClock(new Date("2026-11-18T10:00:00.000Z")),
			secrets: new WebCryptoAgentSessionSecrets(new Uint8Array(32).fill(3)),
		};
	});

	const content = {
		currency: currency("USD"),
		lines: [{ productId: productId("p-1"), sku: sku("MUG-1"), quantity: 1 }],
	};

	test(`${N} concurrent claims of one link: exactly one claims; after finalize only that browser re-enters`, async () => {
		const created = await createAgentSession(deps, {
			networkKey: "net-a",
			idempotencyKey: "create-1",
			fingerprint: "fp",
			content,
		});
		if (!created.ok || created.handoffToken === undefined) throw new Error("create failed");
		const token = created.handoffToken;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) => claimAgentHandoff(deps, { token, redeemer: `b-${i}` })),
		);
		const winners = results.filter((r) => r.ok && r.status === "claimed");
		expect(winners).toHaveLength(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("HANDOFF_IN_PROGRESS");
		const won = winners[0];
		if (won === undefined || !won.ok || won.status !== "claimed") throw new Error("no winner");
		const done = await finalizeAgentHandoff(deps, {
			sessionId: won.session.id,
			claimId: won.claimId,
			cartId: "cart-shopper",
		});
		expect(done.ok).toBe(true);
		const winner = results.indexOf(won);
		expect(await claimAgentHandoff(deps, { token, redeemer: `b-${winner}` })).toMatchObject({
			ok: true,
			status: "reentered",
			shopperCartId: "cart-shopper",
		});
		expect(await claimAgentHandoff(deps, { token, redeemer: "someone-else" })).toEqual({
			ok: false,
			reason: "HANDOFF_USED",
		});
	});

	const NOW = "2026-11-18T10:00:00.000Z";
	function session(id: string, networkKey: string): AgentCheckoutSession {
		return {
			id: agentSessionId(id),
			revision: 0,
			status: "requires_escalation",
			currency: currency("USD"),
			lines: content.lines,
			orderSecretHash: `o-${id}`,
			linkGeneration: 0,
			redeemedHandoffs: [],
			channel: "other",
			networkKey,
			createdAt: NOW,
			updatedAt: NOW,
			expiresAt: "2026-11-19T10:00:00.000Z",
			purgeAt: "2026-11-19T11:00:00.000Z",
			writes: [],
			retiredWriteKeys: [],
		};
	}

	for (const [label, net, caps] of [
		["store-wide", (i: number) => `net-${i}`, { maxLive: 3, maxLivePerNetwork: 100 }],
		["per-network", () => "net-one", { maxLive: 100, maxLivePerNetwork: 3 }],
	] as const) {
		test(`${N} concurrent inserts at a ${label} cap of 3 admit exactly 3`, async () => {
			const results = await Promise.all(
				Array.from({ length: N }, (_, i) =>
					deps.store.insert(session(`cs_race_${i}`, net(i)), { now: NOW, ...caps }),
				),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(3);
			for (const r of results) if (!r.ok) expect(r.reason).toBe("capacity");
			expect(await deps.store.countLive(NOW)).toBe(3);
			expect(await deps.store.countSlotDocs()).toBe(6);
		});
	}

	test(`${N} concurrent creates under one key store one session`, async () => {
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				createAgentSession(deps, {
					networkKey: "net-a",
					idempotencyKey: "create-race",
					fingerprint: "fp",
					content,
				}),
			),
		);
		// A racer that found the record while the winner's insert was in flight is
		// answered WRITE_CONFLICT (retryable); every success names one session.
		const ids = new Set(results.flatMap((r) => (r.ok ? [r.session.id] : [])));
		expect(ids.size).toBe(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("WRITE_CONFLICT");
		const retry = await createAgentSession(deps, {
			networkKey: "net-a",
			idempotencyKey: "create-race",
			fingerprint: "fp",
			content,
		});
		expect(retry.ok && retry.session.id).toBe([...ids][0]);
		expect(await deps.store.countCreatedSince("net-a", "2026-01-01T00:00:00.000Z")).toBe(1);
	});
});
