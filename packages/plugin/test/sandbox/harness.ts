/**
 * Urumi's own workerd-on-Node sandbox test harness (plan §6 step 1).
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
		'export const URUMI_PLUGIN_ID = "urumi";',
		'export const URUMI_PLUGIN_VERSION = "0.1.0";',
		'export const URUMI_PLUGIN_CAPABILITIES = ["content:read", "network:request"];',
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
	const workDir = await mkdtemp(path.join(tmpdir(), "urumi-plugin-sandbox-"));
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
	const port = await findFreePort();
	await writeFile(configPath, capnpConfig(port, path.relative(workDir, bundlePath)), "utf8");

	const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
		WORKERD_BIN,
		["serve", "-I", CAPNP_IMPORT_ROOT, configPath],
		{ cwd: workDir, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exitPromise = new Promise<never>((_resolve, reject) => {
		child.on("exit", (code) => {
			if (code !== null && code !== 0) {
				reject(new Error(`workerd exited early with code ${code}:\n${stderr}`));
			}
		});
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	await Promise.race([waitUntilReady(baseUrl, 10_000), exitPromise]).catch((err) => {
		throw err instanceof Error ? new Error(`${err.message}\nstderr:\n${stderr}`) : err;
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
