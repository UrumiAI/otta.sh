/**
 * Otta's own workerd-on-Node sandbox test harness (plan §6 step 1).
 *
 * Boots the REAL `workerd` binary (the public `workerd` npm package — not a
 * simulation, not Node `vm`/`worker_threads`) as a child process, loads
 * `src/sandbox-entry.ts` (bundled fresh per call via tsdown's programmatic
 * `build()`) as its worker module, and exposes `invokeHook`/`invokeRoute`
 * mirroring the wire shape em-dash's own `WorkerdSandboxedPlugin` uses
 * (`~/em-dash` `packages/workerd/src/sandbox/runner.ts` —
 * `POST /hook/<name>` / `POST /route/<name>`).
 *
 * `manifest.ts` is never mutated in `src/` — this harness copies the whole
 * `src/` tree into a scratch dir and overwrites ONLY the copy's
 * `manifest.ts` with the test's `allowedHosts` (and the in-process
 * `emailApiUrl`/`facilitatorUrl` egress) before bundling (plan §6 step 1 /
 * §8 Risk 5), so `pnpm build`'s real package output is never test-specific.
 *
 * `sandbox-storage.ts` is overwritten the same way when — and ONLY when — a boot
 * asks for storage (`storage: true`). The isolate cannot build a document store (it
 * is a database, and the isolate has no driver and must never acquire one), so the
 * store lives in this process and the copy's collections proxy to it over loopback.
 *
 * THAT IS OPT-IN, and the reason is a claim several suites make: with a single
 * baked `allowedHost`, the stub server's recorded requests ARE the plugin's entire
 * egress. The bridge's proxy calls `fetch` directly — it is the host's side of a
 * bridge, not plugin egress, so it is not subject to `allowedHosts` — and binding
 * it into every boot would quietly make that claim false. A suite that does not ask
 * for a document store therefore does not get one, and keeps a context byte-identical
 * to the one it always had.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { COMMERCE_STORAGE_COLLECTION_NAMES } from "../../src/commerce/commerce-storage.js";
import {
	type InProcessEgressUrls,
	resolveAllowedHosts,
	resolveInProcessEgress,
	STRIPE_API_HOST,
} from "../../src/manifest.js";
import { sandboxStorageSource, storageBridge } from "./storage-bridge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "../..");
const PLUGIN_SRC = path.join(PLUGIN_ROOT, "src");
/**
 * The workspace packages `src/` imports AT RUNTIME — see
 * {@link materializeWorkspacePackages}. `admin-presentation` is the console's
 * shared formatting; `domain` and `store-emdash` are what in-process commerce is
 * MADE of, so they arrived the moment the plugin stopped talking to a service.
 *
 * Each entry names the package's own `exports` map as its package.json declares
 * it at dev time, so the scratch copy resolves the identical files a plain test
 * run does.
 */
const WORKSPACE_PACKAGES: ReadonlyArray<{
	readonly name: string;
	readonly exports: Record<string, string>;
}> = [
	{ name: "admin-presentation", exports: { ".": "./src/index.ts" } },
	{ name: "domain", exports: { ".": "./src/index.ts", "./testing": "./src/testing/index.ts" } },
	// INC-C1b: the `webhooks/stripe/settle` route verifies the webhook HMAC INSIDE
	// the isolate, so the Stripe adapter became a runtime import like the two
	// beside it — and it is bundled into the deployed artifact for the same reason
	// (`tsdown.config.ts` `noExternal`). Absent from this list, the worker fails to
	// boot at all with `No such module "@otta-sh/payments-stripe"`.
	{ name: "payments-stripe", exports: { ".": "./src/index.ts" } },
	// INC-C5: x402 settlement is wired inside the isolate now (the gateway plus
	// `createHttpFacilitator` over `ctx.http`), so the x402 adapter is a runtime
	// import for exactly the same reason the Stripe one above is.
	{ name: "payments-x402", exports: { ".": "./src/index.ts" } },
	{ name: "store-emdash", exports: { ".": "./src/index.ts" } },
];
/** `-I` search root for the capnp `/workerd/workerd.capnp` builtin import —
 *  resolves via this package's own `node_modules/workerd` (a direct
 *  devDependency). */
const CAPNP_IMPORT_ROOT = path.join(PLUGIN_ROOT, "node_modules");
// NOT `.bin/workerd`: pnpm's generated bin shim always does `exec node
// <target>`, but the `workerd` npm package's postinstall (install.js)
// overwrites its own `bin/workerd` in place with the raw platform ELF
// binary (see `node_modules/workerd/install.js`) — so pnpm's shim ends up
// doing `node <ELF file>`, which fails. Resolve the real (post-postinstall)
// binary path directly instead.
const WORKERD_BIN = path.join(CAPNP_IMPORT_ROOT, "workerd", "bin", "workerd");

/**
 * The allowlist a REAL deployment boots with, plus whatever extra hosts (a stub
 * server, usually) the suite needs — for a boot that must NOT run under a gate
 * narrower than production's.
 *
 * WHY THIS EXISTS (review round 3, item 1). {@link SandboxOptions.allowedHosts}
 * is taken verbatim, which is right for the many suites whose whole claim is a
 * DELIBERATELY narrow gate (`allowedHosts: []` — "this screen reaches the
 * network never"; a single stub host — "the stub's recorded requests are the
 * plugin's entire egress"). Those are strictly stronger than production, so they
 * cannot produce a false green. The reverse case can: a suite that exercises a
 * path production reaches Stripe from, booted WITHOUT `STRIPE_API_HOST`, is
 * running under a gate no deployment has — and a Stripe grant lost from
 * `resolveAllowedHosts` would leave it green.
 *
 * So such a boot derives its list from production's OWN resolver rather than
 * restating it, and the assertion below is the central guard the review asked
 * for: drop `STRIPE_API_HOST` from `resolveAllowedHosts` and every suite that
 * boots this way fails, loudly, naming the reason.
 */
export function productionAllowedHosts(
	extraHosts: readonly string[] = [],
	egress: InProcessEgressUrls = {},
): string[] {
	const hosts = resolveAllowedHosts(egress);
	if (!hosts.includes(STRIPE_API_HOST)) {
		throw new Error(
			`resolveAllowedHosts no longer grants ${STRIPE_API_HOST}: a sandbox boot that ` +
				"exercises the Stripe path would run under a gate no real deployment has. " +
				`Resolved: ${JSON.stringify(hosts)}`,
		);
	}
	return [...new Set([...hosts, ...extraHosts])];
}

export interface SandboxOptions {
	/**
	 * Hosts `ctx.http.fetch` is allowed to reach (plan §5).
	 *
	 * TAKEN VERBATIM, deliberately — production derives its list from the egress
	 * defines, this takes what the suite hands it, because most suites' claim IS
	 * the narrow list (`[]` = no egress at all; one stub host = the stub's
	 * recorded requests are the whole of it). A boot that must match production's
	 * real gate — anything exercising a Stripe path — passes
	 * {@link productionAllowedHosts} here instead of restating the hosts.
	 */
	allowedHosts: string[];
	/**
	 * Baked into the bundled plugin as `IN_PROCESS_EGRESS_URLS` — the in-process
	 * email-provider and x402-facilitator endpoints (INC-C5). Both default to
	 * absent, which is the fail-closed "this provider is not configured" state:
	 * the email sweep reports `skipped` and no x402 gateway is wired.
	 *
	 * A suite that sets one of these is responsible for putting the matching host
	 * in `allowedHosts` too — production derives the allowlist from these values,
	 * this harness takes the allowlist verbatim.
	 */
	emailApiUrl?: string;
	facilitatorUrl?: string;
	/** Worker entry module, relative to `src/` (default the production
	 *  `sandbox-entry.ts`). Test fixtures under `src/**\/testing/` (e.g. the
	 *  scaffold's `admin/scaffold/testing/geo-entry.ts`) can be booted through
	 *  the same `createSandboxWorker` bridge by pointing here. */
	entry?: string;
	/**
	 * Bind a REAL document store to `ctx.storage` for this boot (default: no).
	 *
	 * OPT-IN on purpose — see this module's doc: the bridge that carries it calls
	 * `fetch` directly, so binding it unconditionally would falsify the "the stub's
	 * recorded requests are the plugin's entire egress" claim every proxy suite
	 * makes. Ask for it only in a suite that exercises storage.
	 */
	storage?: boolean;
}

export type InvocationOutcome = { result: unknown } | { error: string };

export interface SandboxHandle {
	invokeHook(name: string, event: unknown): Promise<InvocationOutcome>;
	invokeRoute(
		name: string,
		input: unknown,
		request?: { method?: string; url?: string; headers?: Record<string, string> },
	): Promise<InvocationOutcome>;
	/** Raw access for asserting on plain HTTP behavior (e.g. unknown routes). */
	rawFetch(pathname: string, init?: RequestInit): Promise<Response>;
	close(): Promise<void>;
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/**
 * True when a boot failure has the bind-race signature: `findFreePort()`
 * checks a port is free, then hands it to workerd's own bind a moment
 * later — under parallel suite load another process can grab it in
 * between (INC-25). workerd's own stderr (surfaced via the "workerd exited
 * early ..." error text) says `bind(...): Address already in use` — and
 * Node's native `EADDRINUSE` listen errors ("listen EADDRINUSE: address
 * already in use ...") already contain that same phrase, so one check
 * covers both. Anything else is a real defect and must not be retried.
 */
function isPortBindRace(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /address already in use/i.test(message);
}

export interface BootRetryOptions {
	/** Overridable for tests; defaults to the real `findFreePort`. */
	allocatePort?: () => Promise<number>;
	/** Bounded — a real defect must fail loudly, not retry forever. */
	maxAttempts?: number;
	/** Tiny pause between attempts; 0 in tests. */
	backoffMs?: number;
}

/**
 * Boots workerd with bounded retry on the port-bind race (INC-25): on an
 * EADDRINUSE-shaped failure, allocate a FRESH port and retry (≤3 attempts
 * by default, tiny backoff). Any other boot failure — a real compile error,
 * a genuine crash — is rethrown immediately on the first attempt; it is
 * never retried, so this never masks an actual defect.
 */
export async function bootWithPortRetry<T>(
	boot: (port: number) => Promise<T>,
	{ allocatePort = findFreePort, maxAttempts = 3, backoffMs = 50 }: BootRetryOptions = {},
): Promise<T> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const port = await allocatePort();
		try {
			return await boot(port);
		} catch (err) {
			const isRace = isPortBindRace(err);
			if (!isRace || attempt === maxAttempts) {
				// Only label this as a persisted race when it actually IS one —
				// an unrelated failure on a later attempt (e.g. attempt 1 lost the
				// bind race, attempt 2 hit a real compile error) must surface
				// unwrapped, not be misattributed to the race.
				if (isRace && attempt > 1 && err instanceof Error) {
					throw new Error(
						`workerd port-bind race persisted after ${attempt} attempts: ${err.message}`,
						{ cause: err },
					);
				}
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
	// Unreachable: the loop always returns or throws on its final iteration.
	throw new Error("bootWithPortRetry: exhausted attempts without a result");
}

async function waitUntilReady(baseUrl: string, deadlineMs: number): Promise<void> {
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < deadlineMs) {
		try {
			await fetch(`${baseUrl}/hook/__ready__`, { method: "POST", body: "{}" });
			return;
		} catch (err) {
			lastErr = err;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`workerd did not become ready within ${deadlineMs}ms: ${String(lastErr)}`);
}

function manifestSource(options: SandboxOptions): string {
	// Mirrors the real `src/manifest.ts` exported surface (the rest of src imports
	// from here). INC-D3a retired the http/in-process mode branch AND the
	// commerce-service deployment along with it — there is no more
	// `COMMERCE_SERVICE_BASE_URL` and no more write-gate service/internal token to
	// mirror, so this is now just the egress surface production actually has.
	return [
		'export const OTTA_PLUGIN_ID = "otta";',
		'export const OTTA_PLUGIN_VERSION = "0.1.0";',
		'export const OTTA_PLUGIN_CAPABILITIES = ["content:read", "network:request"];',
		`export const ALLOWED_HOSTS = ${JSON.stringify(options.allowedHosts)};`,
		// INC-C5: the email sender and the x402 wiring read their endpoints from
		// here, the same build-time constant `ALLOWED_HOSTS` is derived from in
		// production. Absent ⇒ that provider is unconfigured (fail-closed).
		//
		// ROUTED THROUGH THE REAL RESOLVER (review round 2, B5), not baked verbatim.
		// Baking the raw options made the sandbox tier the ONE tier where the gate
		// `resolveInProcessEgress` applies was never exercised: a suite could hand
		// the isolate a URL no `allowedHosts` entry covers and every assertion would
		// still pass. INC-D3a dropped the resolver's mode argument along with the
		// http arm it used to select — the unparseable-define behavior stays
		// unit-pinned in `manifest-override.test.ts`.
		`export const IN_PROCESS_EGRESS_URLS = ${JSON.stringify(
			resolveInProcessEgress({
				emailApiUrl: options.emailApiUrl,
				facilitatorUrl: options.facilitatorUrl,
			}),
		)};`,
		"",
	].join("\n");
}

function capnpConfig(port: number, bundlePathRelativeToWorkDir: string): string {
	return [
		'using Workerd = import "/workerd/workerd.capnp";',
		"",
		"const config :Workerd.Config = (",
		"  services = [",
		'    (name = "main", worker = .mainWorker),',
		// Outbound network is open to public+private (a local ephemeral test
		// server is on loopback, hence "private"); the actual capability
		// boundary this plan cares about is the JS-level allowedHosts check in
		// sandbox-entry.ts's ctx.http, exercised regardless of this policy.
		'    (name = "internet", network = (allow = ["public", "private"])),',
		"  ],",
		"  sockets = [",
		`    (name = "http", address = "127.0.0.1:${port}", http = (), service = "main"),`,
		"  ],",
		");",
		"",
		"const mainWorker :Workerd.Worker = (",
		"  modules = [",
		`    (name = "worker.js", esModule = embed "${bundlePathRelativeToWorkDir}"),`,
		"  ],",
		'  compatibilityDate = "2024-01-01",',
		");",
		"",
	].join("\n");
}

/**
 * Put every workspace package the plugin imports at runtime where the scratch copy
 * of `src/` can resolve it.
 *
 * WHY ANYTHING IS NEEDED. The copy lives under the OS temp directory, so Node's
 * resolution walks the scratch directory's own `node_modules`, then
 * `/tmp/node_modules`, then `/node_modules`, and finds nothing: a bare
 * `@otta-sh/…` specifier would be left external by the bundler and workerd would
 * fail to load a module that imports a package it has no way to fetch.
 *
 * WHY THIS IS NOT A WEAKENING. What the bare copy pins is that the SHIPPED BUNDLE
 * IS SELF-CONTAINED. Materialising the packages here makes the specifiers
 * resolvable, and `noExternal` at the `build()` call makes tsdown INLINE them into
 * the single `.mjs` workerd loads — so the bundle stays exactly as self-contained
 * as before, and the suites still prove it by running.
 *
 * THE INLINING IS DECLARED, NOT INHERITED, and the first cut of this comment got
 * that wrong. It claimed the scratch tree "has no package.json declaring externals,
 * so tsdown inlines it" — but tsdown resolves its externals from the package.json
 * nearest the CWD, not the entry, and the CWD is the process's. From the repo root
 * that is a manifest with no `dependencies` and the inlining happened by accident;
 * from this package's own directory it is THIS manifest, where the workspace
 * packages are real dependencies, so tsdown left them external and every workerd
 * test failed to boot. Measured, both ways. The `noExternal` below states the
 * requirement instead of inheriting it, so the suites pass from any working
 * directory.
 *
 * ONLY `src/` IS COPIED, never a package's own `node_modules` (symlinks into the
 * pnpm store for tsdown/vitest/typescript, none of which belong in a worker
 * bundle's resolution graph), and the generated manifest points `exports` at the
 * TypeScript source — the same dev-time `exports` the real package.json declares.
 */
async function materializeWorkspacePackages(workDir: string): Promise<void> {
	for (const pkg of WORKSPACE_PACKAGES) {
		const packageDir = path.join(workDir, "node_modules", "@otta-sh", pkg.name);
		await cp(path.resolve(PLUGIN_ROOT, "..", pkg.name, "src"), path.join(packageDir, "src"), {
			recursive: true,
		});
		await writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: `@otta-sh/${pkg.name}`,
					version: "0.0.0-sandbox",
					type: "module",
					exports: pkg.exports,
				},
				null,
				2,
			),
			"utf8",
		);
	}
}

export async function loadPluginInSandbox(options: SandboxOptions): Promise<SandboxHandle> {
	const workDir = await mkdtemp(path.join(tmpdir(), "otta-plugin-sandbox-"));
	const srcDir = path.join(workDir, "src");
	await cp(PLUGIN_SRC, srcDir, { recursive: true });
	await writeFile(path.join(srcDir, "manifest.ts"), manifestSource(options), "utf8");
	await materializeWorkspacePackages(workDir);

	// The worker side of the document-store bridge, written over the scratch copy
	// exactly as `manifest.ts` is — and ONLY for a boot that asked for storage, so
	// a proxy suite's egress claim stays true. `src/` stays free of it either way,
	// which is what keeps the egress guard's "one sanctioned fetch call site" claim
	// about the real sources honest.
	if (options.storage === true) {
		const bridge = await storageBridge();
		await writeFile(
			path.join(srcDir, "sandbox-storage.ts"),
			sandboxStorageSource(bridge.baseUrl, COMMERCE_STORAGE_COLLECTION_NAMES),
			"utf8",
		);
	}

	const entryRel = options.entry ?? "sandbox-entry.ts";
	const distDir = path.join(workDir, "dist");
	await build({
		entry: [path.join(srcDir, entryRel)],
		outDir: distDir,
		format: ["esm"],
		dts: false,
		logLevel: "silent",
		// EVERY workspace package the plugin imports is INLINED, always, from any
		// working directory. See `materializeWorkspacePackages` — tsdown reads
		// externals from the package.json nearest the CWD, so without this the
		// bundle is self-contained under `pnpm test` and broken under
		// `pnpm --filter @otta-sh/plugin exec vitest`. The pattern is the SCOPE
		// rather than the one package, because a second shared package would
		// otherwise reintroduce exactly this failure and only in one invocation.
		noExternal: [/^@otta-sh\//],
	});

	// tsdown emits a single entry flat into outDir under the entry's basename.
	const bundlePath = path.join(distDir, `${path.basename(entryRel, ".ts")}.mjs`);
	const configPath = path.join(workDir, "config.capnp");

	// findFreePort() and workerd's own bind are two separate steps (see
	// bootWithPortRetry above) — wrap the whole spawn-and-wait sequence so a
	// lost bind race gets a fresh port on retry, not the same doomed one.
	const { child, baseUrl } = await bootWithPortRetry(async (port) => {
		await writeFile(configPath, capnpConfig(port, path.relative(workDir, bundlePath)), "utf8");

		const bootChild: ChildProcessByStdio<null, Readable, Readable> = spawn(
			WORKERD_BIN,
			["serve", "-I", CAPNP_IMPORT_ROOT, configPath],
			{ cwd: workDir, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		bootChild.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exitPromise = new Promise<never>((_resolve, reject) => {
			// "close", not "exit" — Node only guarantees the stdio streams have
			// fully drained by "close"; building the rejection off "exit" risked
			// racing a not-yet-flushed stderr chunk (empirically fine, but
			// unguaranteed by Node's own semantics).
			bootChild.on("close", (code) => {
				if (code !== null && code !== 0) {
					reject(new Error(`workerd exited early with code ${code}:\n${stderr}`));
				}
			});
		});

		const candidateBaseUrl = `http://127.0.0.1:${port}`;
		try {
			await Promise.race([waitUntilReady(candidateBaseUrl, 10_000), exitPromise]);
		} catch (err) {
			// bootWithPortRetry retries up to 3x now — a failed OR timed-out
			// attempt (e.g. a slow boot that never becomes ready) must never
			// leave a live workerd behind holding the port; kill defensively
			// (a no-op if the bind-race case already exited on its own).
			bootChild.kill();
			throw err instanceof Error ? new Error(`${err.message}\nstderr:\n${stderr}`) : err;
		}

		return { child: bootChild, baseUrl: candidateBaseUrl };
	});

	async function invoke(
		kind: "hook" | "route",
		name: string,
		body: unknown,
	): Promise<InvocationOutcome> {
		// NOT encodeURIComponent: route/hook names may themselves contain "/"
		// (e.g. "product-data/panel-state") or ":" (e.g. "content:afterSave"),
		// and sandbox-entry.ts's dispatcher takes everything after the
		// "/hook/"/"/route/" prefix verbatim (it does not decode segments).
		const res = await fetch(`${baseUrl}/${kind}/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return (await res.json()) as InvocationOutcome;
	}

	return {
		invokeHook: (name, event) => invoke("hook", name, event),
		invokeRoute: (name, input, request) => invoke("route", name, { input, request }),
		rawFetch: (pathname, init) => fetch(`${baseUrl}${pathname}`, init),
		async close() {
			child.kill();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve();
					return;
				}
				child.once("exit", () => resolve());
			});
			await rm(workDir, { recursive: true, force: true });
		},
	};
}
