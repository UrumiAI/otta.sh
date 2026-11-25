import { describe, expect, test } from "vitest";
import {
	agentSessionId,
	currency,
	productId,
	sku,
	type AgentCheckoutSession,
	type AgentSessionCapacity,
	type AgentSessionStore,
} from "@urumi.ai/otta-domain";
import { InMemoryAgentSessionStore } from "@urumi.ai/otta-domain/testing";

const T0 = "2026-11-18T10:00:00.000Z";

function session(id: string, networkKey: string): AgentCheckoutSession {
	return {
		id: agentSessionId(id),
		revision: 0,
		status: "requires_escalation",
		currency: currency("USD"),
		lines: [{ productId: productId("p"), sku: sku("S"), quantity: 1 }],
		orderSecretHash: "h",
		linkGeneration: 0,
		redeemedHandoffs: [],
		channel: "other",
		networkKey,
		createdAt: T0,
		updatedAt: T0,
		expiresAt: "2026-11-19T10:00:00.000Z",
		purgeAt: "2026-11-19T11:00:00.000Z",
		writes: [],
		retiredWriteKeys: [],
	};
}

/**
 * The design the contract must reject: count the live sessions, then insert. Over
 * the interleaving fake the count and the insert are separate steps, so racing
 * inserts all see room and all land.
 */
class CheckThenInsertStore extends InMemoryAgentSessionStore {
	override async insert(
		s: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): ReturnType<AgentSessionStore["insert"]> {
		if ((await this.countLive(capacity.now)) >= capacity.maxLive) {
			return { ok: false, reason: "capacity" };
		}
		return super.insert(s, { ...capacity, maxLive: 1_000_000, maxLivePerNetwork: 1_000_000 });
	}
}

async function race(store: AgentSessionStore): Promise<number> {
	const cap = { now: T0, maxLive: 3, maxLivePerNetwork: 100 };
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) => store.insert(session(`cs_i${i}`, `net-${i}`), cap)),
	);
	return results.filter((r) => r.ok).length;
}

describe("the fake interleaves racing callers, so the contract's race tests can fail", () => {
	test("a check-then-insert store overshoots the live cap under the same race", async () => {
		expect(await race(new CheckThenInsertStore())).toBeGreaterThan(3);
	});

	test("the slot-based fake admits exactly the cap", async () => {
		expect(await race(new InMemoryAgentSessionStore())).toBe(3);
	});
});
