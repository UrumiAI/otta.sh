#!/usr/bin/env node
/**
 * Serve a BUILT Worker and check it answers (#732, #734).
 *
 * `astro dev` (the e2e suite) runs the site's modules under Vite, so only a
 * served build loads the bundled Worker the way Cloudflare does. A module that
 * throws while the Worker loads (#732: `new URL("…", import.meta.url)` at the
 * top of a module, with `import.meta.url` undefined in the bundle) answers
 * every request with a 500 and is invisible to every other test.
 *
 * This runs `wrangler dev` on the build's `dist/server/wrangler.json` (local
 * workerd and miniflare: no account, token or network), waits for ITS ready
 * line (so another server on the port can never answer for it), then requests
 * `/` (must be 200) and a few lazily loaded page routes (each must be below
 * 500; a missing product's 404 still loads the product page's chunk), and
 * fails on any other answer or an error in the Worker's log. Run it after
 * `pnpm -r build`.
 *
 *   node scripts/serve-built-worker.mjs
 *
 * Three builds go through it:
 *  - the staging D1 build (the default; `ci.yml`, "Serve the built staging worker");
 *  - the playground build (`OTTA_SERVE_PLAYGROUND=1`; `ci.yml`, "Serve the
 *    built playground worker"). Every playground request without a session
 *    cookie redirects to `/playground`, so this opens a session the way the
 *    loading page does (`GET /playground` for the cookie, `POST
 *    /_playground/init` to build the visitor's database) and then checks the
 *    pages with that cookie;
 *  - the one-click template built from the packed packages
 *    (`scripts/pack-build.mjs`, with `OTTA_SERVE_SITE` set to the template copy).
 *
 * `OTTA_SERVE_DIST` serves another copy of the build output (default
 * `<site>/dist`). `OTTA_SERVE_SITE` is the site whose own wrangler runs it
 * (default `sites/staging`). `OTTA_SERVE_PORT` / `OTTA_SERVE_INSPECTOR_PORT` set the ports (default:
 * free ports picked at start); `OTTA_SERVE_TIMEOUT_MS` the wait for wrangler to
 * be ready (default 120000).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workerLogFailures } from "./serve-built-worker-log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.resolve(process.env.OTTA_SERVE_SITE ?? path.join(ROOT, "sites", "staging"));
const PLAYGROUND = process.env.OTTA_SERVE_PLAYGROUND === "1";
const DIST = path.resolve(process.env.OTTA_SERVE_DIST ?? path.join(SITE, "dist"));
const CONFIG = path.join(DIST, "server", "wrangler.json");
/** A port nothing listens on right now (the OS picks it). */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "localhost", () => {
			const address = server.address();
			server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
		});
	});
}

const PORT = Number(process.env.OTTA_SERVE_PORT ?? (await freePort()));
const INSPECTOR_PORT = Number(process.env.OTTA_SERVE_INSPECTOR_PORT ?? (await freePort()));
const TIMEOUT_MS = Number(process.env.OTTA_SERVE_TIMEOUT_MS ?? 120_000);
const ORIGIN = `http://localhost:${String(PORT)}`;

/** Page routes whose chunks load lazily: each must answer below 500. */
const PAGES = ["/products", "/cart", "/products/serve-built-worker-missing"];
/** wrangler's own ready line for THIS port. */
const READY = new RegExp(`Ready on http://localhost:${String(PORT)}\\b`);

if (!existsSync(CONFIG)) {
	console.error(`[serve-built-worker] ${CONFIG} is missing: build the site first.`);
	process.exit(1);
}

// The site's own wrangler (its `bin` is not in the package's `exports`).
const wrangler = path.join(
	path.dirname(createRequire(path.join(SITE, "package.json")).resolve("wrangler/package.json")),
	"bin",
	"wrangler.js",
);
const state = mkdtempSync(path.join(tmpdir(), "otta-serve-built-"));
const args = [
	wrangler,
	"dev",
	"--config",
	CONFIG,
	"--ip",
	"localhost",
	"--port",
	String(PORT),
	"--inspector-port",
	String(INSPECTOR_PORT),
	"--persist-to",
	state,
	"--var",
	`EMDASH_SITE_URL:${ORIGIN}`,
	// Throwaway values for a disposable local store; never a real site's.
	"--var",
	`OTTA_SETUP_TOKEN:serve-built-worker-${String(process.pid)}`,
	"--var",
	"EMDASH_ENCRYPTION_KEY:emdash_enc_v1_cugE5mpPbewXCXUpUxvpscThKOCTYMxr1Ro8lVSc_Ps",
	"--show-interactive-dev-session=false",
];

let log = "";
const child = spawn(process.execPath, args, {
	cwd: DIST,
	detached: true,
	env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
	stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		log += chunk;
		process.stdout.write(chunk);
	});
}
let exited = false;
const exit = new Promise((resolve) => {
	child.on("exit", () => {
		exited = true;
		resolve();
	});
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop wrangler's whole process group (SIGKILL after 5 s), then drop its state. */
async function stop() {
	if (!exited && child.pid !== undefined) {
		const kill = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// already gone
			}
		};
		kill("SIGTERM");
		await Promise.race([exit, sleep(5000)]);
		if (!exited) {
			kill("SIGKILL");
			await Promise.race([exit, sleep(5000)]);
		}
	}
	try {
		rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch (error) {
		console.warn(`[serve-built-worker] could not remove ${state}: ${String(error)}`);
	}
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		void stop().finally(() => process.exit(1));
	});
}

async function ready() {
	const deadline = Date.now() + TIMEOUT_MS;
	while (!READY.test(log)) {
		if (exited) throw new Error("wrangler dev exited before it was ready");
		if (Date.now() > deadline) {
			throw new Error(
				`wrangler dev was not ready on port ${String(PORT)} within ${String(TIMEOUT_MS)} ms`,
			);
		}
		await sleep(250);
	}
}

/** The cookies the Worker has set (the playground's session cookie). */
const cookies = new Map();

async function request(method, pathname) {
	const headers = { origin: ORIGIN };
	if (cookies.size > 0) {
		headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
	const res = await fetch(`${ORIGIN}${pathname}`, {
		method,
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(60_000),
	});
	for (const line of res.headers.getSetCookie()) {
		const pair = line.split(";", 1)[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	await res.text();
	console.info(`[serve-built-worker] ${method} ${pathname} answered ${String(res.status)}`);
	return res.status;
}
const get = (pathname) => request("GET", pathname);

/** The log's length once the playground session is set up (see `workerLogFailures`). */
let setupEnd;

/** Open a playground session: the cookie, then the visitor's database. */
async function openPlaygroundSession() {
	const page = await get("/playground");
	if (page !== 200) return `GET /playground answered ${String(page)}, not 200`;
	if (cookies.size === 0) return "GET /playground set no session cookie";
	const init = await request("POST", "/_playground/init");
	if (init !== 200) return `POST /_playground/init answered ${String(init)}, not 200`;
	// Let the init's expected errors reach the log, then end setup there: from
	// here on the playground allowlist no longer applies.
	await sleep(1000);
	setupEnd = log.length;
	return undefined;
}

let failure;
try {
	await ready();
	if (PLAYGROUND) failure = await openPlaygroundSession();
	if (failure !== undefined) throw new Error(failure);
	const home = await get("/");
	if (home !== 200) failure = `GET / answered ${String(home)}, not 200`;
	for (const page of PAGES) {
		const status = await get(page);
		if (failure === undefined && status >= 500) failure = `GET ${page} answered ${String(status)}`;
	}
	// Give the Worker's error log a moment to reach us.
	await sleep(1000);
	const logged = workerLogFailures(log, { playground: PLAYGROUND, setupEnd });
	if (failure === undefined && logged.length > 0) {
		failure = `the Worker logged an error: ${logged[0].trim()}`;
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
} finally {
	await stop();
}

if (failure !== undefined) {
	console.error(`[serve-built-worker] FAILED: ${failure}`);
	process.exit(1);
}
console.info("[serve-built-worker] ok: the built Worker loads and serves its pages");
process.exit(0);
