/**
 * The e2e suite and the scripts hold the same setup token as the dev server
 * (ADR-0042; the store's `scripts/setup-claim-cookie.ts` and `e2e/setup-token.ts`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cmsAuthHeaders } from "../../store/scripts/seed-demo-commerce.js";
import {
	DEV_VARS_PATH as SCRIPT_DEV_VARS_PATH,
	setupClaimCookie,
	setupClaimHeaders,
} from "../../store/scripts/setup-claim-cookie.js";
import { DEV_VARS_PATH, e2eSetupToken } from "../e2e/setup-token.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_TOKEN_SECRET,
} from "../../store/src/lib/setup-claim-contract.js";

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
		expect(setupClaimCookie({ [SETUP_TOKEN_SECRET]: "tok" }, devVars)).toBe(
			`${SETUP_CLAIM_COOKIE}=tok`,
		);
		expect(setupClaimCookie({}, devVars)).toBeUndefined();
		expect(setupClaimHeaders({}, devVars)).toEqual({});
	});

	test("the token in .dev.vars wins over the env, as it does for the dev Worker and e2eSetupToken", () => {
		writeFileSync(devVars, `EMDASH_ENCRYPTION_KEY=x\n${SETUP_TOKEN_SECRET}="from-file"\n`);
		expect(setupClaimCookie({}, devVars)).toBe(`${SETUP_CLAIM_COOKIE}=from-file`);
		expect(setupClaimCookie({ [SETUP_TOKEN_SECRET]: "from-env" }, devVars)).toBe(
			`${SETUP_CLAIM_COOKIE}=from-file`,
		);
		expect(setupClaimHeaders({}, devVars)).toEqual({ Cookie: `${SETUP_CLAIM_COOKIE}=from-file` });
		expect(setupClaimCookie({}, devVars)).toBe(
			`${SETUP_CLAIM_COOKIE}=${e2eSetupToken({}, devVars)}`,
		);
	});

	test(".dev.vars without the variable falls back to the env", () => {
		writeFileSync(devVars, "EMDASH_ENCRYPTION_KEY=x\n");
		expect(setupClaimCookie({ [SETUP_TOKEN_SECRET]: "from-env" }, devVars)).toBe(
			`${SETUP_CLAIM_COOKIE}=from-env`,
		);
		expect(setupClaimCookie({}, devVars)).toBeUndefined();
	});

	test("the default .dev.vars is the dev store's, the file e2eSetupToken reads", () => {
		expect(SCRIPT_DEV_VARS_PATH).toBe(DEV_VARS_PATH);
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
		// The token the e2e suite presents, whatever the source: `tok` from the
		// env, unless a local sites/staging/.dev.vars sets one (it wins, as it
		// does for the dev Worker). Never the public fallback: the env has one.
		const claim = `${SETUP_CLAIM_COOKIE}=${e2eSetupToken()}`;
		expect(claim).not.toBe(`${SETUP_CLAIM_COOKIE}=${PUBLIC_E2E_SETUP_TOKEN}`);
		expect(sent.headers).toEqual({ Cookie: claim });
		expect(headers).toEqual({ Cookie: `astro-session=abc; ${claim}` });
	});
});
