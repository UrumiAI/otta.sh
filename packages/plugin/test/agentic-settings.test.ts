/**
 * ADR-0047 settings, unit-level over a recording kv: the server key is created
 * only by compare-and-set (a host without it fails CLOSED, never a racy `set`), and
 * while the switch is off every agentic route answers NOT_FOUND having written
 * nothing — no server key, no storage touched.
 */
import { describe, expect, test, vi } from "vitest";
import {
	createAgenticHandoffRedeemHandler,
	createAgenticOrderHandler,
	createAgenticSessionCancelHandler,
	createAgenticSessionCompleteHandler,
	createAgenticSessionCreateHandler,
	createAgenticSessionGetHandler,
	createAgenticSessionUpdateHandler,
	createAgenticStatusHandler,
} from "../src/agentic/routes.js";
import {
	AGENTIC_ENABLED_KEY,
	AGENTIC_SERVER_KEY_KEY,
	readAgenticServerKey,
} from "../src/agentic/settings.js";
import type { PluginContext } from "../src/types.js";

interface Recorded {
	writes: string[];
	storageTouched: string[];
}

function fakeCtx(seed: Record<string, unknown>, withCas: boolean): [PluginContext, Recorded] {
	const values = new Map<string, unknown>(Object.entries(seed));
	const recorded: Recorded = { writes: [], storageTouched: [] };
	const kv: Record<string, unknown> = {
		async get(key: string) {
			return values.get(key) ?? null;
		},
		async set(key: string, value: unknown) {
			recorded.writes.push(key);
			values.set(key, value);
		},
		async delete(key: string) {
			recorded.writes.push(key);
			values.delete(key);
		},
	};
	if (withCas) {
		kv["compareAndSet"] = async (key: string, expected: unknown, value: unknown) => {
			recorded.writes.push(key);
			if ((values.get(key) ?? null) !== expected) return false;
			values.set(key, value);
			return true;
		};
	}
	const storage = new Proxy(
		{},
		{
			get(_target, name) {
				recorded.storageTouched.push(String(name));
				throw new Error("no storage while agentic checkout is off");
			},
		},
	);
	return [{ kv, storage } as unknown as PluginContext, recorded];
}

describe("the agentic server key", () => {
	test("created once by compare-and-set, then read back", async () => {
		const [ctx, recorded] = fakeCtx({}, true);
		const first = await readAgenticServerKey(ctx);
		expect(first?.byteLength).toBe(32);
		const again = await readAgenticServerKey(ctx);
		expect(again).toEqual(first);
		expect(recorded.writes).toEqual([AGENTIC_SERVER_KEY_KEY]);
	});

	test("a host without compare-and-set fails CLOSED: no key, nothing written", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const [ctx, recorded] = fakeCtx({}, false);
		expect(await readAgenticServerKey(ctx)).toBeNull();
		expect(recorded.writes).toEqual([]);
		// A fixed line, never a value.
		expect(error.mock.calls.flat().join(" ")).not.toMatch(/[A-Za-z0-9_-]{43}/);
		error.mockRestore();
	});
});

describe("switched off", () => {
	test("every route answers NOT_FOUND, writes no kv (no server key) and touches no storage", async () => {
		const handlers = [
			createAgenticSessionCreateHandler(),
			createAgenticSessionGetHandler(),
			createAgenticSessionUpdateHandler(),
			createAgenticSessionCancelHandler(),
			createAgenticSessionCompleteHandler(),
			createAgenticHandoffRedeemHandler(),
			createAgenticOrderHandler(),
			createAgenticStatusHandler(),
		];
		for (const seed of [{}, { [AGENTIC_ENABLED_KEY]: false }, { [AGENTIC_ENABLED_KEY]: "true" }]) {
			const [ctx, recorded] = fakeCtx(seed, true);
			for (const handler of handlers) {
				const result = await handler(
					{
						input: { idempotencyKey: "k", lines: [{ productId: "p", quantity: 1 }] },
						request: { headers: { "cf-connecting-ip": "198.51.100.1" } },
					} as never,
					ctx,
				);
				expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
			}
			expect(recorded.writes).toEqual([]);
			expect(recorded.storageTouched).toEqual([]);
		}
	});
});
