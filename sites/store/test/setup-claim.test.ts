/**
 * The setup-claim gate (ADR-0042): while EmDash setup is not complete, only the
 * holder of the one-time setup token may reach `/_emdash/*`.
 *
 * Runs against a REAL database: EmDash's own migrations on in-memory SQLite,
 * so the options and users tables are the ones the gate reads in production.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { OptionsRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_CLAIM_COOKIE_PATH,
	SETUP_CLAIM_MAX_AGE_SECONDS,
	SETUP_CLAIM_PATH,
	SETUP_TOKEN_PARAM,
	SETUP_TOKEN_SECRET,
	setupClaimUrl,
} from "../src/lib/setup-claim-contract.js";
import {
	createSetupClaimGate,
	ensureStoredSetupToken,
	generateSetupToken,
	SETUP_GATE_EXEMPT_ROUTES,
	SETUP_TOKEN_OPTION,
	setupGateApplies,
	validateSetupTokenSecret,
	type SetupClaimContext,
	type SetupClaimDb,
} from "../src/lib/setup-claim.js";

const HTTPS_SITE = "https://shop.example";
const LOCAL_SITE = "http://localhost:4321";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let db: SetupClaimDb;
let queries: number;

async function freshDb(): Promise<SetupClaimDb> {
	queries = 0;
	const created = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
		log: () => {
			queries += 1;
		},
	}) as SetupClaimDb;
	await runMigrations(created);
	queries = 0;
	return created;
}

/** Make the store claimed, exactly as EmDash's admin-verify step leaves it. */
async function completeSetup(target: SetupClaimDb, { users = true, flag = true } = {}) {
	if (users) {
		const now = new Date().toISOString();
		await target
			.insertInto("users")
			.values({
				id: "admin-1",
				email: "owner@shop.example",
				name: "Owner",
				role: 50,
				email_verified: 0,
				created_at: now,
				updated_at: now,
			})
			.execute();
	}
	if (flag) await new OptionsRepository(target).set("emdash:setup_complete", true);
	queries = 0;
}

interface Req {
	method?: string;
	path: string;
	routePattern?: string;
	cookie?: string;
	site?: string;
	accept?: string;
}

function ctx(req: Req, database: SetupClaimDb | null = db): SetupClaimContext {
	const url = new URL(req.path, req.site ?? HTTPS_SITE);
	const headers: Record<string, string> = {};
	if (req.accept !== undefined) headers["accept"] = req.accept;
	return {
		request: new Request(url, { method: req.method ?? "GET", headers }),
		url,
		routePattern: req.routePattern ?? url.pathname,
		cookies: {
			get: (name: string) =>
				name === SETUP_CLAIM_COOKIE && req.cookie !== undefined ? { value: req.cookie } : undefined,
		},
		locals: database === null ? {} : { emdash: { db: database } },
	};
}

const ADMIN_PAGE = "/_emdash/admin/[...path]";
const SETUP_ADMIN_API = "/_emdash/api/setup/admin";

/** A gate whose generator and log are observable, with no env secret. */
function gate(opts: { tokens?: string[] } = {}) {
	const tokens = [...(opts.tokens ?? [])];
	const log = vi.fn<(line: string) => void>();
	const warn = vi.fn<(line: string) => void>();
	const g = createSetupClaimGate({
		generate: () => tokens.shift() ?? generateSetupToken(),
		log,
		warn,
	});
	return { g, log, warn };
}

beforeEach(async () => {
	db = await freshDb();
});

afterEach(async () => {
	await db.destroy();
});

// ── which requests the gate looks at ──────────────────────────────────────

describe("setupGateApplies — keyed on the route, never only on the spelling", () => {
	test.each([
		["/", "/"],
		["/products", "/products"],
		["/cart/add", "/cart/add"],
		["/checkout/pay", "/checkout/pay"],
		["/_astro/x.js", "/_astro/x.js"],
		["/_image", "/_image"],
		["/webhooks/stripe", "/webhooks/stripe"],
	])("storefront %s is never gated", (path, route) => {
		expect(setupGateApplies(route, path)).toBe(false);
	});

	test.each([
		[SETUP_ADMIN_API, SETUP_ADMIN_API],
		["/_emdash/api/setup", "/_emdash/api/setup"],
		["/_emdash/api/setup/admin/verify", "/_emdash/api/setup/admin/verify"],
		["/_emdash/api/setup/dev-bypass", "/_emdash/api/setup/dev-bypass"],
		["/_emdash/api/setup/dev-reset", "/_emdash/api/setup/dev-reset"],
		["/_emdash/api/setup/status", "/_emdash/api/setup/status"],
		["/_emdash/api/auth/dev-bypass", "/_emdash/api/auth/dev-bypass"],
		["/_emdash/api/auth/passkey/register/verify", "/_emdash/api/auth/passkey/register/verify"],
		["/_emdash/api/auth/oauth/github/callback", "/_emdash/api/auth/oauth/[provider]/callback"],
		["/_emdash/api/auth/signup/complete", "/_emdash/api/auth/signup/complete"],
		["/_emdash/api/auth/invite/complete", "/_emdash/api/auth/invite/complete"],
		["/_emdash/api/auth/magic-link/verify", "/_emdash/api/auth/magic-link/verify"],
		["/_emdash/admin/setup", ADMIN_PAGE],
		["/_emdash/admin", ADMIN_PAGE],
		["/_emdash/api/oauth/register", "/_emdash/api/oauth/register"],
		["/_emdash/api/some-future-route", "/_emdash/api/some-future-route"],
	])("%s is gated (default-deny under /_emdash)", (path, route) => {
		expect(setupGateApplies(route, path)).toBe(true);
	});

	test.each([
		["/_emdash/api/media/file/a.png", "/_emdash/api/media/file/[...key]"],
		[
			"/_emdash/api/plugins/otta/storefront/cart/create",
			"/_emdash/api/plugins/[pluginId]/[...path]",
		],
		["/_emdash/api/health", "/_emdash/api/health"],
	])("%s is exempt: it cannot create a user or finish setup", (path, route) => {
		expect(setupGateApplies(route, path)).toBe(false);
	});

	test("a percent-encoded spelling of /_emdash is still gated", () => {
		expect(setupGateApplies(SETUP_ADMIN_API, "/%5Femdash/api/setup/admin")).toBe(true);
		expect(setupGateApplies("/[...slug]", "/%5Femdash/api/setup/admin")).toBe(true);
	});

	test("with no matched route, the path alone decides", () => {
		expect(setupGateApplies(undefined, "/_emdash/api/setup/admin")).toBe(true);
		expect(setupGateApplies(undefined, "/products")).toBe(false);
	});

	test("an exempt-looking PATH on a gated ROUTE is gated", () => {
		expect(setupGateApplies(SETUP_ADMIN_API, "/_emdash/api/media/file/x")).toBe(true);
	});
});

// ── the Worker secret ─────────────────────────────────────────────────────

describe("validateSetupTokenSecret — minimum length and entropy", () => {
	test("absent or empty is 'unset', not invalid", () => {
		expect(validateSetupTokenSecret(undefined)).toEqual({ kind: "unset" });
		expect(validateSetupTokenSecret("")).toEqual({ kind: "unset" });
	});

	test.each([
		["too short", "abcDEF0123456789"],
		["not URL-safe", `${SECRET.slice(0, 40)}+/=${SECRET.slice(0, 10)}`],
		["low entropy (one character)", "a".repeat(64)],
		["low entropy (few distinct characters)", "abcdefgh".repeat(4)],
		["not a string", 42],
	])("refuses a secret that is %s", (_why, value) => {
		expect(validateSetupTokenSecret(value).kind).toBe("invalid");
	});

	test.each([
		["64 hex characters (openssl rand -hex 32)", SECRET],
		["a generated token", generateSetupToken()],
	])("accepts %s", (_why, value) => {
		expect(validateSetupTokenSecret(value)).toEqual({ kind: "valid", token: value });
	});

	test("a generated token is 256 bits, base64url", () => {
		const token = generateSetupToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(generateSetupToken()).not.toBe(token);
	});
});

// ── unclaimed: refusals ───────────────────────────────────────────────────

describe("while unclaimed — no token, no way in", () => {
	test("no token: the admin page is a 403 HTML page that says where the link is", async () => {
		const { g } = gate();
		const res = await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		expect(res?.status).toBe(403);
		expect(res?.headers.get("content-type")).toContain("text/html");
		expect(res?.headers.get("cache-control")).toContain("no-store");
		expect(res?.headers.get("referrer-policy")).toBe("no-referrer");
		const body = (await res?.text()) ?? "";
		expect(body).toContain("Workers Logs");
		expect(body).toContain(SETUP_TOKEN_SECRET);
		expect(body).toContain(SETUP_CLAIM_PATH);
	});

	test("no token: a setup write is a 403 JSON error and never reaches EmDash", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }),
			{},
		);
		expect(res?.status).toBe(403);
		expect(await res?.json()).toEqual({
			error: { code: "SETUP_CLAIM_REQUIRED", message: expect.any(String) },
		});
	});

	test.each([
		["/_emdash/api/setup", "POST"],
		["/_emdash/api/setup/admin/verify", "POST"],
		["/_emdash/api/setup/dev-bypass", "GET"],
		["/_emdash/api/setup/dev-reset", "POST"],
		["/_emdash/api/auth/dev-bypass", "GET"],
		["/_emdash/api/auth/passkey/options", "POST"],
		["/_emdash/api/auth/passkey/verify", "POST"],
		["/_emdash/api/auth/signup/complete", "POST"],
		["/_emdash/api/auth/invite/complete", "POST"],
		["/_emdash/api/auth/magic-link/verify", "GET"],
	])("no token: %s (%s) is refused", async (route, method) => {
		const { g } = gate();
		const res = await g.check(ctx({ method, path: route, routePattern: route }), {});
		expect(res?.status).toBe(403);
	});

	test("wrong token in the link: 403, no cookie", async () => {
		const { g } = gate({ tokens: ["T".repeat(43)] });
		const res = await g.check(
			ctx({ path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=nope`, routePattern: ADMIN_PAGE }),
			{},
		);
		expect(res?.status).toBe(403);
		expect(res?.headers.get("set-cookie")).toBeNull();
	});

	test("wrong token in the cookie: 403", async () => {
		const { g } = gate({ tokens: ["T".repeat(43)] });
		const res = await g.check(
			ctx({
				method: "POST",
				path: SETUP_ADMIN_API,
				routePattern: SETUP_ADMIN_API,
				cookie: "U".repeat(43),
			}),
			{},
		);
		expect(res?.status).toBe(403);
	});

	test("the refusal is the SAME whether the token is a secret, generated, or a broken secret", async () => {
		const page = { path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE };
		const bodies = new Set<string>();
		for (const env of [{}, { [SETUP_TOKEN_SECRET]: SECRET }, { [SETUP_TOKEN_SECRET]: "short" }]) {
			const { g } = gate();
			const res = await g.check(ctx(page), env);
			expect(res?.status).toBe(403);
			bodies.add(await (res as Response).text());
		}
		expect(bodies.size).toBe(1);
	});

	test("no database binding: fails closed (503), never open", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }, null),
			{ [SETUP_TOKEN_SECRET]: SECRET },
		);
		expect(res?.status).toBe(503);
	});

	test("a database error: fails closed (503)", async () => {
		const { g, warn } = gate();
		await db.destroy();
		const broken = await freshDb();
		await broken.destroy();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }, broken),
			{},
		);
		expect(res?.status).toBe(503);
		expect(warn).toHaveBeenCalled();
		db = await freshDb();
	});
});

// ── unclaimed: the link and the cookie ────────────────────────────────────

describe("while unclaimed — the link sets the cookie and strips itself from the URL", () => {
	test("correct token: 200 refresh page to the clean URL, with the claim cookie", async () => {
		const { g } = gate({ tokens: ["T".repeat(43)] });
		// First touch mints the generated token.
		await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		const res = await g.check(
			ctx({
				path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${"T".repeat(43)}&step=1`,
				routePattern: ADMIN_PAGE,
			}),
			{},
		);
		expect(res?.status).toBe(200);
		expect(res?.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res?.headers.get("cache-control")).toContain("no-store");
		const cookie = res?.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`${SETUP_CLAIM_COOKIE}=${"T".repeat(43)}`);
		expect(cookie).toContain(`Path=${SETUP_CLAIM_COOKIE_PATH}`);
		expect(cookie).toContain(`Max-Age=${String(SETUP_CLAIM_MAX_AGE_SECONDS)}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Secure");
		const body = (await res?.text()) ?? "";
		expect(body).toContain(`http-equiv="refresh"`);
		expect(body).toContain(`${SETUP_CLAIM_PATH}?step=1`);
		expect(body).not.toContain("T".repeat(43));
	});

	test("on localhost the cookie is not Secure (the dev server is plain HTTP)", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({
				site: LOCAL_SITE,
				path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${SECRET}`,
				routePattern: ADMIN_PAGE,
			}),
			{ [SETUP_TOKEN_SECRET]: SECRET },
		);
		expect(res?.status).toBe(200);
		expect(res?.headers.get("set-cookie")).not.toContain("Secure");
	});

	test("the token in a WRITE's query string is ignored: only the cookie admits writes", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({
				method: "POST",
				path: `${SETUP_ADMIN_API}?${SETUP_TOKEN_PARAM}=${SECRET}`,
				routePattern: SETUP_ADMIN_API,
			}),
			{ [SETUP_TOKEN_SECRET]: SECRET },
		);
		expect(res?.status).toBe(403);
	});

	test.each(["GET", "HEAD"])(
		"a stale token in the link (%s) with a valid cookie: the cookie admits it",
		async (method) => {
			// The deployer reopens an old link after setting the secret: the
			// query token no longer matches, but the browser holds the claim.
			const { g } = gate();
			const res = await g.check(
				ctx({
					method,
					path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${"S".repeat(43)}`,
					routePattern: ADMIN_PAGE,
					cookie: SECRET,
				}),
				{ [SETUP_TOKEN_SECRET]: SECRET },
			);
			expect(res).toBeNull();
		},
	);

	test.each([
		["no cookie", undefined],
		["a wrong cookie", "U".repeat(43)],
		["the stale token as the cookie", "S".repeat(43)],
	])("a stale token in the link with %s: still 403, no cookie", async (_why, cookie) => {
		const { g } = gate();
		const res = await g.check(
			ctx({
				path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${"S".repeat(43)}`,
				routePattern: ADMIN_PAGE,
				...(cookie === undefined ? {} : { cookie }),
			}),
			{ [SETUP_TOKEN_SECRET]: SECRET },
		);
		expect(res?.status).toBe(403);
		expect(res?.headers.get("set-cookie")).toBeNull();
	});

	test("the cookie lets every setup write and the wizard page through", async () => {
		const { g } = gate();
		const env = { [SETUP_TOKEN_SECRET]: SECRET };
		for (const [method, route] of [
			["GET", ADMIN_PAGE],
			["GET", "/_emdash/api/setup/status"],
			["POST", "/_emdash/api/setup"],
			["POST", SETUP_ADMIN_API],
			["POST", "/_emdash/api/setup/admin/verify"],
		] as const) {
			const path = route === ADMIN_PAGE ? SETUP_CLAIM_PATH : route;
			expect(
				await g.check(ctx({ method, path, routePattern: route, cookie: SECRET }), env),
			).toBeNull();
		}
	});
});

// ── where the token comes from ────────────────────────────────────────────

describe("token source — the Worker secret first, else one generated and kept in D1", () => {
	test("a valid secret is the token; nothing is written to the database", async () => {
		const { g, log } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API, cookie: SECRET }),
			{ [SETUP_TOKEN_SECRET]: SECRET },
		);
		expect(res).toBeNull();
		expect(await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)).toBeNull();
		expect(log).not.toHaveBeenCalled();
	});

	test("the secret wins over a token already stored in the database", async () => {
		await new OptionsRepository(db).set(SETUP_TOKEN_OPTION, "S".repeat(43));
		const { g } = gate();
		const env = { [SETUP_TOKEN_SECRET]: SECRET };
		const write = (cookie: string) =>
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API, cookie });
		expect(await g.check(write(SECRET), env)).toBeNull();
		expect((await g.check(write("S".repeat(43)), env))?.status).toBe(403);
	});

	test("an invalid secret fails CLOSED: not even its own value admits, and no token is generated", async () => {
		const { g, log, warn } = gate();
		const weak = "a".repeat(64);
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API, cookie: weak }),
			{ [SETUP_TOKEN_SECRET]: weak },
		);
		expect(res?.status).toBe(403);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(SETUP_TOKEN_SECRET));
		expect(log).not.toHaveBeenCalled();
		expect(await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)).toBeNull();
	});

	test("no secret: the first gated request mints a token, stores it, and logs the full link ONCE", async () => {
		const token = "G".repeat(43);
		const { g, log } = gate({ tokens: [token] });
		await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		expect(await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)).toBe(token);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toContain(setupClaimUrl(HTTPS_SITE, token));
		// A second isolate finds it stored and logs nothing.
		const other = gate({ tokens: ["X".repeat(43)] });
		const res = await other.g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API, cookie: token }),
			{},
		);
		expect(res).toBeNull();
		expect(other.log).not.toHaveBeenCalled();
	});

	test("the race: concurrent first requests in different isolates agree on ONE token", async () => {
		const results = await Promise.all(
			["A", "B", "C", "D"].map((c) => ensureStoredSetupToken(db, () => c.repeat(43))),
		);
		const tokens = new Set(results.map((r) => r.token));
		expect(tokens.size).toBe(1);
		expect(results.filter((r) => r.minted)).toHaveLength(1);
		expect(await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)).toBe([...tokens][0]);
	});

	test("the race through the gate: two isolates, one log line, both accept the stored token", async () => {
		const a = gate({ tokens: ["A".repeat(43)] });
		const b = gate({ tokens: ["B".repeat(43)] });
		const page = { path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE };
		await Promise.all([a.g.check(ctx(page), {}), b.g.check(ctx(page), {})]);
		expect(a.log.mock.calls.length + b.log.mock.calls.length).toBe(1);
		const stored = (await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)) as string;
		const write = {
			method: "POST",
			path: SETUP_ADMIN_API,
			routePattern: SETUP_ADMIN_API,
			cookie: stored,
		};
		expect(await a.g.check(ctx(write), {})).toBeNull();
		expect(await b.g.check(ctx(write), {})).toBeNull();
	});
});

// ── claimed: inert ────────────────────────────────────────────────────────

describe("once setup is complete — inert, and free", () => {
	test("complete: everything passes with no token, and after the first look NO query runs", async () => {
		await completeSetup(db);
		const { g } = gate();
		const write = { method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API };
		expect(await g.check(ctx(write), {})).toBeNull();
		expect(queries).toBe(1);
		for (let i = 0; i < 5; i += 1) {
			expect(
				await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {}),
			).toBeNull();
			expect(await g.check(ctx(write), {})).toBeNull();
		}
		expect(queries).toBe(1);
	});

	test("the flag alone is not complete: no users means the admin can still be created", async () => {
		await completeSetup(db, { users: false });
		const { g } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }),
			{},
		);
		expect(res?.status).toBe(403);
	});

	test("a user alone is not complete: the setup flag must be set too", async () => {
		await completeSetup(db, { flag: false });
		const { g } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: "/_emdash/api/setup", routePattern: "/_emdash/api/setup" }),
			{},
		);
		expect(res?.status).toBe(403);
	});

	test("an unclaimed look is NOT cached: completion is seen on the very next request", async () => {
		const { g } = gate();
		const write = { method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API };
		expect((await g.check(ctx(write), {}))?.status).toBe(403);
		await completeSetup(db);
		expect(await g.check(ctx(write), {})).toBeNull();
	});
});

// ── the storefront never pays ─────────────────────────────────────────────

describe("storefront requests never touch the gate", () => {
	test("no database access, no query, whatever the state", async () => {
		const trap = new Proxy(
			{},
			{
				get() {
					throw new Error("the gate touched the database on a storefront request");
				},
			},
		) as SetupClaimDb;
		const { g } = gate();
		for (const [method, path] of [
			["GET", "/"],
			["GET", "/products"],
			["POST", "/cart/add"],
			["POST", "/checkout/place"],
			["GET", "/_astro/app.js"],
		] as const) {
			expect(await g.check(ctx({ method, path }, trap), {})).toBeNull();
		}
		expect(queries).toBe(0);
	});
});

// ── review round 1 ────────────────────────────────────────────────────────

const PLUGIN_ROUTE = "/_emdash/api/plugins/[pluginId]/[...path]";
const HTTP_SITE = "http://shop.example";

describe("every method: the gate is not a GET/POST special case", () => {
	test.each(["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"])(
		"%s to a gated route: 403 without the token, through with the cookie",
		async (method) => {
			const { g } = gate();
			const env = { [SETUP_TOKEN_SECRET]: SECRET };
			const req = { method, path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API };
			expect((await g.check(ctx(req), env))?.status).toBe(403);
			expect(await g.check(ctx({ ...req, cookie: SECRET }), env)).toBeNull();
		},
	);

	test.each(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
		"%s to an exempt route (plugin catch-all): through without a token",
		async (method) => {
			const { g } = gate();
			const req = {
				method,
				path: "/_emdash/api/plugins/otta/storefront/cart/create",
				routePattern: PLUGIN_ROUTE,
			};
			expect(await g.check(ctx(req), { [SETUP_TOKEN_SECRET]: SECRET })).toBeNull();
		},
	);
});

describe("drift: the exempt routes are routes the installed EmDash injects", () => {
	const emdashAstro = fileURLToPath(
		new URL("../node_modules/emdash/dist/astro/index.mjs", import.meta.url),
	);
	const injected = new Set(
		[...readFileSync(emdashAstro, "utf8").matchAll(/pattern:\s*"([^"]+)"/g)].map((m) => m[1]),
	);

	test("the route list was read", () => {
		expect(injected.size).toBeGreaterThan(100);
	});

	test.each([...SETUP_GATE_EXEMPT_ROUTES.keys()])(
		"%s is still an injected route pattern (a rename would 403 it while unclaimed)",
		(route) => {
			expect(injected).toContain(route);
		},
	);

	test("the claim link's page is served by the admin catch-all", () => {
		expect(injected).toContain(ADMIN_PAGE);
	});
});

describe("plain HTTP: no cleartext link, no silently dropped cookie", () => {
	test("a first request over HTTP logs an https:// link", async () => {
		const token = "H".repeat(43);
		const { g, log } = gate({ tokens: [token] });
		await g.check(ctx({ site: HTTP_SITE, path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toContain(setupClaimUrl("https://shop.example", token));
		expect(log.mock.calls[0]?.[0]).not.toContain("http://shop.example");
	});

	test("on loopback the logged link stays http:// (the dev server has no TLS)", async () => {
		const token = "L".repeat(43);
		const { g, log } = gate({ tokens: [token] });
		await g.check(ctx({ site: LOCAL_SITE, path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		expect(log.mock.calls[0]?.[0]).toContain(setupClaimUrl(LOCAL_SITE, token));
	});

	test.each([
		["the right token", SECRET],
		["a wrong token", "nope"],
	])(
		"a link with %s over HTTP off loopback is moved to HTTPS, with no cookie",
		async (_why, token) => {
			const { g } = gate();
			const res = await g.check(
				ctx({
					site: HTTP_SITE,
					path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${token}`,
					routePattern: ADMIN_PAGE,
				}),
				{ [SETUP_TOKEN_SECRET]: SECRET },
			);
			expect(res?.status).toBe(307);
			expect(res?.headers.get("location")).toBe(
				`https://shop.example${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${token}`,
			);
			expect(res?.headers.get("set-cookie")).toBeNull();
			expect(res?.headers.get("referrer-policy")).toBe("no-referrer");
		},
	);
});

describe("the public e2e token", () => {
	test("is a token the length/entropy check alone would accept", () => {
		expect(validateSetupTokenSecret(PUBLIC_E2E_SETUP_TOKEN).kind).toBe("valid");
	});

	test("is refused as OTTA_SETUP_TOKEN off loopback: fails closed, with the secret warning", async () => {
		const { g, warn, log } = gate();
		const env = { [SETUP_TOKEN_SECRET]: PUBLIC_E2E_SETUP_TOKEN };
		const write = {
			method: "POST",
			path: SETUP_ADMIN_API,
			routePattern: SETUP_ADMIN_API,
			cookie: PUBLIC_E2E_SETUP_TOKEN,
		};
		expect((await g.check(ctx(write), env))?.status).toBe(403);
		const link = await g.check(
			ctx({
				path: `${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${PUBLIC_E2E_SETUP_TOKEN}`,
				routePattern: ADMIN_PAGE,
			}),
			env,
		);
		expect(link?.status).toBe(403);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain(SETUP_TOKEN_SECRET);
		expect(warn.mock.calls[0]?.[0]).toContain("public e2e token");
		expect(log).not.toHaveBeenCalled();
		expect(await new OptionsRepository(db).get(SETUP_TOKEN_OPTION)).toBeNull();
	});

	test("is accepted on a loopback host (the e2e dev server)", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({
				site: LOCAL_SITE,
				method: "POST",
				path: SETUP_ADMIN_API,
				routePattern: SETUP_ADMIN_API,
				cookie: PUBLIC_E2E_SETUP_TOKEN,
			}),
			{ [SETUP_TOKEN_SECRET]: PUBLIC_E2E_SETUP_TOKEN },
		);
		expect(res).toBeNull();
	});
});

describe("operator warnings are once per isolate", () => {
	test("no database: refused every time, warned once", async () => {
		const { g, warn } = gate();
		for (let i = 0; i < 3; i += 1) {
			const res = await g.check(
				ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }, null),
				{},
			);
			expect(res?.status).toBe(503);
		}
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test("the refusal names the dev server's console as well as the Worker's logs", async () => {
		const { g } = gate();
		const res = await g.check(
			ctx({ method: "POST", path: SETUP_ADMIN_API, routePattern: SETUP_ADMIN_API }),
			{},
		);
		const body = (await res?.json()) as { error: { message: string } };
		expect(body.error.message).toContain("dev server's console");
		const page = await g.check(ctx({ path: SETUP_CLAIM_PATH, routePattern: ADMIN_PAGE }), {});
		expect(await page?.text()).toContain("dev server's console");
	});
});
