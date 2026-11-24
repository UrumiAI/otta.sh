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
 * workerd and miniflare: no account, token or network), requests `/`, and
 * fails if the answer is a 5xx or the Worker logged an error. Run it after
 * `pnpm -r build`.
 *
 *   node scripts/serve-built-worker.mjs
 *
 * `OTTA_SERVE_DIST` serves another copy of the build output (default
 * `sites/staging/dist`). `OTTA_SERVE_PORT` / `OTTA_SERVE_INSPECTOR_PORT` set the ports (default 8787
 * and 9229); `OTTA_SERVE_TIMEOUT_MS` the wait for the first answer (default
 * 120000).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "sites", "staging");
const DIST = path.resolve(process.env.OTTA_SERVE_DIST ?? path.join(SITE, "dist"));
const CONFIG = path.join(DIST, "server", "wrangler.json");
const PORT = Number(process.env.OTTA_SERVE_PORT ?? 8787);
const INSPECTOR_PORT = Number(process.env.OTTA_SERVE_INSPECTOR_PORT ?? 9229);
const TIMEOUT_MS = Number(process.env.OTTA_SERVE_TIMEOUT_MS ?? 120_000);
const ORIGIN = `http://localhost:${String(PORT)}`;

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
child.on("exit", () => {
	exited = true;
});

function stop() {
	if (!exited && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	rmSync(state, { recursive: true, force: true });
}

async function firstAnswer() {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited) throw new Error("wrangler dev exited before the Worker answered");
		try {
			return await fetch(`${ORIGIN}/`, {
				redirect: "manual",
				signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
			});
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	throw new Error(`no answer from ${ORIGIN}/ within ${String(TIMEOUT_MS)} ms`);
}

let failure;
try {
	const res = await firstAnswer();
	await res.text();
	// Give the Worker's error log a moment to reach us.
	await new Promise((resolve) => setTimeout(resolve, 1000));
	console.info(`\n[serve-built-worker] GET / answered ${String(res.status)}`);
	if (res.status >= 500) failure = `GET / answered ${String(res.status)}`;
	const logged = LOG_FAILURES.find((re) => re.test(log));
	if (failure === undefined && logged !== undefined) {
		failure = `the Worker logged an error (${String(logged)})`;
	}
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
} finally {
	stop();
}

if (failure !== undefined) {
	console.error(`[serve-built-worker] FAILED: ${failure}`);
	process.exit(1);
}
console.info("[serve-built-worker] ok: the built Worker loads and serves /");
