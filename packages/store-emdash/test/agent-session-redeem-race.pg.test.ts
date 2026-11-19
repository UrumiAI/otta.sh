/**
 * The single-use hand-off link under REAL concurrency (ADR-0047): N shoppers'
 * browsers redeem one link at once, through the domain use-case, and exactly
 * one wins; every loser is told the link was used, and the session records one
 * use. Also: N racing creates under one `Idempotency-Key` store one session.
 *
 * Postgres-required: better-sqlite3 serializes writes in-process, so it verifies
 * the statements (the dialect contract does) but cannot lose a race.
 */
import {
	createAgentSession,
	currency,
	productId,
	redeemAgentHandoff,
	sku,
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
	? "agent hand-off redeem race [pg]"
	: "agent hand-off redeem race [pg] (skipped: PG_CONNECTION_STRING unset)";

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

	test(`${N} concurrent redeems of one link: exactly one wins, the rest are HANDOFF_USED`, async () => {
		const created = await createAgentSession(deps, {
			networkKey: "net-a",
			idempotencyKey: "create-1",
			fingerprint: "fp",
			content,
		});
		if (!created.ok || created.handoffToken === undefined) throw new Error("create failed");
		const token = created.handoffToken;
		const results = await Promise.all(
			Array.from({ length: N }, () => redeemAgentHandoff(deps, { token })),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const r of results) if (!r.ok) expect(r.reason).toBe("HANDOFF_USED");
		const stored = await deps.store.get(created.session.id);
		expect(stored?.handoffUsedAt).toBeDefined();
	});

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
		const ids = new Set(results.map((r) => (r.ok ? r.session.id : r.reason)));
		expect(ids.size).toBe(1);
		expect(await deps.store.countCreatedSince("net-a", "2026-01-01T00:00:00.000Z")).toBe(1);
	});
});
