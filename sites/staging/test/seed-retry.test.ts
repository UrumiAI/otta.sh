import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { RetryableError, retryBounded } from "../scripts/retry.js";

const noSleep = (): Promise<void> => Promise.resolve();

describe("retryBounded", () => {
	test("returns the first success without waiting", async () => {
		let calls = 0;
		const out = await retryBounded(() => Promise.resolve(++calls), {
			attempts: 3,
			delayMs: 1,
			sleep: noSleep,
		});
		expect(out).toBe(1);
	});

	test("retries a RetryableError and returns the later success", async () => {
		let calls = 0;
		const waits: number[] = [];
		const out = await retryBounded(
			() => {
				calls++;
				if (calls < 3) return Promise.reject(new RetryableError("cold"));
				return Promise.resolve("ok");
			},
			{ attempts: 3, delayMs: 7, sleep: (ms) => (waits.push(ms), Promise.resolve()) },
		);
		expect(out).toBe("ok");
		expect(calls).toBe(3);
		expect(waits).toEqual([7, 7]);
	});

	test("is bounded: the last retryable error propagates after `attempts` tries", async () => {
		let calls = 0;
		await expect(
			retryBounded(
				() => {
					calls++;
					return Promise.reject(new RetryableError(`try ${String(calls)}`));
				},
				{ attempts: 3, delayMs: 1, sleep: noSleep },
			),
		).rejects.toThrow("try 3");
		expect(calls).toBe(3);
	});

	test("does not retry any other error", async () => {
		let calls = 0;
		await expect(
			retryBounded(
				() => {
					calls++;
					return Promise.reject(new Error("HTTP 403"));
				},
				{ attempts: 5, delayMs: 1, sleep: noSleep },
			),
		).rejects.toThrow("HTTP 403");
		expect(calls).toBe(1);
	});
});

describe("the e2e global setup's seed path (source pin; the setup itself needs a dev server)", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../e2e/global-setup.ts", import.meta.url)),
		"utf8",
	);
	const seedBranch = source.slice(source.indexOf("if (E2E_SEEDS) {"));

	test("asserts a loopback site before anything is seeded", () => {
		const guard = seedBranch.indexOf("assertLoopbackSite(E2E_BASE_URL)");
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(seedBranch.indexOf("await applyCmsSeed()"));
	});

	// EmDash 1.5 (emdash #4711): `/_emdash/api/auth/dev-bypass` answers 409
	// SETUP_REQUIRED until setup is complete, so a fresh stack has to be set up
	// (the setup dev-bypass) before the first dev sign-in, seeded or not.
	test("completes the setup before the first dev sign-in", () => {
		const body = source.slice(source.indexOf("export default async function globalSetup"));
		const setup = body.indexOf("await applyCmsSeed(");
		expect(setup).toBeGreaterThan(-1);
		expect(setup).toBeLessThan(body.indexOf("cmsAuthHeaders(E2E_BASE_URL)"));
		expect(body.indexOf("assertLoopbackSite(E2E_BASE_URL)")).toBeLessThan(setup);
	});

	test("an unseeded run sets the store up without the sample content", () => {
		const fn = source.slice(source.indexOf("async function applyCmsSeed"));
		expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('"?content=0"');
		expect(source).toContain("await applyCmsSeed(E2E_SEEDS)");
	});

	test("runs the dev-bypass seed through the bounded retry", () => {
		const fn = source.slice(source.indexOf("async function applyCmsSeed"));
		expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("retryBounded(");
	});
});
