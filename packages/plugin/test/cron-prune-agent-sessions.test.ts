/**
 * ADR-0047: the `prune-agent-sessions` leg deletes agent checkout sessions 30 days
 * after creation, with their hand-off link pointers and create keys, bounded per
 * tick. Sessions are made through the real domain use-cases on a clock in the
 * past and purged by real ticks over SQLite.
 */
import {
	AGENT_SESSION_RETENTION_MS,
	createAgentSession,
	currency,
	productId,
	redeemAgentHandoff,
	sku,
	type AgentSessionDeps,
} from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import {
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	collectionOf,
	EmdashAgentSessionStore,
	WebCryptoAgentSessionSecrets,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME } from "../src/cron/index.js";
import {
	AGENT_SESSION_PURGE_CALLS,
	INDEX_LAYOUT,
	LEG_PRIORITY,
	LEG_QUERY_COSTS,
	MAINTENANCE_LEGS,
	STARVING_TICKS,
	starvingLeg,
	tickOrder,
	UNPROMOTED_LEGS,
	type CommerceSweepSummary,
} from "../src/cron/sweeps.js";
import {
	type CallCounter,
	DAY_MS,
	memoryCursors,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
/** Created past the retention window: due. */
const OLD = new Date(NOW.getTime() - AGENT_SESSION_RETENTION_MS - DAY_MS);
/** Created inside it: kept. */
const RECENT = new Date(NOW.getTime() - DAY_MS);

let storage: StorageAccess;

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
}, 120_000);

function deps(at: Date): AgentSessionDeps {
	return {
		store: new EmdashAgentSessionStore({ storage }),
		clock: new FixedClock(at),
		secrets: new WebCryptoAgentSessionSecrets(new Uint8Array(32).fill(5)),
	};
}

/** A session created at `at` (with a link), its link redeemed when `redeem`. */
async function session(at: Date, key: string, redeem = false): Promise<string> {
	const d = deps(at);
	const created = await createAgentSession(d, {
		networkKey: "net-cron",
		idempotencyKey: key,
		fingerprint: `fp-${key}`,
		content: {
			currency: currency("USD"),
			lines: [{ productId: productId("p-1"), sku: sku("SKU-1"), quantity: 1 }],
		},
	});
	if (!created.ok || created.handoffToken === undefined) throw new Error("create failed");
	if (redeem) expect((await redeemAgentHandoff(d, { token: created.handoffToken })).ok).toBe(true);
	return created.session.id;
}

/** Cursors with every OTHER slow-cadence leg just run, so this leg is the only scan. */
async function onlyThisLegDue(): Promise<ReturnType<typeof memoryCursors>> {
	const cursors = memoryCursors();
	await cursors.write(
		"state",
		JSON.stringify({
			indexLayout: INDEX_LAYOUT,
			lastRun: Object.fromEntries(
				MAINTENANCE_LEGS.filter((name) => name !== "prune-agent-sessions").map((name) => [
					name,
					NOW.toISOString(),
				]),
			),
		}),
	);
	return cursors;
}

async function tick(
	cursors: ReturnType<typeof memoryCursors>,
	options: { queryBudget?: number; counter?: CallCounter } = {},
): Promise<CommerceSweepSummary> {
	return await runCommerceSweeps(sweepContext(storage, options.counter), SWEEP_TASK_NAME, {
		cursors,
		emailSender: recordingSender([]),
		now: NOW,
		queryBudget: options.queryBudget ?? 600,
	});
}

function leg(summary: CommerceSweepSummary) {
	const found = summary.legs.find((entry) => entry.leg === "prune-agent-sessions");
	if (found === undefined) throw new Error("the prune-agent-sessions leg must be in the summary");
	return found;
}

const count = (name: string): Promise<number> => collectionOf(storage, name).count({});

describe("prune-agent-sessions (ADR-0047 retention)", () => {
	test("slow cadence, never promoted, right after prune-carts", () => {
		expect(MAINTENANCE_LEGS).toContain("prune-agent-sessions");
		expect(UNPROMOTED_LEGS).toContain("prune-agent-sessions");
		expect(LEG_PRIORITY[LEG_PRIORITY.indexOf("prune-carts") + 1]).toBe("prune-agent-sessions");
		const waits = { "prune-agent-sessions": STARVING_TICKS * 10 };
		expect(tickOrder(waits).indexOf("prune-agent-sessions")).toBe(
			LEG_PRIORITY.indexOf("prune-agent-sessions"),
		);
		expect(starvingLeg(waits)).toBeUndefined();
		expect(LEG_QUERY_COSTS["prune-agent-sessions"].unit).toBe(AGENT_SESSION_PURGE_CALLS);
	});

	test("a session past 30 days goes, with its link pointers and create key; a recent one stays", async () => {
		const old = await session(OLD, "old-1", true);
		const recent = await session(RECENT, "recent-1");
		expect(await count(AGENT_SESSIONS_COLLECTION)).toBe(2);
		expect(await count(AGENT_SESSION_CREATE_KEYS_COLLECTION)).toBe(2);

		const summary = await tick(await onlyThisLegDue());

		expect(leg(summary)).toMatchObject({ ok: true, count: 1 });
		const sessions = new EmdashAgentSessionStore({ storage });
		expect(await sessions.get(old as never)).toBeNull();
		expect(await sessions.get(recent as never)).not.toBeNull();
		expect(await count(AGENT_SESSION_CREATE_KEYS_COLLECTION)).toBe(1);
		// Only the recent session's link pointer is left.
		expect(await count(AGENT_SESSION_LINKS_COLLECTION)).toBe(1);
	});

	test("bounded: one purge is at most AGENT_SESSION_PURGE_CALLS, and a tight budget leaves the rest for the next run", async () => {
		for (let i = 0; i < 4; i++) await session(OLD, `bulk-${String(i)}`, i % 2 === 0);
		const counter: CallCounter = { calls: 0 };
		const first = await tick(await onlyThisLegDue(), { queryBudget: 30, counter });
		const purged = leg(first).count;
		expect(purged).toBeGreaterThan(0);
		expect(purged).toBeLessThan(4);
		expect(await count(AGENT_SESSIONS_COLLECTION)).toBe(4 - purged);

		const second = await tick(await onlyThisLegDue());
		expect(leg(second).ok).toBe(true);
		expect(await count(AGENT_SESSIONS_COLLECTION)).toBe(0);
		expect(await count(AGENT_SESSION_LINKS_COLLECTION)).toBe(0);
		expect(await count(AGENT_SESSION_CREATE_KEYS_COLLECTION)).toBe(0);
	});
});
