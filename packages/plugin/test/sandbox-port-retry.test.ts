import { describe, expect, test, vi } from "vitest";
import { bootWithPortRetry } from "./sandbox/harness.js";

/**
 * INC-25: `loadPluginInSandbox` allocates a free port, then hands it to
 * workerd's own bind a moment later — under parallel suite load another
 * process can win the race in between (`workerd exited early ... bind(...):
 * Address already in use`). `bootWithPortRetry` is the extracted retry
 * wrapper; these tests stub the `boot` callback directly so the race and the
 * bound-retry/no-retry behavior are pinned without spawning a real workerd
 * process.
 */
describe("bootWithPortRetry (INC-25 port-bind race retry)", () => {
	test("an EADDRINUSE-shaped boot failure retries once with a FRESH port, then succeeds", async () => {
		const seenPorts: number[] = [];
		let attempt = 0;
		const boot = vi.fn(async (port: number) => {
			seenPorts.push(port);
			attempt += 1;
			if (attempt === 1) {
				throw new Error(
					"workerd exited early with code 1:\nbind(127.0.0.1:61234): Address already in use",
				);
			}
			return { port };
		});
		let nextPort = 40000;
		const allocatePort = vi.fn(async () => nextPort++);

		const result = await bootWithPortRetry(boot, { allocatePort, backoffMs: 0 });

		expect(result).toEqual({ port: 40001 });
		expect(boot).toHaveBeenCalledTimes(2);
		expect(allocatePort).toHaveBeenCalledTimes(2);
		// The retry must get a DIFFERENT port, not reattempt the doomed one.
		expect(seenPorts).toEqual([40000, 40001]);
	});

	test("a non-port boot failure is NOT retried — it fails on the first attempt", async () => {
		const boot = vi.fn(async () => {
			throw new Error("workerd exited early with code 1:\nSyntaxError: Unexpected token");
		});
		const allocatePort = vi.fn(async () => 50000);

		await expect(bootWithPortRetry(boot, { allocatePort, backoffMs: 0 })).rejects.toThrow(
			/Unexpected token/,
		);
		expect(boot).toHaveBeenCalledTimes(1);
		expect(allocatePort).toHaveBeenCalledTimes(1);
	});

	test("gives up after the bounded attempt count and still surfaces the bind-race error", async () => {
		const boot = vi.fn(async () => {
			throw new Error("bind(127.0.0.1:9): Address already in use");
		});
		const allocatePort = vi.fn(async () => 60000);

		await expect(
			bootWithPortRetry(boot, { allocatePort, maxAttempts: 3, backoffMs: 0 }),
		).rejects.toThrow(/Address already in use/);
		expect(boot).toHaveBeenCalledTimes(3);
	});

	test("a successful first attempt never retries", async () => {
		const boot = vi.fn(async (port: number) => ({ port }));
		const allocatePort = vi.fn(async () => 70000);

		const result = await bootWithPortRetry(boot, { allocatePort, backoffMs: 0 });

		expect(result).toEqual({ port: 70000 });
		expect(boot).toHaveBeenCalledTimes(1);
	});
});
