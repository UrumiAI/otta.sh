#!/usr/bin/env node
/**
 * Serve the BUILT staging Worker and check it answers (#732).
 *
 * `astro dev` (the e2e suite) runs the site's modules under Vite, and
 * `pack-build` builds the template without serving it, so nothing else loads
 * the bundled Worker the way Cloudflare does. A module that throws while the
 * Worker loads (#732: `new URL("…", import.meta.url)` at the top of a module,
 * with `import.meta.url` undefined in the bundle) answers every request with a
 * 500 and is invisible to every other test.
 *
 * This runs `wrangler dev` on `sites/staging/dist/server/wrangler.json` (local
 * workerd and miniflare: no account, token or network), waits for ITS ready
 * line (so another server on the port can never answer for it), then requests
 * `/` (must be 200) and a few lazily loaded page routes (each must be below
 * 500; a missing product's 404 still loads the product page's chunk), and
 * fails on any other answer or an error in the Worker's log. Run it after
 * `pnpm -r build`. It serves the D1 build only, not the playground build.
 *
 *   node scripts/serve-built-worker.mjs
 *
 * `OTTA_SERVE_DIST` serves another copy of the build output (default
 * `sites/staging/dist`). `OTTA_SERVE_PORT` / `OTTA_SERVE_INSPECTOR_PORT` set the ports (default:
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "sites", "staging");
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
/** What in the Worker's log means it failed, even behind a non-5xx answer. */
const LOG_FAILURES = [/Invalid URL/, /\[ERROR\]/, /Uncaught/];

if (!existsSync(CONFIG)) {
	console.error(`[serve-built-worker] ${CONFIG} is missing: run \`pnpm -r build\` first.`);
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

async function get(pathname) {
	const res = await fetch(`${ORIGIN}${pathname}`, {
		redirect: "manual",
		signal: AbortSignal.timeout(60_000),
	});
	await res.text();
	console.info(`[serve-built-worker] GET ${pathname} answered ${String(res.status)}`);
	return res.status;
}

let failure;
try {
	await ready();
	const home = await get("/");
	if (home !== 200) failure = `GET / answered ${String(home)}, not 200`;
	for (const page of PAGES) {
		const status = await get(page);
		if (failure === undefined && status >= 500) failure = `GET ${page} answered ${String(status)}`;
	}
	// Give the Worker's error log a moment to reach us.
	await sleep(1000);
	const logged = LOG_FAILURES.find((re) => re.test(log));
	if (failure === undefined && logged !== undefined) {
		failure = `the Worker logged an error (${String(logged)})`;
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
