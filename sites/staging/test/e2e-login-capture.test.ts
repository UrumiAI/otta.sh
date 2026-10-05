/**
 * The dev-only login-link capture's SITE half (e2e follow-up to issue #378).
 *
 * The plugin keeps the sign-in link in kv instead of mailing it only when this
 * site bakes `__OTTA_DEV_LOGIN_CAPTURE__` as `true` (`dev-login-capture.ts`,
 * which also requires a Vite dev build). This suite pins the site's side of
 * that contract, exactly as `e2e-stripe-offline.test.ts` pins the offline
 * gateway's: `true` ONLY under `astro dev` with the variable set to exactly
 * "1", ALWAYS baked (so the identifier is never undeclared), and a production
 * build with the variable set REFUSED rather than quietly baking `false`.
 */
import { describe, expect, test } from "vitest";
import {
	DEV_LOGIN_CAPTURE_DEFINE,
	devLoginCaptureIntegration,
	E2E_LOGIN_CAPTURE_VAR,
	resolveDevLoginCapture,
} from "../src/lib/e2e-login-capture.js";

describe("resolveDevLoginCapture", () => {
	test("the variable's name is pinned: a renamed variable would silently never arm", () => {
		expect(E2E_LOGIN_CAPTURE_VAR).toBe("OTTA_E2E_LOGIN_CAPTURE");
		expect(DEV_LOGIN_CAPTURE_DEFINE).toBe("__OTTA_DEV_LOGIN_CAPTURE__");
	});

	test("on only under `astro dev` with the variable set to exactly 1", () => {
		expect(resolveDevLoginCapture("dev", "1")).toBe(true);
	});

	test("off by default, and off for anything that is not exactly 1", () => {
		expect(resolveDevLoginCapture("dev", undefined)).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1"]) {
			expect(resolveDevLoginCapture("dev", value), JSON.stringify(value)).toBe(false);
		}
	});

	test("a production BUILD with the variable set is refused, loudly", () => {
		expect(() => resolveDevLoginCapture("build", "1")).toThrow(/OTTA_E2E_LOGIN_CAPTURE/);
	});

	test("a build without it, and every other command, bakes false", () => {
		expect(resolveDevLoginCapture("build", undefined)).toBe(false);
		expect(resolveDevLoginCapture("preview", "1")).toBe(false);
		expect(resolveDevLoginCapture("sync", "1")).toBe(false);
	});
});

/** Run the integration's config hook the way Astro would, and collect the define. */
function runSetup(command: string, value: string | undefined): Record<string, unknown> {
	const integration = devLoginCaptureIntegration({ [E2E_LOGIN_CAPTURE_VAR]: value });
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

describe("devLoginCaptureIntegration", () => {
	test("ALWAYS bakes the define, as a JSON boolean, so the identifier is never undeclared", () => {
		expect(runSetup("dev", undefined)).toEqual({ [DEV_LOGIN_CAPTURE_DEFINE]: "false" });
		expect(runSetup("build", undefined)).toEqual({ [DEV_LOGIN_CAPTURE_DEFINE]: "false" });
	});

	test("bakes true under dev with the variable set", () => {
		expect(runSetup("dev", "1")).toEqual({ [DEV_LOGIN_CAPTURE_DEFINE]: "true" });
	});

	test("refuses a build with the variable set", () => {
		expect(() => runSetup("build", "1")).toThrow(/OTTA_E2E_LOGIN_CAPTURE/);
	});
});
