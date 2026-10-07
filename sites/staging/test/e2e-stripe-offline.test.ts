/**
 * The dev-only offline Stripe gateway's SITE half (issue #378).
 *
 * The plugin arms its offline gateway only when this site bakes
 * `__OTTA_DEV_STRIPE_OFFLINE__` as `true` (`stripe-wiring.ts`, which also
 * requires a Vite dev build). This suite pins the site's side of that
 * contract: the define is `true` ONLY under `astro dev` with the variable set
 * to exactly "1", it is ALWAYS present (so the identifier is never undeclared),
 * and a production build with the variable set is REFUSED rather than quietly
 * baking `false`, because a variable someone exported for a build is a mistake
 * they should hear about.
 */
import { describe, expect, test } from "vitest";
import {
	DEV_STRIPE_OFFLINE_DEFINE,
	devStripeOfflineIntegration,
	E2E_STRIPE_OFFLINE_VAR,
	resolveDevStripeOffline,
} from "../src/lib/e2e-stripe-offline.js";

describe("resolveDevStripeOffline", () => {
	test("the variable's name is pinned: a renamed variable would silently never arm", () => {
		expect(E2E_STRIPE_OFFLINE_VAR).toBe("OTTA_E2E_STRIPE_OFFLINE");
		expect(DEV_STRIPE_OFFLINE_DEFINE).toBe("__OTTA_DEV_STRIPE_OFFLINE__");
	});

	test("on only under `astro dev` with the variable set to exactly 1", () => {
		expect(resolveDevStripeOffline("dev", "1")).toBe(true);
	});

	test("off by default, and off for anything that is not exactly 1", () => {
		expect(resolveDevStripeOffline("dev", undefined)).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1"]) {
			expect(resolveDevStripeOffline("dev", value), JSON.stringify(value)).toBe(false);
		}
	});

	test("a production BUILD with the variable set is refused, loudly", () => {
		expect(() => resolveDevStripeOffline("build", "1")).toThrow(/OTTA_E2E_STRIPE_OFFLINE/);
	});

	test("a build without it, and every other command, bakes false", () => {
		expect(resolveDevStripeOffline("build", undefined)).toBe(false);
		expect(resolveDevStripeOffline("preview", "1")).toBe(false);
		expect(resolveDevStripeOffline("sync", "1")).toBe(false);
	});
});

/** Run the integration's config hook the way Astro would, and collect the define. */
function runSetup(command: string, value: string | undefined): Record<string, unknown> {
	const integration = devStripeOfflineIntegration({ [E2E_STRIPE_OFFLINE_VAR]: value });
	let define: Record<string, unknown> = {};
	const hook = integration.hooks["astro:config:setup"] as unknown as (params: {
		command: string;
		updateConfig: (config: { vite?: { define?: Record<string, unknown> } }) => void;
		logger: { warn: (message: string) => void };
	}) => void;
	hook({
		command,
		updateConfig: (config) => {
			define = { ...define, ...config.vite?.define };
		},
		logger: { warn: () => undefined },
	});
	return define;
}

describe("devStripeOfflineIntegration", () => {
	test("ALWAYS bakes the define, as a JSON boolean, so the identifier is never undeclared", () => {
		expect(runSetup("dev", undefined)).toEqual({ [DEV_STRIPE_OFFLINE_DEFINE]: "false" });
		expect(runSetup("build", undefined)).toEqual({ [DEV_STRIPE_OFFLINE_DEFINE]: "false" });
	});

	test("bakes true under dev with the variable set", () => {
		expect(runSetup("dev", "1")).toEqual({ [DEV_STRIPE_OFFLINE_DEFINE]: "true" });
	});

	test("refuses a build with the variable set", () => {
		expect(() => runSetup("build", "1")).toThrow(/OTTA_E2E_STRIPE_OFFLINE/);
	});
});
