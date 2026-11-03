/**
 * The setup-claim gate (ADR-0042): while EmDash setup is not complete, only the
 * holder of a one-time SETUP TOKEN may reach `/_emdash/*`.
 *
 * WHY. EmDash hands the first admin account to whoever finishes its setup
 * wizard first, and EmDash has no setup token of its own. A store deployed by a
 * Deploy-to-Cloudflare button is reachable before its owner opens it, so
 * "first visitor wins" would be a race the owner can lose. The gate closes it
 * in the site, before any EmDash route runs.
 *
 * WHAT IS GATED. Every route under `/_emdash` (default-deny, keyed on the
 * ROUTE Astro matched, with the decoded path as a backstop), on every method,
 * except the three in {@link SETUP_GATE_EXEMPT_ROUTES}: none of them can
 * create a user or finish setup. A route a future EmDash adds is gated without
 * anyone remembering to list it. The storefront is never looked at: the check
 * is a string test that returns before any state or database is touched.
 *
 * THE TOKEN. The Worker secret `OTTA_SETUP_TOKEN` when it is set (it must pass
 * {@link validateSetupTokenSecret}; a set-but-weak secret fails CLOSED, it does
 * not fall back). Otherwise a 256-bit token generated on the first gated
 * request, inserted into EmDash's `options` table with INSERT … ON CONFLICT DO
 * NOTHING (so concurrent first requests in different isolates converge on ONE
 * token), and its claim link written once with `console.log` for the account
 * owner to read in Workers Logs.
 *
 * DELIVERY. The deployer opens `/_emdash/admin/setup?setup_token=<token>`. A
 * correct token is answered with a page that sets an HttpOnly, SameSite=Strict,
 * `/_emdash/`-scoped, one-hour cookie (Secure except on a loopback host) and
 * refreshes to the same URL without the token. A META REFRESH and not a 3xx:
 * the link is usually opened from another site (the Cloudflare dashboard), and
 * a redirect chain that starts cross-site does not carry a SameSite=Strict
 * cookie, while a same-origin page's own navigation does. The wizard's API
 * calls then carry the cookie. The token is accepted from the query string on
 * GET/HEAD only; a write must carry the cookie.
 *
 * ONCE CLAIMED, INERT. Setup is complete when EmDash's `emdash:setup_complete`
 * option is true AND a user exists (EmDash's own definition in passkey mode).
 * The first request that sees it caches it in isolate memory, and from then on
 * the gate costs no query at all. An UNCLAIMED answer is never cached, so the
 * owner's first request after finishing the wizard is let through.
 *
 * FAIL CLOSED. No database, a query error, a missing token: the gated request
 * is refused (503 or 403), never let through.
 */
import { constantTimeEquals } from "@urumi.ai/otta-plugin";
import { OptionsRepository } from "emdash";
import { sql } from "kysely";
import { PRIVATE_NO_STORE } from "./no-store.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_CLAIM_COOKIE_PATH,
	SETUP_CLAIM_LOG_TAG,
	SETUP_CLAIM_MAX_AGE_SECONDS,
	SETUP_CLAIM_PATH,
	SETUP_TOKEN_PARAM,
	SETUP_TOKEN_SECRET,
	setupClaimUrl,
} from "./setup-claim-contract.js";

/** EmDash's database handle, as its own repositories take it. */
export type SetupClaimDb = ConstructorParameters<typeof OptionsRepository>[0];

/** The option row a generated token is kept in. */
export const SETUP_TOKEN_OPTION = "otta:setup_token";

/** EmDash's own completion flag (`setup-complete` in emdash@1.3.1). */
const SETUP_COMPLETE_OPTION = "emdash:setup_complete";

/** The prefix every EmDash route lives under. */
const EMDASH_PREFIX = "/_emdash";

/**
 * Routes under `/_emdash` that stay open while the store is unclaimed, keyed
 * by Astro route pattern, each with the reason it cannot create the first
 * admin or finish setup.
 */
export const SETUP_GATE_EXEMPT_ROUTES: ReadonlyMap<string, string> = new Map([
	[
		"/_emdash/api/media/file/[...key]",
		"public media reads (storefront images); GET only, writes nothing",
	],
	[
		"/_emdash/api/plugins/[pluginId]/[...path]",
		"plugin routes: the storefront's own commerce calls. Plugins cannot create EmDash users, " +
			"and their admin routes need a signed-in user, which an unclaimed store does not have",
	],
	["/_emdash/api/health", "a liveness probe; reads nothing secret, writes nothing"],
]);

/** The shortest secret accepted, in characters. */
export const MIN_SETUP_TOKEN_LENGTH = 32;

/** The least entropy a secret may carry, estimated as length × log2(distinct
 *  characters): `openssl rand -hex 32` scores 256, a generated token ~300. */
export const MIN_SETUP_TOKEN_BITS = 128;

const URL_SAFE = /^[A-Za-z0-9_-]+$/;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ── pure decisions ─────────────────────────────────────────────────────────

function underEmdash(path: string): boolean {
	return path === EMDASH_PREFIX || path.startsWith(`${EMDASH_PREFIX}/`);
}

function decodedPath(pathname: string): string {
	try {
		return decodeURI(pathname);
	} catch {
		return pathname;
	}
}

/**
 * Does the gate look at this request at all? Pure, and the ONLY thing a
 * storefront request ever runs. Gated: the matched route or the (decoded) path
 * is under `/_emdash`, and the route is not exempt.
 */
export function setupGateApplies(routePattern: string | undefined, pathname: string): boolean {
	// Astro always sets the route; without one, the path alone decides.
	routePattern ??= "";
	const onEmdash =
		underEmdash(routePattern) || underEmdash(pathname) || underEmdash(decodedPath(pathname));
	if (!onEmdash) return false;
	return !SETUP_GATE_EXEMPT_ROUTES.has(routePattern);
}

export type SecretCheck =
	| { kind: "unset" }
	| { kind: "valid"; token: string }
	| { kind: "invalid"; reason: string };

/** The `OTTA_SETUP_TOKEN` secret, checked. Unset is not an error (the gate
 *  generates a token); set-but-weak is, and fails closed. */
export function validateSetupTokenSecret(value: unknown): SecretCheck {
	if (value === undefined || value === null || value === "") return { kind: "unset" };
	if (typeof value !== "string") return { kind: "invalid", reason: "it is not a string" };
	const token = value.trim();
	if (token.length < MIN_SETUP_TOKEN_LENGTH) {
		return {
			kind: "invalid",
			reason: `it is shorter than ${String(MIN_SETUP_TOKEN_LENGTH)} characters`,
		};
	}
	if (!URL_SAFE.test(token)) {
		return { kind: "invalid", reason: "it may only use A-Z, a-z, 0-9, '-' and '_'" };
	}
	const distinct = new Set(token).size;
	if (token.length * Math.log2(distinct) < MIN_SETUP_TOKEN_BITS) {
		return { kind: "invalid", reason: "it repeats too few characters to be random" };
	}
	return { kind: "valid", token };
}

/** A fresh 256-bit token, base64url (43 characters). */
export function generateSetupToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isLoopback(url: URL): boolean {
	return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
}

/**
 * The origin a claim link is written for: HTTPS unless the host is loopback.
 * A store's first `/_emdash` request may arrive over plain HTTP, and a link
 * built from it would carry the token in cleartext, and its Secure cookie
 * would be dropped by the browser.
 */
export function claimOrigin(url: URL): string {
	return isLoopback(url) ? url.origin : `https://${url.host}`;
}

/** The committed e2e token is refused anywhere but a loopback host: it is
 *  public, so a store that adopted it would be claimable by anyone. */
export function isPublicTokenOffLoopback(token: string, url: URL): boolean {
	return token === PUBLIC_E2E_SETUP_TOKEN && !isLoopback(url);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// ── the database ───────────────────────────────────────────────────────────

function parseOption(raw: unknown): unknown {
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

interface ClaimState {
	complete: boolean;
	storedToken: string | null;
}

/** ONE query: is setup complete, and is a generated token stored? */
export async function readClaimState(db: SetupClaimDb): Promise<ClaimState> {
	const result = await sql<{ complete: unknown; has_users: unknown; token: unknown }>`
		SELECT
			(SELECT value FROM options WHERE name = ${SETUP_COMPLETE_OPTION}) AS complete,
			EXISTS (SELECT 1 FROM users) AS has_users,
			(SELECT value FROM options WHERE name = ${SETUP_TOKEN_OPTION}) AS token
	`.execute(db);
	const row = result.rows[0];
	const flag = parseOption(row?.complete);
	const hasUsers = row?.has_users === true || Number(row?.has_users) > 0;
	const token = parseOption(row?.token);
	return {
		complete: (flag === true || flag === "true") && hasUsers,
		storedToken: typeof token === "string" && token.length > 0 ? token : null,
	};
}

/**
 * The stored token, minting it if absent. INSERT … ON CONFLICT DO NOTHING is
 * the arbiter: of any number of concurrent callers exactly one inserts
 * (`minted: true`) and every other reads that row back.
 */
export async function ensureStoredSetupToken(
	db: SetupClaimDb,
	generate: () => string,
): Promise<{ token: string; minted: boolean }> {
	const options = new OptionsRepository(db);
	const candidate = generate();
	if (await options.setIfAbsent(SETUP_TOKEN_OPTION, candidate)) {
		return { token: candidate, minted: true };
	}
	const stored = await options.get(SETUP_TOKEN_OPTION);
	if (typeof stored !== "string" || stored.length === 0) {
		throw new Error(`${SETUP_TOKEN_OPTION} exists but holds no token`);
	}
	return { token: stored, minted: false };
}

// ── the responses ──────────────────────────────────────────────────────────

const REFUSAL_MESSAGE =
	"This store has not been claimed yet. Setup needs the private setup link, " +
	"which only the person who deployed the store can see: it is in the Worker's logs " +
	`(search for ${SETUP_CLAIM_LOG_TAG}) or the dev server's console.`;

/** The 403 for a document. Identical in every mode, so it says nothing about
 *  whether a token exists or where it came from. */
const REFUSAL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Store setup is locked</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem;color:#1d1d1b}code{background:#f1efe9;padding:.1em .3em;border-radius:3px;word-break:break-all}h1{font-size:1.5rem}</style>
</head>
<body>
<main>
<h1>This store hasn't been set up yet</h1>
<p>Setting it up creates its first admin, so it needs the private setup link. Only the person who deployed the store can see that link.</p>
<h2>Deployed it yourself?</h2>
<ul>
<li>Open your Cloudflare dashboard, go to <strong>Workers &amp; Pages</strong>, choose this store's Worker and open <strong>Workers Logs</strong>. Search for <code>${SETUP_CLAIM_LOG_TAG}</code> and open the link in that line.</li>
<li>Running it locally? The dev server's console prints the same <code>${SETUP_CLAIM_LOG_TAG}</code> line.</li>
<li>If you set the <code>${SETUP_TOKEN_SECRET}</code> secret, open <code>${SETUP_CLAIM_PATH}?${SETUP_TOKEN_PARAM}=</code> followed by its value.</li>
</ul>
<p>The link keeps working until setup is finished, so you can open it again in another browser.</p>
</main>
</body>
</html>
`;

const REFUSAL_HEADERS = {
	"Cache-Control": PRIVATE_NO_STORE,
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Robots-Tag": "noindex",
};

function refusal(url: URL): Response {
	if (url.pathname.startsWith(`${EMDASH_PREFIX}/api`)) {
		return Response.json(
			{ error: { code: "SETUP_CLAIM_REQUIRED", message: REFUSAL_MESSAGE } },
			{ status: 403, headers: REFUSAL_HEADERS },
		);
	}
	return new Response(REFUSAL_PAGE, {
		status: 403,
		headers: { ...REFUSAL_HEADERS, "Content-Type": "text/html; charset=utf-8" },
	});
}

function unavailable(): Response {
	return new Response("Store setup is temporarily unavailable. Try again in a moment.", {
		status: 503,
		headers: { ...REFUSAL_HEADERS, "Retry-After": "5" },
	});
}

function toHttps(url: URL): Response {
	const secure = new URL(url);
	secure.protocol = "https:";
	return new Response(null, {
		status: 307,
		headers: { ...REFUSAL_HEADERS, Location: secure.toString() },
	});
}

function claimCookie(token: string, url: URL): string {
	const parts = [
		`${SETUP_CLAIM_COOKIE}=${token}`,
		`Path=${SETUP_CLAIM_COOKIE_PATH}`,
		`Max-Age=${String(SETUP_CLAIM_MAX_AGE_SECONDS)}`,
		"HttpOnly",
		"SameSite=Strict",
	];
	if (!isLoopback(url)) parts.push("Secure");
	return parts.join("; ");
}

/** The answer to a correct link: set the cookie, then navigate (same-origin,
 *  from this page) to the same URL without the token. */
function claimed(token: string, url: URL): Response {
	const clean = new URL(url);
	clean.searchParams.delete(SETUP_TOKEN_PARAM);
	const target = escapeHtml(`${clean.pathname}${clean.search}`);
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${target}">
<title>Opening store setup</title>
</head>
<body><p><a href="${target}">Continue to store setup</a></p></body>
</html>
`;
	return new Response(body, {
		status: 200,
		headers: {
			...REFUSAL_HEADERS,
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": claimCookie(token, url),
		},
	});
}

// ── the gate ───────────────────────────────────────────────────────────────

/** What the gate reads from Astro's context (structurally a subset of it). */
export interface SetupClaimContext {
	request: Request;
	url: URL;
	routePattern: string | undefined;
	cookies: { get(name: string): { value: string } | undefined };
	locals: { emdash?: { db?: SetupClaimDb | undefined } | undefined };
}

export interface SetupClaimGate {
	/** The refusal (or the claim page) for this request, or null to proceed. */
	check(
		context: SetupClaimContext,
		env: Record<string, unknown> | undefined,
	): Promise<Response | null>;
}

export interface SetupClaimGateOptions {
	generate?: () => string;
	/** Where the claim link is written (the account owner's Workers Logs). */
	log?: (line: string) => void;
	/** Where operator problems are written. */
	warn?: (line: string) => void;
}

/** A gate with its own isolate memory. The middleware uses ONE per isolate
 *  ({@link setupClaimGate}); tests make fresh ones to stand for isolates. */
export function createSetupClaimGate(options: SetupClaimGateOptions = {}): SetupClaimGate {
	const generate = options.generate ?? generateSetupToken;
	const log = options.log ?? ((line: string) => console.log(line));
	const warn = options.warn ?? ((line: string) => console.error(line));
	let complete = false;
	let warnedSecret = false;
	let warnedNoDb = false;

	function refuseSecret(reason: string): null {
		if (!warnedSecret) {
			warnedSecret = true;
			warn(
				`${SETUP_CLAIM_LOG_TAG} ${SETUP_TOKEN_SECRET} is set but refused: ${reason}. ` +
					`Store setup stays LOCKED until it is fixed (use at least ${String(MIN_SETUP_TOKEN_LENGTH)} ` +
					`random URL-safe characters, e.g. \`openssl rand -hex 32\`) or deleted.`,
			);
		}
		return null;
	}

	async function expectedToken(
		db: SetupClaimDb,
		state: ClaimState,
		env: Record<string, unknown> | undefined,
		url: URL,
	): Promise<string | null> {
		const secret = validateSetupTokenSecret(env?.[SETUP_TOKEN_SECRET]);
		if (secret.kind === "valid") {
			return isPublicTokenOffLoopback(secret.token, url)
				? refuseSecret("it is the public e2e token committed to the Otta repository")
				: secret.token;
		}
		if (secret.kind === "invalid") return refuseSecret(secret.reason);
		if (state.storedToken !== null) return state.storedToken;
		const { token, minted } = await ensureStoredSetupToken(db, generate);
		if (minted) {
			log(
				`${SETUP_CLAIM_LOG_TAG} This store is unclaimed. To set it up and become its admin, ` +
					`open: ${setupClaimUrl(claimOrigin(url), token)} (written once; it works until setup is finished)`,
			);
		}
		return token;
	}

	return {
		async check(context, env) {
			const { url, request, routePattern, cookies } = context;
			if (!setupGateApplies(routePattern, url.pathname)) return null;
			if (complete) return null;

			const db = context.locals.emdash?.db;
			if (db === undefined) {
				if (!warnedNoDb) {
					warnedNoDb = true;
					warn(`${SETUP_CLAIM_LOG_TAG} no EmDash database on a gated request; refusing.`);
				}
				return unavailable();
			}
			let expected: string | null;
			try {
				const state = await readClaimState(db);
				if (state.complete) {
					complete = true;
					return null;
				}
				expected = await expectedToken(db, state, env, url);
			} catch (error) {
				warn(`${SETUP_CLAIM_LOG_TAG} could not read the setup state; refusing: ${String(error)}`);
				return unavailable();
			}

			const method = request.method.toUpperCase();
			const presented = url.searchParams.get(SETUP_TOKEN_PARAM);
			if (presented !== null && (method === "GET" || method === "HEAD")) {
				// Over plain HTTP off loopback the Secure cookie would be dropped and
				// the claim would end on the 403 page with no reason given. Move the
				// same request to HTTPS first; the token is checked there.
				if (url.protocol === "http:" && !isLoopback(url)) return toHttps(url);
				return expected !== null && constantTimeEquals(presented, expected)
					? claimed(expected, url)
					: refusal(url);
			}
			const cookie = cookies.get(SETUP_CLAIM_COOKIE)?.value;
			if (expected !== null && cookie !== undefined && constantTimeEquals(cookie, expected)) {
				return null;
			}
			return refusal(url);
		},
	};
}

/** The isolate's gate. */
let isolateGate = createSetupClaimGate();

/** The middleware's entry point. */
export function setupClaimGate(): SetupClaimGate {
	return isolateGate;
}

/** Forget the isolate's memory (a fresh isolate), for the middleware tests. */
export function resetSetupClaimForTesting(): void {
	isolateGate = createSetupClaimGate();
}
