import { describe, expect, test } from "vitest";
import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
	type AgentSessionStoreHarness,
	InMemoryAgentSessionStore,
	requiredHarnessHook,
} from "@urumi.ai/otta-domain/testing";
import { FakeSecrets } from "./fake-secrets.js";

agentSessionStoreContract(
	async () => {
		const store = new InMemoryAgentSessionStore();
		return {
			store,
			crashInsertBeforeLanding: (session, capacity) =>
				store.insertCrashingBeforeLanding(session, capacity),
			crashInsertBeforeSessionWrite: (session, capacity) =>
				store.insertCrashingBeforeSessionWrite(session, capacity),
			countSessionDocuments: () => store.countSessionDocuments(),
			parkInsertAfterSlots: (session, capacity) => store.insertParkedAfterSlots(session, capacity),
		};
	},
	{ dialect: "fake" },
);

agentSessionSecretsContract(async (serverKey) => new FakeSecrets(serverKey), { dialect: "fake" });

async function providedHook(): Promise<number> {
	return 1;
}

describe("contract harness hooks", () => {
	test("the crash hooks are required: a harness without them does not typecheck", () => {
		// @ts-expect-error the crash, count and parking hooks are required
		const missing: AgentSessionStoreHarness = { store: new InMemoryAgentSessionStore() };
		expect(missing.store).toBeDefined();
	});

	test("an adapter that cannot provide a hook skips VISIBLY, with its reason; a provided hook runs", () => {
		const notes: (string | undefined)[] = [];
		const ctx = {
			skip: (note?: string): never => {
				notes.push(note);
				throw new Error("skipped");
			},
		};
		expect(() => requiredHarnessHook({ skip: "no crash point in SQL" }, ctx)).toThrow("skipped");
		expect(notes).toEqual(["harness hook unavailable: no crash point in SQL"]);
		expect(requiredHarnessHook(providedHook, ctx)).toBe(providedHook);
		expect(notes).toHaveLength(1);
	});
});
