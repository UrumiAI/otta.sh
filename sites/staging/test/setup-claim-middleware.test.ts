/**
 * The setup-claim gate is wired into `src/middleware.ts` (ADR-0042): it runs
 * on every request, refuses an unclaimed store's `/_emdash/*` before EmDash's
 * route runs, and never touches a storefront request.
 */
import Database from "better-sqlite3";
import { OptionsRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { onRequest } from "../src/middleware.js";
import {
	SETUP_CLAIM_COOKIE,
	SETUP_CLAIM_PATH,
	SETUP_TOKEN_PARAM,
	SETUP_TOKEN_SECRET,
} from "../src/lib/setup-claim-contract.js";
import { resetSetupClaimForTesting, type SetupClaimDb } from "../src/lib/setup-claim.js";
import { env } from "./helpers/virtual-emdash-env.js";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SITE = "https://shop.example";

let db: SetupClaimDb;
let queries = 0;

function context(
	method: string,
	path: string,
	routePattern: string,
	opts: { cookie?: string; database?: unknown } = {},
) {
	const url = new URL(path, SITE);
	return {
		request: new Request(url, { method }),
		url,
		routePattern,
		cookies: {
			get: (name: string) =>
				name === SETUP_CLAIM_COOKIE && opts.cookie !== undefined
					? { value: opts.cookie }
					: undefined,
			set: vi.fn(),
			delete: vi.fn(),
		},
		locals: { emdash: { db: opts.database ?? db } },
		cache: { set: vi.fn() },
	};
}

function endpoint() {
	return vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
}

beforeEach(async () => {
	resetSetupClaimForTesting();
	env[SETUP_TOKEN_SECRET] = SECRET;
	db = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
		log: () => {
			queries += 1;
		},
	}) as SetupClaimDb;
	await runMigrations(db);
	queries = 0;
});

afterEach(async () => {
	delete env[SETUP_TOKEN_SECRET];
	vi.unstubAllGlobals();
	await db.destroy();
});

describe("the middleware runs the setup-claim gate", () => {
	test("unclaimed, no token: the setup write is refused and EmDash's route never runs", async () => {
		const next = endpoint();
		const res = await runMiddleware(
			context("POST", "/_emdash/api/setup/admin", "/_emdash/api/setup/admin"),
			next,
		);
		expect(res.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	test("unclaimed, the link: claim page with the cookie, route never runs", async () => {
		const next = endpoint();
		const res = await runMiddleware(
			context(
				"GET",
				`${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=${SECRET}`,
				"/_emdash/admin/[...path]",
			),
			next,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain(`${SETUP_CLAIM_COOKIE}=${SECRET}`);
		expect(next).not.toHaveBeenCalled();
	});

	test("unclaimed, with the cookie: the setup write reaches EmDash", async () => {
		const next = endpoint();
		const res = await runMiddleware(
			context("POST", "/_emdash/api/setup/admin", "/_emdash/api/setup/admin", { cookie: SECRET }),
			next,
		);
		expect(res.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("claimed: the first /_emdash request pays one query, the rest none", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "u1",
				email: "o@shop.example",
				name: null,
				role: 50,
				email_verified: 0,
				created_at: now,
				updated_at: now,
			})
			.execute();
		await new OptionsRepository(db).set("emdash:setup_complete", true);
		queries = 0;
		for (let i = 0; i < 3; i += 1) {
			const next = endpoint();
			const res = await runMiddleware(
				context("GET", "/_emdash/admin/content", "/_emdash/admin/[...path]"),
				next,
			);
			expect(res.status).toBe(299);
		}
		expect(queries).toBe(1);
	});

	test("storefront requests never reach the gate's database", async () => {
		const trap = new Proxy(
			{},
			{
				get() {
					throw new Error("storefront request touched the database");
				},
			},
		);
		for (const [method, path] of [
			["GET", "/"],
			["GET", "/products"],
			["POST", "/cart/add"],
		] as const) {
			const next = endpoint();
			const res = await runMiddleware(context(method, path, path, { database: trap }), next);
			expect(res.status).toBe(299);
		}
	});

	test("the playground build skips the gate: each visitor's database is claimed by EmDash", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const { setupClaimApplies } = await import("../src/middleware.js");
		expect(setupClaimApplies()).toBe(false);
		vi.unstubAllGlobals();
		expect(setupClaimApplies()).toBe(true);
	});
});
