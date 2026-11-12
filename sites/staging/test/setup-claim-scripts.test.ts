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
	devSetupToken,
	setupClaimCookie,
	setupClaimHeaders,
} from "../../store/scripts/setup-claim-cookie.js";
import { DEV_VARS_PATH, e2eSetupToken } from "../e2e/setup-token.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_TOKEN_SECRET,
} from "../../store/src/lib/setup-claim-contract.js";
import { validateSetupTokenSecret } from "../../store/src/lib/setup-claim.js";

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

const LOCAL = "http://127.0.0.1:4500";
const REMOTE = "https://shop.example";

describe("the claim cookie a script sends", () => {
	test("built from OTTA_SETUP_TOKEN; nothing without it", () => {
		const options = { env: { [SETUP_TOKEN_SECRET]: "tok" }, devVarsPath: devVars };
		expect(setupClaimCookie(LOCAL, options)).toBe(`${SETUP_CLAIM_COOKIE}=tok`);
		expect(setupClaimCookie(LOCAL, { env: {}, devVarsPath: devVars })).toBeUndefined();
		expect(setupClaimHeaders(LOCAL, { env: {}, devVarsPath: devVars })).toEqual({});
	});

	test("the token in .dev.vars wins over the env, as it does for the dev Worker and e2eSetupToken", () => {
		writeFileSync(devVars, `EMDASH_ENCRYPTION_KEY=x\n${SETUP_TOKEN_SECRET}="from-file"\n`);
		expect(setupClaimCookie(LOCAL, { env: {}, devVarsPath: devVars })).toBe(
			`${SETUP_CLAIM_COOKIE}=from-file`,
		);
		expect(
			setupClaimCookie(LOCAL, { env: { [SETUP_TOKEN_SECRET]: "from-env" }, devVarsPath: devVars }),
		).toBe(`${SETUP_CLAIM_COOKIE}=from-file`);
		expect(setupClaimHeaders(LOCAL, { env: {}, devVarsPath: devVars })).toEqual({
			Cookie: `${SETUP_CLAIM_COOKIE}=from-file`,
		});
		expect(setupClaimCookie(LOCAL, { env: {}, devVarsPath: devVars })).toBe(
			`${SETUP_CLAIM_COOKIE}=${e2eSetupToken({}, devVars)}`,
		);
	});

	test.each(["http://localhost:4321", "http://[::1]:4321", "http://127.0.0.1:4321"])(
		"%s is loopback: the local .dev.vars is read",
		(site) => {
			writeFileSync(devVars, `${SETUP_TOKEN_SECRET}=from-file\n`);
			expect(setupClaimCookie(site, { env: {}, devVarsPath: devVars })).toBe(
				`${SETUP_CLAIM_COOKIE}=from-file`,
			);
		},
	);

	test("a *.localhost site is not loopback to a script: only the env token goes", () => {
		// The gate treats *.localhost as loopback, but Node may resolve it through
		// DNS on some hosts, so the local .dev.vars token is never sent to one.
		writeFileSync(devVars, `${SETUP_TOKEN_SECRET}=from-file\n`);
		expect(setupClaimCookie("http://x.localhost:4321", { env: {}, devVarsPath: devVars })).toBe(
			undefined,
		);
		expect(
			setupClaimCookie("http://x.localhost:4321", {
				env: { [SETUP_TOKEN_SECRET]: "from-env" },
				devVarsPath: devVars,
			}),
		).toBe(`${SETUP_CLAIM_COOKIE}=from-env`);
	});

	test("a REMOTE site never gets the local .dev.vars token; an explicit env token still goes", () => {
		writeFileSync(devVars, `${SETUP_TOKEN_SECRET}=from-file\n`);
		expect(setupClaimCookie(REMOTE, { env: {}, devVarsPath: devVars })).toBeUndefined();
		expect(setupClaimHeaders(REMOTE, { env: {}, devVarsPath: devVars })).toEqual({});
		expect(
			setupClaimCookie(REMOTE, { env: { [SETUP_TOKEN_SECRET]: "from-env" }, devVarsPath: devVars }),
		).toBe(`${SETUP_CLAIM_COOKIE}=from-env`);
		// A host that merely starts like a loopback one is not one.
		expect(
			setupClaimCookie("http://127.0.0.1.example.com", { env: {}, devVarsPath: devVars }),
		).toBeUndefined();
		// Not a URL at all: the env only.
		expect(setupClaimCookie("not a url", { env: {}, devVarsPath: devVars })).toBeUndefined();
	});

	test(".dev.vars without the variable falls back to the env", () => {
		writeFileSync(devVars, "EMDASH_ENCRYPTION_KEY=x\n");
		expect(
			setupClaimCookie(LOCAL, { env: { [SETUP_TOKEN_SECRET]: "from-env" }, devVarsPath: devVars }),
		).toBe(`${SETUP_CLAIM_COOKIE}=from-env`);
		expect(setupClaimCookie(LOCAL, { env: {}, devVarsPath: devVars })).toBeUndefined();
	});

	test("a padded token is trimmed exactly as the gate trims the secret", () => {
		const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const padded = `  ${token}\t `;
		const gate = validateSetupTokenSecret(padded);
		expect(gate).toEqual({ kind: "valid", token });
		writeFileSync(devVars, `${SETUP_TOKEN_SECRET}="${padded}"\n`);
		expect(devSetupToken({}, devVars)).toBe(token);
		expect(e2eSetupToken({}, devVars)).toBe(token);
		expect(devSetupToken({ [SETUP_TOKEN_SECRET]: padded }, `${devVars}.absent`)).toBe(token);
		expect(setupClaimCookie(REMOTE, { env: { [SETUP_TOKEN_SECRET]: padded } })).toBe(
			`${SETUP_CLAIM_COOKIE}=${token}`,
		);
	});

	test("the default .dev.vars is the dev store's, the file e2eSetupToken reads", () => {
		expect(SCRIPT_DEV_VARS_PATH).toBe(DEV_VARS_PATH);
	});

	test("cmsAuthHeaders sends it to the bypass AND keeps it beside the session cookie", async () => {
		vi.stubEnv("EMDASH_TOKEN", "");
		vi.stubEnv(SETUP_TOKEN_SECRET, "from-env");
		writeFileSync(devVars, `${SETUP_TOKEN_SECRET}=from-file\n`);
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { "Set-Cookie": "astro-session=abc; Path=/; HttpOnly" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "info").mockImplementation(() => undefined);

		const local = await cmsAuthHeaders(LOCAL, { devVarsPath: devVars });
		const sentLocal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(sentLocal.headers).toEqual({ Cookie: `${SETUP_CLAIM_COOKIE}=from-file` });
		expect(local).toEqual({ Cookie: `astro-session=abc; ${SETUP_CLAIM_COOKIE}=from-file` });

		// A remote site: the explicit env token, never the local file's.
		const remote = await cmsAuthHeaders(REMOTE, { devVarsPath: devVars });
		const sentRemote = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
		expect(sentRemote.headers).toEqual({ Cookie: `${SETUP_CLAIM_COOKIE}=from-env` });
		expect(remote).toEqual({ Cookie: `astro-session=abc; ${SETUP_CLAIM_COOKIE}=from-env` });
	});
});
