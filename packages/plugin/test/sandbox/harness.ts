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
 * `manifest.ts` with the test's `allowedHosts`/`commerceServiceBaseUrl`
 * before bundling (plan §6 step 1 / §8 Risk 5), so `pnpm build`'s real
 * package output is never test-specific.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "../..");
const PLUGIN_SRC = path.join(PLUGIN_ROOT, "src");
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

export interface SandboxOptions {
	/** Hosts `ctx.http.fetch` is allowed to reach (plan §5). */
	allowedHosts: string[];
	/** Baked into the bundled plugin as `COMMERCE_SERVICE_BASE_URL`. */
	commerceServiceBaseUrl: string;
	/** Worker entry module, relative to `src/` (default the production
	 *  `sandbox-entry.ts`). Test fixtures under `src/**\/testing/` (e.g. the
	 *  scaffold's `admin/scaffold/testing/geo-entry.ts`) can be booted through
	 *  the same `createSandboxWorker` bridge by pointing here. */
	entry?: string;
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
 * between (INC-25). Node reports this as `EADDRINUSE`; workerd's own
 * stderr (surfaced via the "workerd exited early ..." error text) says
 * `bind(...): Address already in use`. Anything else is a real defect
 * and must not be retried.
 */
function isPortBindRace(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /EADDRINUSE/i.test(message) || /address already in use/i.test(message);
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
			if (!isPortBindRace(err) || attempt === maxAttempts) {
				if (attempt > 1 && err instanceof Error) {
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
	// from here). Includes the ADR-0007 write-gate token key + fail-closed kv
	// reader so the sandbox bundle resolves them exactly as production does.
	return [
		'export const OTTA_PLUGIN_ID = "otta";',
		'export const OTTA_PLUGIN_VERSION = "0.1.0";',
		'export const OTTA_PLUGIN_CAPABILITIES = ["content:read", "network:request"];',
		`export const COMMERCE_SERVICE_BASE_URL = ${JSON.stringify(options.commerceServiceBaseUrl)};`,
		`export const ALLOWED_HOSTS = ${JSON.stringify(options.allowedHosts)};`,
		'export const SERVICE_TOKEN_KEY = "settings:serviceToken";',
		"export async function serviceTokenFromKv(ctx) {",
		"\ttry {",
		"\t\tconst token = await ctx.kv.get(SERVICE_TOKEN_KEY);",
		"\t\treturn token !== null && token !== undefined && token.length > 0 ? token : undefined;",
		"\t} catch {",
		"\t\treturn undefined;",
		"\t}",
		"}",
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

export async function loadPluginInSandbox(options: SandboxOptions): Promise<SandboxHandle> {
	const workDir = await mkdtemp(path.join(tmpdir(), "otta-plugin-sandbox-"));
	const srcDir = path.join(workDir, "src");
	await cp(PLUGIN_SRC, srcDir, { recursive: true });
	await writeFile(path.join(srcDir, "manifest.ts"), manifestSource(options), "utf8");

	const entryRel = options.entry ?? "sandbox-entry.ts";
	const distDir = path.join(workDir, "dist");
	await build({
		entry: [path.join(srcDir, entryRel)],
		outDir: distDir,
		format: ["esm"],
		dts: false,
		logLevel: "silent",
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
			bootChild.on("exit", (code) => {
				if (code !== null && code !== 0) {
					reject(new Error(`workerd exited early with code ${code}:\n${stderr}`));
				}
			});
		});

		const candidateBaseUrl = `http://127.0.0.1:${port}`;
		await Promise.race([waitUntilReady(candidateBaseUrl, 10_000), exitPromise]).catch((err) => {
			throw err instanceof Error ? new Error(`${err.message}\nstderr:\n${stderr}`) : err;
		});

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
