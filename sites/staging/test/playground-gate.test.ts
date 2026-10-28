/**
 * The gate on a request that is not a page load: the admin console's own
 * fetch to the Otta plugin route. It must carry on (null) with the session
 * user stamped, or EmDash's dispatch throws on `createdAt` and answers 500.
 */
import type { APIContext } from "astro";
import { afterEach, describe, expect, test, vi } from "vitest";
import { playgroundGate } from "../src/lib/playground-gate.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function consoleFetch(user: unknown): APIContext {
	const url = new URL("https://try.otta.sh/_emdash/api/plugins/otta/admin");
	return {
		request: new Request(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: "{}",
		}),
		url,
		locals: { user },
	} as unknown as APIContext;
}

describe("playgroundGate on the admin console's fetch", () => {
	test("stamps createdAt on the playground build and carries on", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const shared = Object.freeze({
			id: "playground-admin",
			email: "playground@emdashcms.com",
			name: "Playground User",
			role: 50,
		});
		const context = consoleFetch(shared);
		expect(await playgroundGate(context)).toBeNull();
		const user = context.locals.user as unknown as Record<string, unknown>;
		expect(user["createdAt"]).toEqual(expect.any(String));
		expect(user["id"]).toBe("playground-admin");
		expect(shared).not.toHaveProperty("createdAt");
	});

	test("leaves the storefront build's user untouched", async () => {
		const user = { id: "u1", email: "a@b.c", name: null, role: 50 };
		const context = consoleFetch(user);
		expect(await playgroundGate(context)).toBeNull();
		expect(context.locals.user).toBe(user);
	});
});
