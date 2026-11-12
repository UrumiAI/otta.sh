/**
 * Per-IP rate limiting on the anonymous write surface and the login requests
 * (issues #91, #29; `src/lib/rate-limit.ts`), as the middleware applies it.
 *
 * Pins:
 *  - which routes are limited, and in which class (auth or writes);
 *  - over the limit → 429 + Retry-After, in EmDash's JSON envelope on the
 *    plugin mount and as a small HTML page on the site's form endpoints, and
 *    the endpoint never runs;
 *  - under the limit → the endpoint runs;
 *  - the key is the class plus the client's IP (IPv6 by /64);
 *  - site GETs (but `/checkout/resume`'s) and every unprotected route are
 *    never counted;
 *  - FAIL OPEN: no binding, no client IP, or a binding that throws → the
 *    endpoint runs; a missing binding is logged once, a failing one at most
 *    once per interval.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import {
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	OTTA_PLUGIN_ID,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	plugin as ottaPlugin,
} from "@urumi.ai/otta-plugin";
import * as ottaPluginExports from "@urumi.ai/otta-plugin";
import {
	FAILURE_LOG_INTERVAL_MS,
	PLUGIN_ROUTES,
	RATE_LIMIT_BINDINGS,
	RATE_LIMIT_EXEMPT_PLUGIN_ROUTES,
	RATE_LIMIT_EXEMPT_SITE_ROUTES,
	RETRY_AFTER_SECONDS,
	SITE_ROUTES,
	clientAddress,
	clientNetwork,
	rateLimitedResponse,
	rateLimitClassFor as rateLimitClassForRequest,
	resetRateLimitLogForTests,
} from "../src/lib/rate-limit.js";
import { resumeFormAction } from "../src/lib/checkout-resume.js";
import { onRequest } from "../src/middleware.js";
import { env } from "./helpers/virtual-emdash-env.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";
const IP = "203.0.113.7";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

/** `rateLimitClassFor` with a plain request (no headers) unless one is given. */
const classFor = (
	method: string,
	url: URL,
	routePattern: string,
	request: Pick<Request, "headers"> = new Request(url),
) => rateLimitClassForRequest(method, url, routePattern, request);

const plugin = (route: string) => `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/${route}`;

function context(
	method: string,
	pathname: string,
	routePattern: string,
	opts: { ip?: string | null } = {},
) {
	const url = new URL(pathname, SITE);
	const headers: Record<string, string> = {};
	const ip = opts.ip === undefined ? IP : opts.ip;
	if (ip !== null) headers["cf-connecting-ip"] = ip;
	return {
		request: new Request(url, { method, headers }),
		url,
		routePattern,
		cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
		locals: {},
		cache: { set: vi.fn() },
	};
}

function endpoint() {
	return vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
}

/** A binding stand-in: answers `success` and records every key it was asked. */
function binding(success: boolean | (() => Promise<{ success: boolean }>)) {
	return {
		limit: vi.fn((_options: { key: string }) =>
			typeof success === "function" ? success() : Promise.resolve({ success }),
		),
	};
}

const PLUGIN_MOUNT_PATTERN = "/_emdash/api/plugins/[pluginId]/[...path]";

beforeEach(() => {
	resetRateLimitLogForTests();
});

afterEach(() => {
	delete env[RATE_LIMIT_BINDINGS.auth];
	delete env[RATE_LIMIT_BINDINGS.writes];
	vi.restoreAllMocks();
});

describe("the protected route table", () => {
	const AUTH_SITE = ["/account/login/request", "/account/verify/confirm", "/checkout/resume"];
	const WRITES_SITE = [
		"/cart/add",
		"/cart/update",
		"/cart/remove",
		"/cart/switch-currency",
		"/checkout/place",
		"/checkout/new-cart",
	];
	const AUTH_PLUGIN = [
		ACCOUNT_LOGIN_REQUEST_ROUTE,
		ACCOUNT_LOGIN_VERIFY_ROUTE,
		STOREFRONT_ORDER_RESUME_ROUTE,
	];
	const WRITES_PLUGIN = [
		STOREFRONT_CART_CREATE_ROUTE,
		STOREFRONT_CART_LINE_ADD_ROUTE,
		STOREFRONT_CART_LINE_UPDATE_ROUTE,
		STOREFRONT_CART_LINE_REMOVE_ROUTE,
		STOREFRONT_CHECKOUT_PLACE_ROUTE,
		STOREFRONT_ORDER_ABANDON_ROUTE,
	];

	test.each(AUTH_SITE)("site POST %s is auth", (route) => {
		expect(classFor("POST", new URL(route, SITE), route)).toBe("auth");
	});
	test.each(WRITES_SITE)("site POST %s is writes", (route) => {
		expect(classFor("POST", new URL(route, SITE), route)).toBe("writes");
	});
	test.each(AUTH_PLUGIN)("plugin %s is auth", (route) => {
		expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBe("auth");
	});
	test.each(WRITES_PLUGIN)("plugin %s is writes", (route) => {
		expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBe("writes");
	});

	test("site GETs are never counted, even on a protected route — except /checkout/resume", () => {
		for (const route of [...AUTH_SITE, ...WRITES_SITE]) {
			if (route === "/checkout/resume") continue;
			expect(classFor("GET", new URL(route, SITE), route)).toBeNull();
			expect(classFor("HEAD", new URL(route, SITE), route)).toBeNull();
		}
	});

	test("GET /checkout/resume counts (it dispatches the plugin's resume step), OPTIONS does not", () => {
		const url = new URL("/checkout/resume?order=x", SITE);
		expect(classFor("GET", url, "/checkout/resume")).toBe("auth");
		expect(classFor("HEAD", url, "/checkout/resume")).toBe("auth");
		expect(classFor("OPTIONS", url, "/checkout/resume")).toBeNull();
	});

	test("GET/HEAD /checkout/resume that the handler answers without the plugin is NOT counted (#661)", () => {
		const withOrder = new URL("/checkout/resume?order=x", SITE);
		const crossSite = new Request(withOrder, { headers: { "sec-fetch-site": "cross-site" } });
		const sameSite = new Request(withOrder, { headers: { "sec-fetch-site": "same-origin" } });
		for (const method of ["GET", "HEAD"]) {
			// A third-party <img> must not burn the visitor's auth budget.
			expect(classFor(method, withOrder, "/checkout/resume", crossSite)).toBeNull();
			// Same-site with an order still counts.
			expect(classFor(method, withOrder, "/checkout/resume", sameSite)).toBe("auth");
			// No order, or an empty/blank one: the handler redirects to the cart.
			for (const search of ["", "?order=", "?order=%20%20"]) {
				const url = new URL(`/checkout/resume${search}`, SITE);
				expect(classFor(method, url, "/checkout/resume", new Request(url))).toBeNull();
			}
		}
		// The POST (email form) is never exempted by these rules.
		expect(classFor("POST", withOrder, "/checkout/resume", crossSite)).toBe("auth");
		const bare = new URL("/checkout/resume", SITE);
		expect(classFor("POST", bare, "/checkout/resume", new Request(bare))).toBe("auth");
	});

	test("a cross-site GET /checkout/resume reaches the endpoint without spending the budget (#661)", async () => {
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const ctx = context("GET", "/checkout/resume?order=x", "/checkout/resume");
		ctx.request = new Request(ctx.url, {
			headers: { "sec-fetch-site": "cross-site", "cf-connecting-ip": IP },
		});
		const next = endpoint();
		const response = await runMiddleware(ctx, next);
		expect(response.status).toBe(299);
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("a plugin write route counts on ANY method but OPTIONS (EmDash dispatches GET with query input)", () => {
		const url = new URL(plugin(STOREFRONT_CART_CREATE_ROUTE), SITE);
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
			expect(classFor(method, url, PLUGIN_MOUNT_PATTERN)).toBe("writes");
		}
		expect(classFor("OPTIONS", url, PLUGIN_MOUNT_PATTERN)).toBeNull();
	});

	test("plugin path spellings that still reach the route are matched", () => {
		const spellings = [
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}//storefront/cart/create`,
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/storefront/cart/create/`,
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/storefront/%63art/create`,
		];
		for (const spelling of spellings) {
			expect(classFor("POST", new URL(spelling, SITE), PLUGIN_MOUNT_PATTERN)).toBe("writes");
		}
	});

	test("unprotected routes are never counted", () => {
		const reads = [STOREFRONT_PRODUCT_ROUTE, STOREFRONT_CART_READ_ROUTE, "admin"];
		for (const route of reads) {
			expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBeNull();
		}
		expect(
			classFor(
				"POST",
				new URL(`/_emdash/api/plugins/other/${STOREFRONT_CART_CREATE_ROUTE}`, SITE),
				PLUGIN_MOUNT_PATTERN,
			),
		).toBeNull();
		for (const route of [
			"/account/logout",
			"/webhooks/stripe",
			"/otta-admin/downloads/[productId]",
		]) {
			expect(classFor("POST", new URL(route, SITE), route)).toBeNull();
		}
	});
});

// ── default-deny coverage ─────────────────────────────────────────────────

const ENDPOINT_FILE = /\.(ts|mts|js|mjs)$/;
const PAGE_FILE = /\.(ts|mts|js|mjs|astro)$/;

/** Does this endpoint source export a handler for a non-GET method? (The
 *  origin-middleware suite pins this detector's cases.) */
function exportsWriteHandler(source: string): boolean {
	const method = String.raw`(POST|PUT|PATCH|DELETE|ALL)`;
	const declared = new RegExp(
		String.raw`export\s+(const|let|var|(async\s+)?function\*?)\s+${method}\b`,
	);
	const reexported = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
	return declared.test(source) || reexported.test(source);
}

/** Does this page answer GET? An `.astro` page always does; an endpoint when
 *  it exports GET or ALL. */
function answersGet(page: PageFile): boolean {
	if (page.file.endsWith(".astro")) return true;
	const method = String.raw`(GET|ALL)`;
	const declared = new RegExp(
		String.raw`export\s+(const|let|var|(async\s+)?function\*?)\s+${method}\b`,
	);
	const reexported = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
	return declared.test(page.source) || reexported.test(page.source);
}

interface PageFile {
	route: string;
	file: string;
	source: string;
}

/** Every file under a pages dir with its route pattern, matching `filter`. */
function pageFiles(pages: string, filter: RegExp): PageFile[] {
	const found: PageFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!filter.test(entry.name)) continue;
			const route = `/${path.relative(pages, full)}`.replace(PAGE_FILE, "").replace(/\/index$/, "");
			found.push({
				route: route === "" ? "/" : route,
				file: entry.name,
				source: readFileSync(full, "utf8"),
			});
		}
	};
	walk(pages);
	return found;
}

/** The route patterns under src/pages that export a write handler. */
function siteWriteRoutes(pages = path.join(SRC, "pages")): string[] {
	return pageFiles(pages, ENDPOINT_FILE)
		.filter(({ source }) => exportsWriteHandler(source))
		.map(({ route }) => route)
		.toSorted();
}

/** The exported names of the plugin route constants that are PLUGIN_ROUTES keys. */
function limitedPluginRouteConstants(): string[] {
	return Object.entries(ottaPluginExports)
		.filter(([name, value]) => name.endsWith("_ROUTE") && PLUGIN_ROUTES.has(String(value)))
		.map(([name]) => name);
}

/** `text` with every RegExp metacharacter escaped. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * A reference to a limited plugin route: its constant by name, its route string
 * as a literal (`"…"`, `'…'` or a backticked one), or one of `helpers` by name
 * (#669). Callers match it against {@link stripComments}'d source, so a route
 * named in a comment is not a reference.
 */
function limitedRouteReference(helpers: readonly string[] = []): RegExp {
	const names = [...limitedPluginRouteConstants(), ...helpers].map(escapeRegExp);
	const literals = [...PLUGIN_ROUTES.keys()].flatMap((route) =>
		['"', "'", "`"].map((quote) => `${quote}${escapeRegExp(route)}${quote}`),
	);
	return new RegExp(String.raw`(?<![\w$])(${names.join("|")})(?![\w$])|${literals.join("|")}`);
}

/**
 * `source` with its `//` and block comments removed (newlines kept, so every
 * line stays where it was). Strings are kept whole (`'…'` and `"…"` end at the
 * line, `` `…` `` at its closing backtick), and a backslash outside a string (a
 * regex literal's) escapes the next character. A heuristic, not a parser:
 * enough for this site's formatted source. Not understood: a `//`, `/*` or
 * quote inside a regex literal's character class (an unterminated `/*` throws;
 * the others can hide or keep the rest of that line), and a template literal
 * nested inside another's `${…}`.
 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const char = source.charAt(i);
		const next = source.charAt(i + 1);
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end === -1) {
				// Never erase to the end of the file: a `/*` inside a regex
				// literal's class (`/[/*]/`) would hide everything after it.
				const line = source.slice(0, i).split("\n").length;
				throw new Error(`stripComments: unterminated block comment at line ${line}`);
			}
			const stop = end + 2;
			out += source.slice(i, stop).replace(/[^\n]/g, "");
			i = stop;
		} else if (char === "'" || char === '"' || char === "`") {
			let j = i + 1;
			while (j < source.length && source.charAt(j) !== char) {
				if (char !== "`" && source.charAt(j) === "\n") break;
				j += source.charAt(j) === "\\" ? 2 : 1;
			}
			out += source.slice(i, j + 1);
			i = j + 1;
		} else if (char === "\\") {
			out += source.slice(i, i + 2);
			i += 2;
		} else {
			out += char;
			i += 1;
		}
	}
	return out;
}

/** One top-level statement of a lib file: a named declaration, a default
 *  export, an import, an export list (`export { … }`, `export * …`, with or
 *  without `from`), or other code (a call, a destructured export). */
type Chunk =
	| { kind: "declaration"; name: string; exported: boolean; body: string }
	| { kind: "default" | "import" | "exports" | "code"; body: string };

const DECLARATION =
	/^(export\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** `source`'s top-level chunks, each running from a column-0 line to the next
 *  one; a line opening with whitespace or a closing bracket continues the
 *  chunk (the house style that `pnpm format` keeps). A declaration's `body`
 *  leaves out its own name, so it never matches itself. */
function topLevelChunks(source: string): Chunk[] {
	const starts = [...source.matchAll(/^[^\s})\]]/gm)].map((mark) => mark.index);
	return starts.map((start, i): Chunk => {
		const text = source.slice(start, starts[i + 1] ?? source.length);
		const declaration = DECLARATION.exec(text);
		if (declaration?.[2] !== undefined) {
			return {
				kind: "declaration",
				name: declaration[2],
				exported: declaration[1] !== undefined,
				body: text.slice(declaration[0].length),
			};
		}
		if (/^export\s+default\b/.test(text)) return { kind: "default", body: text };
		if (/^import\b/.test(text)) return { kind: "import", body: text };
		if (/^export\s*(?:type\s*)?[{*]/.test(text)) return { kind: "exports", body: text };
		return { kind: "code", body: text };
	});
}

/** An `export { a, b as c }` chunk's [local, exported] name pairs. */
function exportPairs(text: string): [string, string][] {
	const list = /^export\s*(?:type\s*)?\{([^}]*)\}/.exec(text)?.[1] ?? "";
	return list.split(",").flatMap((item): [string, string][] => {
		const [local, exported] = item
			.trim()
			.replace(/^type\s+/, "")
			.split(/\s+as\s+/);
		return local === undefined || local === "" ? [] : [[local, exported ?? local]];
	});
}

/** The top-level `.ts`/`.js` files of a lib dir, with their source. */
function libFiles(lib: string): { file: string; source: string }[] {
	return readdirSync(lib, { withFileTypes: true })
		.filter((entry) => entry.isFile() && ENDPOINT_FILE.test(entry.name))
		.map((entry) => ({
			file: entry.name,
			source: readFileSync(path.join(lib, entry.name), "utf8"),
		}))
		.toSorted((a, b) => a.file.localeCompare(b.file));
}

type LibPins = Readonly<Record<string, readonly string[]>>;

/**
 * The lib declarations that dispatch a limited plugin route, pinned per file
 * (#669). A declaration dispatches one when it names a limited route (constant
 * or literal) or another dispatcher: a wrapper, in the same file or another,
 * however many hops ({@link limitedRouteHelpers} computes the fixed point). A
 * new one fails the guard until it is pinned here, and every one is a
 * reference for the page scan: a page that calls it is scanned as if it named
 * the route.
 * Limitations: the scan matches names, not bindings (a page's own local of the
 * same name is a reference too, which errs loud); a default export that
 * dispatches is refused outright, as a page imports it under any name; and a
 * route passed as a computed value (`dispatchOttaRoute(h, route)`, the route
 * from a parameter or a variable) is not seen where it is dispatched, only
 * where it is named.
 */
const LIB_DISPATCHERS: LibPins = {
	"cart-actions.ts": ["ensureCartId"],
};

/** Declarations that name limited routes as DATA — tables a dispatch is
 *  checked against — pinned like a dispatcher, but NOT followed: reading one
 *  dispatches nothing (`dispatchOttaRoute` reads the replay tables for every
 *  route). Add one here only if it never dispatches. */
const LIB_ROUTE_TABLES: LibPins = {
	"otta-api.ts": ["KEYED_REPLAY_ROUTES", "REPLAYING_ROUTES"],
	"rate-limit.ts": ["PLUGIN_ROUTES"],
};

/** The lib's top-level chunks, comments stripped, per file. */
function libChunks(lib: string): { file: string; chunks: Chunk[] }[] {
	return libFiles(lib).map(({ file, source }) => ({
		file,
		chunks: topLevelChunks(stripComments(source)),
	}));
}

/** Every name that dispatches a limited route from the lib (sorted): the fixed
 *  point of "a declaration that names a limited route or one of these", plus
 *  every name an `export { … }` list (re-exports included) gives one of them.
 *  `tables` are never followed. */
function limitedRouteHelpers(
	lib = path.join(SRC, "lib"),
	tables: LibPins = LIB_ROUTE_TABLES,
): string[] {
	const files = libChunks(lib);
	const helpers = new Set<string>();
	for (let grew = true; grew;) {
		grew = false;
		const reference = limitedRouteReference([...helpers]);
		const add = (name: string): void => {
			if (helpers.has(name)) return;
			helpers.add(name);
			grew = true;
		};
		for (const { file, chunks } of files) {
			for (const chunk of chunks) {
				if (chunk.kind === "declaration") {
					if (tables[file]?.includes(chunk.name) !== true && reference.test(chunk.body)) {
						add(chunk.name);
					}
				} else if (chunk.kind === "exports") {
					for (const [local, exported] of exportPairs(chunk.body)) {
						if (helpers.has(local)) add(exported);
					}
				}
			}
		}
	}
	return [...helpers].toSorted();
}

/** Is a route table's body (what follows its name) a plain `new Set([…])`,
 *  `new Map([…])` or object literal whose entries are only route constants,
 *  string literals and keys? Then it can only be read, never dispatch. */
function isPlainRouteTable(body: string): boolean {
	const shape =
		/^\s*(?::[^=]*)?=\s*(?:new\s+(?:Set|Map)(?:<[^>]*>)?\(\s*\[([\s\S]*)\]\s*\)|\{([\s\S]*)\})\s*;?\s*$/.exec(
			body,
		);
	if (shape === null) return false;
	const residue = (shape[1] ?? shape[2] ?? "")
		.replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, "")
		.replace(/(?<![\w$])[A-Z][A-Z0-9_]*_ROUTE(?![\w$])/g, "")
		.replace(/[\w$]+\s*:/g, "");
	return /^[\s,[\]]*$/.test(residue);
}

/** The names a page can import a route table by: an `export`ed one's own
 *  name, and every name an `export { … }` list gives one. */
function exportedTableNames(lib: string, tables: LibPins): string[] {
	return libChunks(lib).flatMap(({ file, chunks }) => {
		const pinned = tables[file] ?? [];
		return chunks.flatMap((chunk) => {
			if (chunk.kind === "declaration") {
				return chunk.exported && pinned.includes(chunk.name) ? [chunk.name] : [];
			}
			if (chunk.kind !== "exports") return [];
			return exportPairs(chunk.body)
				.filter(([local]) => pinned.includes(local))
				.map(([, exported]) => exported);
		});
	});
}

/** Violations of the lib pin, as readable lines (sorted). */
function libDispatchViolations(
	lib = path.join(SRC, "lib"),
	dispatchers: LibPins = LIB_DISPATCHERS,
	tables: LibPins = LIB_ROUTE_TABLES,
): string[] {
	const reference = limitedRouteReference(limitedRouteHelpers(lib, tables));
	const problems: string[] = [];
	const found = new Map<string, string[]>();
	for (const { file, chunks } of libChunks(lib)) {
		const named: string[] = [];
		for (const chunk of chunks) {
			if (!reference.test(chunk.body)) continue;
			if (chunk.kind === "declaration") {
				named.push(chunk.name);
				if (tables[file]?.includes(chunk.name) === true && !isPlainRouteTable(chunk.body)) {
					problems.push(
						`${file}: ${chunk.name} is pinned as a route table but is not a plain Set, Map or object of routes`,
					);
				}
			} else if (chunk.kind === "default") {
				problems.push(`${file}: a default export names a limited route; export it by name`);
			} else if (chunk.kind === "code") {
				problems.push(`${file}: names a limited route outside a recognised declaration`);
			}
		}
		found.set(file, named);
	}
	const files = new Set([...found.keys(), ...Object.keys(dispatchers), ...Object.keys(tables)]);
	for (const file of files) {
		const named = found.get(file) ?? [];
		const pinned = [...(dispatchers[file] ?? []), ...(tables[file] ?? [])];
		for (const name of named) {
			if (!pinned.includes(name))
				problems.push(`${file}: ${name} names a limited route; not pinned`);
		}
		for (const name of pinned) {
			if (!named.includes(name)) {
				problems.push(`${file}: ${name} is pinned but names no limited route`);
			}
		}
	}
	return problems.toSorted();
}

/** The pages (`.ts` or `.astro`) whose code, comments stripped, references a
 *  limited plugin route: by constant, route literal, lib helper, or exported
 *  route table (a page that reads one to pick a route dispatches it). */
function pagesDispatchingLimitedRoutes(
	pages = path.join(SRC, "pages"),
	lib = path.join(SRC, "lib"),
	tables: LibPins = LIB_ROUTE_TABLES,
): PageFile[] {
	const reference = limitedRouteReference([
		...limitedRouteHelpers(lib, tables),
		...exportedTableNames(lib, tables),
	]);
	return pageFiles(pages, PAGE_FILE).filter((page) => reference.test(stripComments(page.source)));
}

/** Violations of the page-level default-deny, as readable lines: every page
 *  (`.ts` or `.astro`) whose code (comments stripped) references a limited plugin
 *  route (constant, route literal or lib helper) is in SITE_ROUTES or exempt, and `anyMethod`
 *  when it answers GET. */
function pageCoverageViolations(
	pages = path.join(SRC, "pages"),
	lib = path.join(SRC, "lib"),
): string[] {
	const problems: string[] = [];
	for (const page of pagesDispatchingLimitedRoutes(pages, lib)) {
		const site = SITE_ROUTES.get(page.route);
		if (site === undefined && !RATE_LIMIT_EXEMPT_SITE_ROUTES.has(page.route)) {
			problems.push(`${page.route}: dispatches a limited plugin route; in neither map`);
		} else if (site !== undefined && answersGet(page) && site.anyMethod !== true) {
			problems.push(`${page.route}: answers GET but is not anyMethod`);
		}
	}
	return problems;
}

/** A temp dir for the scans' fixtures, removed after `body`. */
function withTempDir(body: (dir: string) => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "rl-scan-"));
	try {
		body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("every write route is limited or explicitly exempt (default-deny)", () => {
	test("each site write endpoint is in SITE_ROUTES or the exemption map — never neither, never both", () => {
		const routes = siteWriteRoutes();
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			const limited = SITE_ROUTES.has(route);
			const exempt = RATE_LIMIT_EXEMPT_SITE_ROUTES.has(route);
			expect(limited !== exempt, route).toBe(true);
		}
		// No stale entries either.
		for (const route of [...SITE_ROUTES.keys(), ...RATE_LIMIT_EXEMPT_SITE_ROUTES.keys()]) {
			expect(routes, route).toContain(route);
		}
	});

	test("each page (.ts or .astro) dispatching a limited plugin route is limited or exempt, anyMethod if it answers GET (#661)", () => {
		expect(limitedPluginRouteConstants().length).toBe(PLUGIN_ROUTES.size);
		expect(pageCoverageViolations()).toEqual([]);
	});

	test("lib code that names a limited route is pinned per declaration (guard for the page scan, #669)", () => {
		expect(libDispatchViolations()).toEqual([]);
		expect(limitedRouteHelpers()).toEqual(["ensureCartId"]);
	});

	test("the page scan is not blind: it sees exactly the pages SITE_ROUTES limits (#669)", () => {
		const seen = pagesDispatchingLimitedRoutes().map(({ route }) => route);
		expect(seen.toSorted()).toEqual([...SITE_ROUTES.keys()].toSorted());
	});

	test("a new helper in an already-listed lib file is flagged, and a page calling it is scanned (#669)", () => {
		withTempDir((dir) => {
			const lib = path.join(dir, "lib");
			const pages = path.join(dir, "pages");
			mkdirSync(lib);
			mkdirSync(pages);
			for (const { file, source } of libFiles(path.join(SRC, "lib"))) {
				writeFileSync(path.join(lib, file), source);
			}
			writeFileSync(
				path.join(lib, "otta-api.ts"),
				`${readFileSync(path.join(SRC, "lib", "otta-api.ts"), "utf8")}
export async function quickAdd(handler: never, url: URL) {
	return dispatchOttaRoute(handler, STOREFRONT_CART_LINE_ADD_ROUTE, {}, url);
}
`,
			);
			writeFileSync(
				path.join(pages, "quick.astro"),
				"---\nimport { quickAdd } from '../lib/otta-api.js';\nawait quickAdd(undefined as never, Astro.url);\n---\n<p>added</p>\n",
			);
			expect(libDispatchViolations(lib)).toEqual([
				"otta-api.ts: quickAdd names a limited route; not pinned",
			]);
			expect(pageCoverageViolations(pages, lib)).toEqual([
				"/quick: dispatches a limited plugin route; in neither map",
			]);
			// Against the real lib, which has no quickAdd, the page is not a reference.
			expect(pageCoverageViolations(pages)).toEqual([]);
		});
	});

	test("a helper exported through an export list, under its own name or an alias, is a reference too (#669)", () => {
		withTempDir((dir) => {
			const lib = path.join(dir, "lib");
			const pages = path.join(dir, "pages");
			mkdirSync(lib);
			mkdirSync(pages);
			writeFileSync(
				path.join(lib, "quick-cart.ts"),
				"const quickAdd = (h: never) => dispatchOttaRoute(h, STOREFRONT_CART_LINE_ADD_ROUTE, {});\n" +
					"function quickCreate(h: never) {\n\treturn dispatchOttaRoute(h, STOREFRONT_CART_CREATE_ROUTE, {});\n}\n" +
					"export { quickAdd, quickCreate as fastCreate };\n",
			);
			writeFileSync(
				path.join(pages, "add.astro"),
				"---\nimport { quickAdd } from '../lib/quick-cart.js';\nawait quickAdd(undefined as never);\n---\n",
			);
			writeFileSync(
				path.join(pages, "create.astro"),
				"---\nimport { fastCreate } from '../lib/quick-cart.js';\nawait fastCreate(undefined as never);\n---\n",
			);
			expect(limitedRouteHelpers(lib)).toEqual(["fastCreate", "quickAdd", "quickCreate"]);
			expect(pageCoverageViolations(pages, lib).toSorted()).toEqual([
				"/add: dispatches a limited plugin route; in neither map",
				"/create: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("a wrapper around a dispatcher is one too, in the same file or another, however many hops (#669)", () => {
		withTempDir((dir) => {
			const lib = path.join(dir, "lib");
			const pages = path.join(dir, "pages");
			mkdirSync(lib);
			mkdirSync(pages);
			writeFileSync(
				path.join(lib, "quick-cart.ts"),
				"function doAdd(h: never) {\n\treturn dispatchOttaRoute(h, STOREFRONT_CART_LINE_ADD_ROUTE, {});\n}\n" +
					"export function quickAdd(h: never) {\n\treturn doAdd(h);\n}\n",
			);
			writeFileSync(
				path.join(lib, "cart-shortcuts.ts"),
				"import { quickAdd } from './quick-cart.js';\nexport const addOne = (h: never) => quickAdd(h);\n",
			);
			writeFileSync(path.join(pages, "quick.ts"), "export const GET = (c) => quickAdd(c);\n");
			writeFileSync(path.join(pages, "one.ts"), "export const GET = (c) => addOne(c);\n");
			expect(limitedRouteHelpers(lib)).toEqual(["addOne", "doAdd", "quickAdd"]);
			// Only the unexported dispatcher is pinned: both wrappers are flagged.
			expect(libDispatchViolations(lib, { "quick-cart.ts": ["doAdd"] }, {})).toEqual([
				"cart-shortcuts.ts: addOne names a limited route; not pinned",
				"quick-cart.ts: quickAdd names a limited route; not pinned",
			]);
			expect(
				libDispatchViolations(
					lib,
					{ "cart-shortcuts.ts": ["addOne"], "quick-cart.ts": ["doAdd", "quickAdd"] },
					{},
				),
			).toEqual([]);
			expect(pageCoverageViolations(pages, lib).toSorted()).toEqual([
				"/one: dispatches a limited plugin route; in neither map",
				"/quick: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("a route table is pinned but not followed: reading it is not dispatching (#669)", () => {
		withTempDir((lib) => {
			writeFileSync(
				path.join(lib, "routes.ts"),
				"const KEYED = new Set([STOREFRONT_CART_CREATE_ROUTE]);\nexport const isKeyed = (r: string) => KEYED.has(r);\n",
			);
			expect(libDispatchViolations(lib, {}, { "routes.ts": ["KEYED"] })).toEqual([]);
			expect(limitedRouteHelpers(lib, { "routes.ts": ["KEYED"] })).toEqual([]);
			// Unpinned, it is a dispatcher like any other, and so is its reader.
			expect(libDispatchViolations(lib, {}, {})).toEqual([
				"routes.ts: KEYED names a limited route; not pinned",
				"routes.ts: isKeyed names a limited route; not pinned",
			]);
		});
	});

	test("lib code naming a limited route outside a named declaration is flagged, not dropped (#669)", () => {
		withTempDir((lib) => {
			writeFileSync(
				path.join(lib, "default-fn.ts"),
				"export default async function (h: never) {\n\treturn dispatchOttaRoute(h, STOREFRONT_CART_CREATE_ROUTE, {});\n}\n",
			);
			writeFileSync(
				path.join(lib, "top-call.ts"),
				"registerQuick(STOREFRONT_CART_CREATE_ROUTE);\n",
			);
			writeFileSync(
				path.join(lib, "destructured.ts"),
				"export const { quick } = makeQuick('storefront/cart/create');\n",
			);
			writeFileSync(
				path.join(lib, "harmless.ts"),
				'/** Unlike `storefront/cart/create`, "storefront/cart/create" here is prose. */\n' +
					"// STOREFRONT_CART_CREATE_ROUTE, in a line comment\nexport const url = 'https://example.com//x';\n",
			);
			expect(libDispatchViolations(lib, {}, {})).toEqual([
				"default-fn.ts: a default export names a limited route; export it by name",
				"destructured.ts: names a limited route outside a recognised declaration",
				"top-call.ts: names a limited route outside a recognised declaration",
			]);
		});
	});

	test("a re-export of a helper under another name is a reference too (#669)", () => {
		withTempDir((dir) => {
			const lib = path.join(dir, "lib");
			const pages = path.join(dir, "pages");
			mkdirSync(lib);
			mkdirSync(pages);
			for (const { file, source } of libFiles(path.join(SRC, "lib"))) {
				writeFileSync(path.join(lib, file), source);
			}
			writeFileSync(
				path.join(lib, "cart-index.ts"),
				'export { ensureCartId as mintCart } from "./cart-actions.js";\n',
			);
			writeFileSync(path.join(pages, "mint.ts"), "export const POST = (c) => mintCart(c);\n");
			expect(limitedRouteHelpers(lib)).toContain("mintCart");
			expect(libDispatchViolations(lib)).toEqual([]);
			expect(pageCoverageViolations(pages, lib)).toEqual([
				"/mint: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("the lib guard flags a new lib file that names a limited route (#669)", () => {
		withTempDir((lib) => {
			for (const { file, source } of libFiles(path.join(SRC, "lib"))) {
				writeFileSync(path.join(lib, file), source);
			}
			writeFileSync(
				path.join(lib, "quick-cart.ts"),
				"export const quickCreate = (h: never) => dispatchOttaRoute(h, 'storefront/cart/create', {});\n",
			);
			expect(libDispatchViolations(lib)).toEqual([
				"quick-cart.ts: quickCreate names a limited route; not pinned",
			]);
		});
	});

	test("a helper name is matched literally, never as a pattern (#669)", () => {
		const reference = limitedRouteReference(["quick.Add"]);
		expect(reference.test("quick.Add(c)")).toBe(true);
		expect(reference.test("quickXAdd(c)")).toBe(false);
	});

	test("stripComments drops comments and keeps strings and regex literals whole (#669)", () => {
		const source =
			"/** `storefront/cart/create` */\nconst a = 'http://x'; // gone\nconst b = /\\/\\//g; /* gone\n too */ const c = \"//kept\";\n";
		const stripped = stripComments(source);
		expect(stripped).not.toContain("storefront/cart/create");
		expect(stripped).not.toContain("gone");
		expect(stripped).toContain("'http://x'");
		expect(stripped).toContain(String.raw`/\/\//g`);
		expect(stripped).toContain('"//kept"');
		// Line count kept, so column-0 declarations stay where they were.
		expect(stripped.split("\n").length).toBe(source.split("\n").length);
	});

	test("a page that reads an exported route table is a reference too (#669)", () => {
		withTempDir((dir) => {
			const lib = path.join(dir, "lib");
			const pages = path.join(dir, "pages");
			mkdirSync(lib);
			mkdirSync(pages);
			writeFileSync(
				path.join(lib, "routes.ts"),
				"export const QUICK = new Set([STOREFRONT_CART_CREATE_ROUTE]);\n" +
					"const HIDDEN = new Set([STOREFRONT_CART_LINE_ADD_ROUTE]);\nexport { HIDDEN as SHOWN };\n",
			);
			writeFileSync(
				path.join(pages, "first.ts"),
				"export const POST = (c) => dispatchOttaRoute(h, [...QUICK][0], {});\n",
			);
			writeFileSync(
				path.join(pages, "second.ts"),
				"export const POST = (c) => dispatchOttaRoute(h, [...SHOWN][0], {});\n",
			);
			const tables = { "routes.ts": ["QUICK", "HIDDEN"] };
			expect(libDispatchViolations(lib, {}, tables)).toEqual([]);
			// Tables are not followed, so neither is a helper: only their names count.
			expect(limitedRouteHelpers(lib, tables)).toEqual([]);
			expect(
				pagesDispatchingLimitedRoutes(pages, lib, tables)
					.map(({ route }) => route)
					.toSorted(),
			).toEqual(["/first", "/second"]);
		});
	});

	test("a route table must be a plain Set, Map or object of routes: a dispatcher cannot be parked there (#669)", () => {
		withTempDir((lib) => {
			writeFileSync(
				path.join(lib, "routes.ts"),
				"export const SET: ReadonlySet<string> = new Set([\n\tSTOREFRONT_CART_CREATE_ROUTE,\n]);\n" +
					'export const MAP: ReadonlyMap<string, Cls> = new Map([\n\t[STOREFRONT_CART_CREATE_ROUTE, "writes"],\n]);\n' +
					"export const OBJ = { create: STOREFRONT_CART_CREATE_ROUTE, add: 'storefront/cart/lines/add' };\n" +
					"export const SNEAKY = new Set([dispatchOttaRoute(h, STOREFRONT_CART_CREATE_ROUTE, {})]);\n" +
					"export function quickAdd(h: never) {\n\treturn dispatchOttaRoute(h, STOREFRONT_CART_LINE_ADD_ROUTE, {});\n}\n",
			);
			expect(
				libDispatchViolations(
					lib,
					{},
					{ "routes.ts": ["SET", "MAP", "OBJ", "SNEAKY", "quickAdd"] },
				),
			).toEqual([
				"routes.ts: SNEAKY is pinned as a route table but is not a plain Set, Map or object of routes",
				"routes.ts: quickAdd is pinned as a route table but is not a plain Set, Map or object of routes",
			]);
		});
	});

	test("an unterminated block comment is a scan error, not a silent erase to the end (#669)", () => {
		expect(() =>
			stripComments("const r = /[/*]/;\nexport const x = STOREFRONT_CART_CREATE_ROUTE;\n"),
		).toThrow(/unterminated block comment at line 1/);
	});

	test("a helper name that starts or ends with $ is matched whole (#669)", () => {
		const reference = limitedRouteReference(["$add", "mint$"]);
		expect(reference.test("await $add(c)")).toBe(true);
		expect(reference.test("await mint$(c)")).toBe(true);
		expect(reference.test("await x$add(c)")).toBe(false);
		expect(reference.test("await mint$x(c)")).toBe(false);
	});

	test("a const enum is parsed under its own name (#669)", () => {
		withTempDir((lib) => {
			writeFileSync(
				path.join(lib, "routes.ts"),
				'export const enum Routes {\n\tCreate = "storefront/cart/create",\n}\n',
			);
			expect(libDispatchViolations(lib, {}, {})).toEqual([
				"routes.ts: Routes names a limited route; not pinned",
			]);
		});
	});

	test("the page scan flags a GET on a non-anyMethod route and a page using a dispatching helper (#661)", () => {
		withTempDir((dir) => {
			mkdirSync(path.join(dir, "cart"));
			writeFileSync(
				path.join(dir, "cart", "add.ts"),
				"import { STOREFRONT_CART_LINE_ADD_ROUTE } from '@urumi.ai/otta-plugin';\nexport const GET = () => STOREFRONT_CART_LINE_ADD_ROUTE;\nexport const POST = GET;\n",
			);
			writeFileSync(
				path.join(dir, "mint.ts"),
				"import { ensureCartId } from '../lib/cart-actions.js';\nexport const POST = (c) => ensureCartId(c, undefined);\n",
			);
			expect(pageCoverageViolations(dir).toSorted()).toEqual([
				"/cart/add: answers GET but is not anyMethod",
				"/mint: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("the page scan catches a GET endpoint and an .astro page that dispatch a limited route (#661)", () => {
		withTempDir((dir) => {
			mkdirSync(path.join(dir, "cart"));
			writeFileSync(
				path.join(dir, "cart", "quick-add.ts"),
				"import { STOREFRONT_CART_LINE_ADD_ROUTE } from '@urumi.ai/otta-plugin';\nexport const GET = () => STOREFRONT_CART_LINE_ADD_ROUTE;\n",
			);
			writeFileSync(
				path.join(dir, "go.astro"),
				"---\nimport { STOREFRONT_CART_CREATE_ROUTE } from '@urumi.ai/otta-plugin';\n---\n<p>{STOREFRONT_CART_CREATE_ROUTE}</p>\n",
			);
			expect(pageCoverageViolations(dir).toSorted()).toEqual([
				"/cart/quick-add: dispatches a limited plugin route; in neither map",
				"/go: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("the page scan catches a route string written as a literal (quoted or backticked), not one named in a comment (#669)", () => {
		withTempDir((dir) => {
			writeFileSync(
				path.join(dir, "double.ts"),
				'export const POST = (c) => dispatchOttaRoute(h, "storefront/cart/create", {}, c.url);\n',
			);
			writeFileSync(
				path.join(dir, "single.astro"),
				"---\nawait dispatchOttaRoute(h, 'storefront/cart/lines/add', {}, Astro.url);\n---\n<p>added</p>\n",
			);
			writeFileSync(
				path.join(dir, "backtick.ts"),
				"export const POST = (c) => dispatchOttaRoute(h, `storefront/cart/create`, {}, c.url);\n",
			);
			writeFileSync(
				path.join(dir, "comment.ts"),
				"/** Reads, unlike the plugin's `storefront/cart/create`. */\n// STOREFRONT_CART_CREATE_ROUTE, ensureCartId\nexport const POST = () => null;\n",
			);
			expect(pageCoverageViolations(dir).toSorted()).toEqual([
				"/backtick: dispatches a limited plugin route; in neither map",
				"/double: dispatches a limited plugin route; in neither map",
				"/single: dispatches a limited plugin route; in neither map",
			]);
		});
	});

	test("/checkout/resume is limited on GET too (its GET dispatches the plugin's resume step)", () => {
		expect(SITE_ROUTES.get("/checkout/resume")?.anyMethod).toBe(true);
	});

	test("each PUBLIC plugin route is in PLUGIN_ROUTES or the exemption map — never neither, never both", () => {
		const routes = Object.entries(ottaPlugin.routes ?? {})
			.filter(([, route]) => (route as { public?: boolean }).public === true)
			.map(([name]) => name);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			const limited = PLUGIN_ROUTES.has(route);
			const exempt = RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.has(route);
			expect(limited !== exempt, route).toBe(true);
		}
		for (const route of [...PLUGIN_ROUTES.keys(), ...RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.keys()]) {
			expect(routes, route).toContain(route);
		}
	});

	test("every exemption carries a reason", () => {
		for (const reason of [
			...RATE_LIMIT_EXEMPT_SITE_ROUTES.values(),
			...RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.values(),
		]) {
			expect(reason.trim().length).toBeGreaterThan(10);
		}
	});
});

// ── the configured limits: template, runbook and Retry-After agree ─────────

/** `{ name, limit, period }` for each rate-limit binding line in a file (the
 *  template's commented example or the runbook's code block). */
function bindingLines(file: string): Map<string, { limit: number; period: number }> {
	const found = new Map<string, { limit: number; period: number }>();
	const line =
		/"name":\s*"(RATE_LIMIT_\w+)",\s*"namespace_id":\s*"\d+",\s*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/g;
	for (const match of readFileSync(file, "utf8").matchAll(line)) {
		found.set(match[1] ?? "", { limit: Number(match[2]), period: Number(match[3]) });
	}
	return found;
}

describe("the configured limits", () => {
	// The reference site's tracked template (sites/staging), which carries the
	// bindings commented out; the one-click template repository turns them on.
	const template = bindingLines(path.join(SRC, "..", "..", "staging", "wrangler.jsonc"));
	const runbook = bindingLines(path.join(SRC, "..", "..", "..", "DEPLOYMENT.md"));

	test("the template and DEPLOYMENT.md give both bindings, with the same numbers", () => {
		expect([...template.keys()].toSorted()).toEqual(Object.values(RATE_LIMIT_BINDINGS).toSorted());
		expect(runbook).toEqual(template);
	});

	test("auth is the tighter class", () => {
		const auth = template.get(RATE_LIMIT_BINDINGS.auth);
		const writes = template.get(RATE_LIMIT_BINDINGS.writes);
		expect(auth?.limit).toBeLessThan(writes?.limit ?? 0);
	});

	test("each period is one the binding accepts, and is the Retry-After the site sends", () => {
		for (const cls of ["auth", "writes"] as const) {
			const period = template.get(RATE_LIMIT_BINDINGS[cls])?.period;
			expect([10, 60]).toContain(period);
			expect(RETRY_AFTER_SECONDS[cls]).toBe(period);
		}
	});
});

describe("clientNetwork", () => {
	test("IPv4 is the address itself", () => {
		expect(clientNetwork("203.0.113.7")).toBe("203.0.113.7");
	});
	test("IPv6 is its /64, however it is spelled", () => {
		expect(clientNetwork("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
		expect(clientNetwork("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
		expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
	});
	test("IPv4-mapped IPv6 is the IPv4 address", () => {
		expect(clientNetwork("::ffff:198.51.100.4")).toBe("198.51.100.4");
	});
	test("every IPv6 spelling of an IPv4 host is that IPv4 address", () => {
		for (const spelling of [
			"::ffff:198.51.100.4",
			"::FFFF:198.51.100.4",
			"0:0:0:0:0:ffff:198.51.100.4",
			"::ffff:c633:6404",
			"::198.51.100.4",
			"64:ff9b::198.51.100.4",
			"64:ff9b::c633:6404",
		]) {
			expect(clientNetwork(spelling), spelling).toBe("198.51.100.4");
		}
	});
	test("an embedded IPv4 tail on an ordinary prefix is still keyed by its /64", () => {
		expect(clientNetwork("2001:db8:1:2::198.51.100.4")).toBe("2001:db8:1:2::/64");
	});
	test("absent → null (fail open); present but unparseable → keyed as written", () => {
		expect(clientNetwork(null)).toBeNull();
		expect(clientNetwork("")).toBeNull();
		expect(clientNetwork("  ")).toBeNull();
		expect(clientNetwork("Not An IP")).toBe("raw:not an ip");
		expect(clientNetwork("1:2:3")).toBe("raw:1:2:3");
		expect(clientNetwork("::ffff:300.1.1.1")).toBe("raw:::ffff:300.1.1.1");
		expect(clientNetwork("999.1.1.1")).toBe("raw:999.1.1.1");
		expect(clientNetwork("x".repeat(200))).toBe(`raw:${"x".repeat(64)}`);
	});
});

const headers = (values: Record<string, string>) => new Headers(values);

describe("clientAddress", () => {
	test("CF-Connecting-IP when it is a real address", () => {
		expect(clientAddress(headers({ "cf-connecting-ip": IP }))).toBe(IP);
	});
	test("a Pseudo IPv4 (240.0.0.0/4) defers to CF-Connecting-IPv6", () => {
		const ipv6 = "2001:db8:1:2::9";
		expect(
			clientAddress(headers({ "cf-connecting-ip": "240.12.34.56", "cf-connecting-ipv6": ipv6 })),
		).toBe(ipv6);
		expect(
			clientAddress(headers({ "cf-connecting-ip": "255.1.2.3", "cf-connecting-ipv6": ipv6 })),
		).toBe(ipv6);
	});
	test("CF-Connecting-IPv6 is ignored beside a real IPv4 address (a client cannot pick its key)", () => {
		expect(
			clientAddress(headers({ "cf-connecting-ip": IP, "cf-connecting-ipv6": "2001:db8::1" })),
		).toBe(IP);
	});
	test("a Pseudo IPv4 with no IPv6 header is keyed as itself", () => {
		expect(clientAddress(headers({ "cf-connecting-ip": "240.12.34.56" }))).toBe("240.12.34.56");
	});
	test("no header → null", () => {
		expect(clientAddress(headers({}))).toBeNull();
	});
});

describe("the middleware", () => {
	test("over the limit on a plugin route → 429 JSON envelope + Retry-After; endpoint never runs", async () => {
		const writes = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", plugin(STOREFRONT_CART_CREATE_ROUTE), PLUGIN_MOUNT_PATTERN),
			next,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe(String(RETRY_AFTER_SECONDS.writes));
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(response.headers.get("Content-Type")).toContain("application/json");
		const body = (await response.json()) as { success: boolean; error: { code: string } };
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("RATE_LIMITED");
		expect(next).not.toHaveBeenCalled();
		expect(writes.limit).toHaveBeenCalledWith({ key: `writes:${IP}` });
	});

	test("over the limit on a site form endpoint → 429 HTML page + Retry-After", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", "/account/login/request", "/account/login/request"),
			next,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe(String(RETRY_AFTER_SECONDS.auth));
		expect(response.headers.get("Content-Type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("Too many requests");
		expect(html).toContain('href="/account/login"');
		expect(next).not.toHaveBeenCalled();
	});

	test("each class asks its own binding with its own key", async () => {
		const auth = binding(true);
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		await runMiddleware(
			context("POST", plugin(ACCOUNT_LOGIN_REQUEST_ROUTE), PLUGIN_MOUNT_PATTERN),
			endpoint(),
		);
		expect(auth.limit).toHaveBeenCalledWith({ key: `auth:${IP}` });
		expect(writes.limit).not.toHaveBeenCalled();
	});

	test("in Pseudo IPv4 mode the key is the client's IPv6 /64", async () => {
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const ctx = context("POST", "/cart/add", "/cart/add");
		ctx.request = new Request(ctx.url, {
			method: "POST",
			headers: { "cf-connecting-ip": "240.12.34.56", "cf-connecting-ipv6": "2001:db8:1:2::9" },
		});
		await runMiddleware(ctx, endpoint());
		expect(writes.limit).toHaveBeenCalledWith({ key: "writes:2001:db8:1:2::/64" });
	});

	test("under the limit → the endpoint runs", async () => {
		env[RATE_LIMIT_BINDINGS.writes] = binding(true);
		const next = endpoint();
		const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("a site GET is never counted", async () => {
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const next = endpoint();
		const response = await runMiddleware(
			context("GET", "/account/login/request", "/account/login/request"),
			next,
		);
		expect(response.status).toBe(299);
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("an unprotected write is never counted", async () => {
		const writes = binding(false);
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", plugin(STOREFRONT_CART_READ_ROUTE), PLUGIN_MOUNT_PATTERN),
			next,
		);
		expect(response.status).toBe(299);
		expect(writes.limit).not.toHaveBeenCalled();
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("binding absent → FAIL OPEN, logged once per class", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < 3; i++) {
			const next = endpoint();
			const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
			expect(response.status).toBe(299);
		}
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(RATE_LIMIT_BINDINGS.writes);
	});

	test("no client IP → FAIL OPEN, the binding is not asked", async () => {
		const writes = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", "/cart/add", "/cart/add", { ip: null }),
			next,
		);
		expect(response.status).toBe(299);
		expect(writes.limit).not.toHaveBeenCalled();
	});

	test("a binding that throws → FAIL OPEN", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		env[RATE_LIMIT_BINDINGS.writes] = binding(() => Promise.reject(new Error("boom")));
		const next = endpoint();
		const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
		expect(response.status).toBe(299);
	});

	test("a failing binding is logged at most once per interval, and again after it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		env[RATE_LIMIT_BINDINGS.writes] = binding(() => Promise.reject(new Error("boom")));
		const post = () => runMiddleware(context("POST", "/cart/add", "/cart/add"), endpoint());
		await post();
		await post();
		expect(error).toHaveBeenCalledOnce();
		now.mockReturnValue(1_000_000 + FAILURE_LOG_INTERVAL_MS - 1);
		await post();
		expect(error).toHaveBeenCalledOnce();
		now.mockReturnValue(1_000_000 + FAILURE_LOG_INTERVAL_MS);
		await post();
		expect(error).toHaveBeenCalledTimes(2);
	});

	test("over the limit on /checkout/resume (GET) → 429 whose Go back points at the order page", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const next = endpoint();
		const response = await runMiddleware(
			context("GET", "/checkout/resume?order=x", "/checkout/resume"),
			next,
		);
		expect(response.status).toBe(429);
		expect(await response.text()).toContain('href="/orders/x"');
		expect(next).not.toHaveBeenCalled();
	});

	test("the resume 429 sends the shopper back to the order page; /cart without a valid order (#661)", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const back = async (target: string): Promise<string> =>
			(await runMiddleware(context("GET", target, "/checkout/resume"), endpoint())).text();
		expect(await back("/checkout/resume?order=ord%2F1")).toContain('href="/orders/ord%2F1"');
		// A POST carries the order in its form body, not the query: the cart.
		const post = await runMiddleware(
			context("POST", "/checkout/resume", "/checkout/resume"),
			endpoint(),
		);
		expect(post.status).toBe(429);
		expect(await post.text()).toContain('href="/cart"');
	});

	test("the email form's 429 goes back to the order page: its action carries the order (#669)", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const action = resumeFormAction("ord/1");
		const post = await runMiddleware(context("POST", action, "/checkout/resume"), endpoint());
		expect(post.status).toBe(429);
		expect(await post.text()).toContain('href="/orders/ord%2F1"');
	});

	test("rateLimitedResponse escapes backTo in the href", async () => {
		const html = await rateLimitedResponse("auth", '/x"><script>&').text();
		expect(html).toContain('href="/x&quot;&gt;&lt;script&gt;&amp;"');
		expect(html).not.toContain("<script>");
	});

	test("a cross-origin write is refused by the origin guard before it spends budget", async () => {
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const ctx = context("POST", "/cart/add", "/cart/add");
		ctx.request = new Request(ctx.url, {
			method: "POST",
			headers: { origin: "https://evil.example", "cf-connecting-ip": IP },
		});
		const response = await runMiddleware(ctx, endpoint());
		expect(response.status).toBe(403);
		expect(writes.limit).not.toHaveBeenCalled();
	});
});
