/**
 * The e2e suite and the scripts hold the same setup token as the dev server
 * (ADR-0042; `scripts/setup-claim-cookie.ts`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cmsAuthHeaders } from "../scripts/seed-demo-commerce.js";
import {
	e2eSetupToken,
	setupClaimCookie,
	setupClaimHeaders,
} from "../scripts/setup-claim-cookie.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_TOKEN_SECRET,
} from "../src/lib/setup-claim-contract.js";

let dir: string;
let devVars: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "otta-dev-vars-"));
	devVars = path.join(dir, ".dev.vars");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("e2eSetupToken — the token the dev server holds", () => {
	test("no .dev.vars, no env: the public throwaway token", () => {
		expect(e2eSetupToken({}, devVars)).toBe(PUBLIC_E2E_SETUP_TOKEN);
	});

	test("no .dev.vars: the env's token", () => {
		expect(e2eSetupToken({ [SETUP_TOKEN_SECRET]: "from-env" }, devVars)).toBe("from-env");
	});

	test(".dev.vars with the variable wins over the env (wrangler gives the Worker the file)", () => {
		writeFileSync(devVars, `EMDASH_ENCRYPTION_KEY=x\n${SETUP_TOKEN_SECRET}="from-file"\n`);
		expect(e2eSetupToken({ [SETUP_TOKEN_SECRET]: "from-env" }, devVars)).toBe("from-file");
	});

	test(".dev.vars without the variable falls back to the env", () => {
		writeFileSync(devVars, "EMDASH_ENCRYPTION_KEY=x\n");
		expect(e2eSetupToken({ [SETUP_TOKEN_SECRET]: "from-env" }, devVars)).toBe("from-env");
	});
});

describe("the claim cookie a script sends", () => {
	test("built from OTTA_SETUP_TOKEN; nothing without it", () => {
		expect(setupClaimCookie({ [SETUP_TOKEN_SECRET]: "tok" })).toBe(`${SETUP_CLAIM_COOKIE}=tok`);
		expect(setupClaimCookie({})).toBeUndefined();
		expect(setupClaimHeaders({})).toEqual({});
	});

	test("cmsAuthHeaders sends it to the bypass AND keeps it beside the session cookie", async () => {
		vi.stubEnv("EMDASH_TOKEN", "");
		vi.stubEnv(SETUP_TOKEN_SECRET, "tok");
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { "Set-Cookie": "astro-session=abc; Path=/; HttpOnly" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const headers = await cmsAuthHeaders("http://127.0.0.1:4500");
		const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(sent.headers).toEqual({ Cookie: `${SETUP_CLAIM_COOKIE}=tok` });
		expect(headers).toEqual({ Cookie: `astro-session=abc; ${SETUP_CLAIM_COOKIE}=tok` });
	});
});
