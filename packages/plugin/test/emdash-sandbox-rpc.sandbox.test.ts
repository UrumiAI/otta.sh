/**
 * EmDash's REAL sandbox runner path, in real `workerd`: does each piece of the
 * plugin's egress — Stripe, x402, the email senders — reach the host through
 * `ctx.http.fetch` when the plugin runs SANDBOXED?
 *
 * In EmDash's sandboxed mode (`@emdash-cms/cloudflare` 1.0.1 `src/sandbox/runner.ts`)
 * a plugin runs in a Worker Loader isolate, and its `ctx.http.fetch(url, init)`
 * is the generated wrapper's `bridge.httpFetch(url, bridgeInit)`: a Workers RPC
 * call to the host's `PluginBridge` entrypoint, whose arguments are
 * structured-cloned. Since 1.0 the wrapper first buffers the request
 * (`bufferPluginHttpRequest`) and sends only its method, redirect mode, headers
 * and body; the answer comes back as a wire object the wrapper turns into a
 * `Response` again (`pluginHttpResponseFromWire`).
 * This suite boots the real `workerd` with that exact path:
 *
 * - a Worker Loader binding (`LOADER`), loading the plugin with the runner's own
 *   config: `compatibilityDate: "2026-04-01"`, no compatibility flags,
 *   `globalOutbound: null`, `env.BRIDGE` a loopback `ctx.exports.PluginBridge(…)`;
 * - EmDash's REAL generated wrapper as `plugin.js` (`generatePluginWrapper`, from
 *   the package's own source), and {@link ./sandbox/emdash-rpc-probe.ts} as
 *   `sandbox-plugin.js`;
 * - a `PluginBridge` whose `httpFetch` is EmDash's (`src/sandbox/bridge.ts`,
 *   `PluginBridge.httpFetch`): the props' capabilities and allowed hosts handed
 *   to the REAL `sandboxHttpFetch`, with no runner fetch callback (the runner
 *   passes one only when the site configures `httpFetch`). (The
 *   rest of EmDash's bridge needs D1; only `httpFetch` is under test, and the
 *   probe gives Stripe its fake secrets through an in-isolate kv.)
 * - the host's only outbound is a recording stub, so nothing reaches a real
 *   Stripe, facilitator or email provider. Every secret is a fake.
 *
 * MEASURED (workerd 1.20260710, EmDash 0.38): the RPC REFUSED an `AbortSignal`
 * in `init` — `DataCloneError: AbortSignal serialization is not enabled.` — so
 * a Stripe transport or email sender that put `AbortSignal.timeout(...)` in
 * `init` failed every call in sandboxed mode. They now race their own deadline
 * instead, and a signal travels only when the composition root says the host
 * is trusted (in-process).
 *
 * MEASURED (workerd 1.20260710, EmDash 1.0.1): the wrapper never forwards
 * `init.signal` — it is DROPPED silently, so the call goes through, and even an
 * already-aborted signal does not stop it. Nothing a plugin aborts reaches the
 * host's fetch, so the deadline race is still the only thing that bounds a call
 * under the runner (the slow-host cases below), and the `trustedHost` opt-in
 * is harmless here but buys nothing: its abort never leaves the isolate. If a
 * signal ever starts crossing (the first cases change), the opt-in could become
 * the default.
 *
 * Ported from the tax branch's R5e suite of the same name (same harness).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	startStubHttpServer,
	type RecordedRequest,
	type StubHttpServer,
} from "./helpers/stub-http-server.js";
import {
	bootWithPortRetry,
	CAPNP_IMPORT_ROOT,
	waitUntilReady,
	WORKERD_BIN,
} from "./sandbox/harness.js";
import {
	EMAIL_HOST,
	PROBE_HOST,
	SMTP2GO_HOST,
	STRIPE_HOST,
	X402_HOST,
} from "./sandbox/emdash-rpc-probe.js";

/** `@otta-sh/payments-x402`'s `SPEC_PAYER` (the x402 spec's example payer). */
const SPEC_PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The probe plugin's `allowedHosts`: every host its routes reach. */
const ALLOWED = [PROBE_HOST, STRIPE_HOST, X402_HOST, EMAIL_HOST, SMTP2GO_HOST];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The runner's own compatibility date for a loaded plugin (`src/sandbox/runner.ts`, 1.0.1). */
const RUNNER_COMPATIBILITY_DATE = "2026-04-01";

/**
 * `@emdash-cms/cloudflare` is not this package's dependency; `@otta-sh/store-emdash`
 * (a workspace dependency of the plugin) pins it at the version sites run.
 */
function emdashSandboxSources(): {
	wrapper: string;
	bridgeHttp: string;
	pluginTypes: string;
	httpWire: string;
} {
	const fromStore = createRequire(path.resolve(HERE, "../../store-emdash/package.json"));
	const cloudflareRoot = path.resolve(
		path.dirname(fromStore.resolve("@emdash-cms/cloudflare")),
		"..",
	);
	// The wrapper and `bridge-http.ts` import two things from `emdash`:
	// `normalizePluginCapabilities` from the root entry and the request/response
	// wire helpers from `emdash/internal/plugins/http-wire`. The root entry drags
	// in Astro and the whole CMS, so the build resolves each import to the one
	// small module that defines it: the core's `src/plugins/types.ts` (its value
	// imports are only `@emdash-cms/plugin-types`) and the published `http-wire`
	// entry (no imports at all).
	const fromCloudflare = createRequire(path.join(cloudflareRoot, "package.json"));
	const emdashRoot = path.resolve(path.dirname(fromCloudflare.resolve("emdash")), "..");
	return {
		wrapper: path.join(cloudflareRoot, "src/sandbox/wrapper.ts"),
		bridgeHttp: path.join(cloudflareRoot, "src/sandbox/bridge-http.ts"),
		pluginTypes: path.join(emdashRoot, "src/plugins/types.ts"),
		httpWire: fromCloudflare.resolve("emdash/internal/plugins/http-wire"),
	};
}

function hostSource(sources: ReturnType<typeof emdashSandboxSources>, pluginCode: string): string {
	return `
import { WorkerEntrypoint } from "cloudflare:workers";
import { generatePluginWrapper } from ${JSON.stringify(sources.wrapper)};
import { sandboxHttpFetch } from ${JSON.stringify(sources.bridgeHttp)};

const MANIFEST = {
	id: "probe",
	version: "1.0.0",
	capabilities: ["network:request"],
	allowedHosts: ${JSON.stringify(ALLOWED)},
	storage: {},
};
const PLUGIN = ${JSON.stringify(pluginCode)};
const WRAPPER = generatePluginWrapper(MANIFEST);

// EmDash's PluginBridge.httpFetch (src/sandbox/bridge.ts, 1.0.1), verbatim in
// what it does when the runner has no fetch callback.
export class PluginBridge extends WorkerEntrypoint {
	async httpFetch(url, init) {
		const { capabilities, allowedHosts } = this.ctx.props;
		return sandboxHttpFetch(url, init, { capabilities, allowedHosts });
	}
	async log() {}
}

export default {
	async fetch(request, env, ctx) {
		const route = new URL(request.url).pathname.match(/^\\/route\\/(.+)$/)?.[1];
		if (route === undefined) return new Response("ready");
		const input = await request.json();
		const bridge = ctx.exports.PluginBridge({
			props: {
				pluginId: MANIFEST.id,
				pluginVersion: MANIFEST.version,
				capabilities: MANIFEST.capabilities,
				allowedHosts: MANIFEST.allowedHosts,
				storageCollections: [],
			},
		});
		// The runner's loader config (src/sandbox/runner.ts, 1.0.1), field for field
		// (minus \`limits\`: this suite measures the transport, not resource limits).
		const worker = env.LOADER.get("probe:1.0.0", () => ({
			compatibilityDate: ${JSON.stringify(RUNNER_COMPATIBILITY_DATE)},
			mainModule: "plugin.js",
			modules: { "plugin.js": { js: WRAPPER }, "sandbox-plugin.js": { js: PLUGIN } },
			globalOutbound: null,
			env: { PLUGIN_ID: MANIFEST.id, PLUGIN_VERSION: MANIFEST.version, BRIDGE: bridge },
		}));
		try {
			const result = await worker
				.getEntrypoint("default")
				.invokeRoute(route, input, { url: request.url, method: "POST", headers: {} });
			return Response.json({ result });
		} catch (err) {
			return Response.json({ error: String(err) });
		}
	},
};
`;
}

function capnp(port: number, stubAddress: string): string {
	return [
		'using Workerd = import "/workerd/workerd.capnp";',
		"const config :Workerd.Config = (",
		"  services = [",
		'    (name = "main", worker = .hostWorker),',
		`    (name = "outbound", external = (address = "${stubAddress}", http = ())),`,
		"  ],",
		`  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],`,
		");",
		"const hostWorker :Workerd.Worker = (",
		'  modules = [ (name = "host.mjs", esModule = embed "dist/host.js") ],',
		`  compatibilityDate = "${RUNNER_COMPATIBILITY_DATE}",`,
		'  bindings = [ (name = "LOADER", workerLoader = ()) ],',
		'  globalOutbound = "outbound",',
		");",
		"",
	].join("\n");
}

describe("EmDash's sandbox runner: ctx.http.fetch over the PluginBridge RPC (real workerd)", () => {
	let workDir: string;
	let stub: StubHttpServer;
	let baseUrl: string;
	let stop: () => Promise<void>;

	beforeAll(async () => {
		stub = await startStubHttpServer();
		stub.respondWith("*", answer);
		workDir = await mkdtemp(path.join(tmpdir(), "otta-emdash-rpc-"));
		const sources = emdashSandboxSources();

		await build({
			entry: [path.join(HERE, "sandbox/emdash-rpc-probe.ts")],
			outDir: path.join(workDir, "probe"),
			format: ["esm"],
			dts: false,
			logLevel: "silent",
			noExternal: [/^@otta-sh\//],
		});
		const pluginCode = await readFile(path.join(workDir, "probe/emdash-rpc-probe.mjs"), "utf8");
		await writeFile(path.join(workDir, "host.js"), hostSource(sources, pluginCode), "utf8");
		await build({
			entry: [path.join(workDir, "host.js")],
			outDir: path.join(workDir, "dist"),
			format: ["esm"],
			dts: false,
			logLevel: "silent",
			platform: "neutral",
			external: ["cloudflare:workers"],
			noExternal: (id) => id !== "cloudflare:workers",
			plugins: [
				{
					name: "emdash-sandbox-sources",
					resolveId(id: string) {
						if (id === "emdash") return sources.pluginTypes;
						if (id === "emdash/internal/plugins/http-wire") return sources.httpWire;
						return null;
					},
				},
			],
		});

		const stubAddress = new URL(stub.baseUrl).host;
		const booted = await bootWithPortRetry(async (port) => {
			const configPath = path.join(workDir, "config.capnp");
			await writeFile(configPath, capnp(port, stubAddress), "utf8");
			// `--experimental`: workerd gates Worker Loader bindings behind it.
			const child = spawn(
				WORKERD_BIN,
				["serve", "--experimental", "-I", CAPNP_IMPORT_ROOT, configPath],
				{ cwd: workDir, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const exited = new Promise<never>((_resolve, reject) => {
				child.on("close", (code) => {
					reject(new Error(`workerd exited early with code ${String(code)}:\n${stderr}`));
				});
			});
			const url = `http://127.0.0.1:${String(port)}`;
			try {
				await Promise.race([waitUntilReady(url, 10_000), exited]);
			} catch (err) {
				child.kill();
				throw err;
			}
			return { child, url };
		});
		baseUrl = booted.url;
		stop = async () => {
			booted.child.kill();
			await new Promise<void>((resolve) => {
				if (booted.child.exitCode !== null || booted.child.signalCode !== null) resolve();
				else booted.child.once("exit", () => resolve());
			});
		};
	}, 120_000);

	afterAll(async () => {
		await stop?.();
		await stub?.close();
		if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
	});

	async function route(name: string, input: unknown = {}): Promise<unknown> {
		const res = await fetch(`${baseUrl}/route/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		return ((await res.json()) as { result?: unknown; error?: unknown }).result ?? res.status;
	}

	/** How long the stub holds back an answer, by `METHOD host/path`: a slow host.
	 *  Each case that sets one clears it. */
	const delays = new Map<string, number>();

	/** What each stubbed host answers. The isolate's ONLY way out is this stub
	 *  (`globalOutbound`), so no request can reach a real Stripe or provider. */
	function answer(req: RecordedRequest): { status: number; body: unknown; delayMs?: number } {
		const where = `${req.method} ${String(req.headers.host)}${req.url}`;
		const delayMs = delays.get(where);
		return delayMs === undefined ? answerNow(where) : { ...answerNow(where), delayMs };
	}

	function answerNow(where: string): { status: number; body: unknown } {
		switch (where) {
			case `GET ${PROBE_HOST}/ping`:
				return { status: 200, body: { pong: true } };
			case `GET ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1?expand[]=latest_charge`:
			case `GET ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1?expand%5B%5D=latest_charge`:
				return {
					status: 200,
					body: { latest_charge: { amount_refunded: 0, amount_captured: 1000, currency: "usd" } },
				};
			case `POST ${STRIPE_HOST}/v1/refunds`:
				return { status: 200, body: { id: "re_sandbox_1", amount: 500, currency: "usd" } };
			case `POST ${STRIPE_HOST}/v1/payment_intents`:
				return { status: 200, body: { id: "pi_late_1", client_secret: "pi_late_1_secret_x" } };
			case `POST ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1/cancel`:
				return { status: 200, body: { id: "pi_sandbox_1", status: "canceled" } };
			case `GET ${STRIPE_HOST}/v1/account`:
				return { status: 200, body: { id: "acct_sandbox", country: "IN" } };
			case `POST ${X402_HOST}/x402/verify`:
				return { status: 200, body: { isValid: true, payer: SPEC_PAYER } };
			case `POST ${EMAIL_HOST}/emails`:
				return { status: 200, body: { id: "em_sandbox_1" } };
			case `POST ${SMTP2GO_HOST}/v3/email/send`:
				return { status: 200, body: { data: { succeeded: 1, failed: 0 } } };
			default:
				return { status: 404, body: { error: `no stub for ${where}` } };
		}
	}

	function seen(): string[] {
		return stub.requests.map(
			(r) => `${r.method} ${String(r.headers.host)}${r.url.replaceAll("%5B%5D", "[]")}`,
		);
	}

	const PONG = 'status 200: {"pong":true}';

	test("an AbortSignal in init is dropped by the wrapper: the call reaches the host", async () => {
		stub.requests.length = 0;
		expect(await route("raw", { withSignal: true })).toBe(PONG);
		expect(seen()).toEqual([`GET ${PROBE_HOST}/ping`]);
	});

	test("even an already-aborted signal does not stop the call: the abort never leaves the isolate", async () => {
		stub.requests.length = 0;
		expect(await route("raw", { withSignal: true, aborted: true })).toBe(PONG);
		expect(seen()).toEqual([`GET ${PROBE_HOST}/ping`]);
	});

	test("the same call without a signal goes through the bridge to the host", async () => {
		stub.requests.length = 0;
		expect(await route("raw", { withSignal: false })).toBe(PONG);
		expect(seen()).toEqual([`GET ${PROBE_HOST}/ping`]);
	});

	test("a null-prototype init is accepted too (the wrapper rebuilds init before the RPC)", async () => {
		stub.requests.length = 0;
		expect(await route("raw", { nullPrototype: true })).toBe(PONG);
		expect(seen()).toEqual([`GET ${PROBE_HOST}/ping`]);
	});

	test("Stripe refund through the plugin's wiring: pre-flight and create both reach the host, keyed", async () => {
		stub.requests.length = 0;
		const result = JSON.parse(String(await route("stripeRefund"))) as Record<string, unknown>;
		expect(result).toMatchObject({ ok: true, refundRef: "re_sandbox_1" });
		expect(seen()).toEqual([
			`GET ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1?expand[]=latest_charge`,
			`POST ${STRIPE_HOST}/v1/refunds`,
		]);
		// Stripe's native idempotency key still travels on the create.
		expect(stub.requests[1]?.headers["idempotency-key"]).toBe("rf_sandbox_1");
		expect(stub.requests[1]?.headers["stripe-version"]).toBe("2024-06-20");
	});

	test("Stripe PaymentIntent cancel through the plugin's wiring reaches the host", async () => {
		stub.requests.length = 0;
		expect(JSON.parse(String(await route("stripeCancel")))).toEqual({
			ok: true,
			outcome: "cancelled",
		});
		expect(seen()).toEqual([`POST ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1/cancel`]);
		expect(stub.requests[0]?.headers["idempotency-key"]).toBe("cx_sandbox_1");
	});

	test("Stripe account-country read reaches the host", async () => {
		stub.requests.length = 0;
		expect(JSON.parse(String(await route("stripeAccount")))).toMatchObject({
			status: "known",
			country: "IN",
		});
		expect(seen()).toEqual([`GET ${STRIPE_HOST}/v1/account`]);
	});

	test("x402 /verify through the rail reaches the facilitator host", async () => {
		stub.requests.length = 0;
		expect(JSON.parse(String(await route("x402Verify")))).toMatchObject({ outcome: "valid" });
		expect(seen()).toEqual([`POST ${X402_HOST}/x402/verify`]);
	});

	test("the Resend sender reaches the host (its dedupe key travels)", async () => {
		stub.requests.length = 0;
		expect(await route("email", { provider: "resend" })).toBe("sent");
		expect(seen()).toEqual([`POST ${EMAIL_HOST}/emails`]);
		expect(stub.requests[0]?.headers["idempotency-key"]).toBe("outbox_row_1");
	});

	test("the SMTP2GO sender reaches the host", async () => {
		stub.requests.length = 0;
		expect(await route("email", { provider: "smtp2go" })).toBe("sent");
		expect(seen()).toEqual([`POST ${SMTP2GO_HOST}/v3/email/send`]);
	});

	// `trustedHost` puts a signal in init. Under 0.38's runner that failed every
	// call before the bridge; under 1.0.1's the signal is dropped and the call
	// goes through, still bounded by its own deadline. Only an IN-PROCESS host
	// gains anything from it.
	test("trustedHost under the sandbox runner: the Stripe refund still reaches the host (signal dropped)", async () => {
		stub.requests.length = 0;
		const result = JSON.parse(String(await route("stripeRefund", { trustedHost: true }))) as Record<
			string,
			unknown
		>;
		expect(result).toMatchObject({ ok: true, refundRef: "re_sandbox_1" });
		expect(seen()).toEqual([
			`GET ${STRIPE_HOST}/v1/payment_intents/pi_sandbox_1?expand[]=latest_charge`,
			`POST ${STRIPE_HOST}/v1/refunds`,
		]);
	});

	test("trustedHost under the sandbox runner: the email send still reaches the host (signal dropped)", async () => {
		stub.requests.length = 0;
		expect(await route("email", { provider: "resend", trustedHost: true })).toBe("sent");
		expect(seen()).toEqual([`POST ${EMAIL_HOST}/emails`]);
	});

	// A LATE answer under the runner. Nothing can abort the request (no signal
	// crosses the wrapper), so each call gives up at its own bound and classifies as
	// a timeout always did; whatever the host answers afterwards is discarded.
	describe("a host that answers after the call's bound", () => {
		test("a refund create answered late is UNVERIFIED at the bound, never TERMINAL; the create was keyed", async () => {
			stub.requests.length = 0;
			delays.set(`POST ${STRIPE_HOST}/v1/refunds`, 1_500);
			try {
				const out = JSON.parse(String(await route("slowRefund", { key: "rf_slow_1" }))) as {
					result: unknown;
					ms: number;
				};
				expect(out.result).toEqual({ ok: false, reason: "UNVERIFIED" });
				expect(out.ms).toBeGreaterThanOrEqual(300);
				expect(out.ms).toBeLessThan(1_000);
				const create = stub.requests.find((r) => r.url === "/v1/refunds");
				expect(create?.headers["idempotency-key"]).toBe("rf_slow_1");
				expect(stub.requests.filter((r) => r.url === "/v1/refunds")).toHaveLength(1);
			} finally {
				delays.clear();
				// Let the held answer go before the next case.
				await sleep(1_300);
			}
		});

		test("a late refund answer that reaches the isolate while the route runs on is discarded: still UNVERIFIED", async () => {
			stub.requests.length = 0;
			delays.set(`POST ${STRIPE_HOST}/v1/refunds`, 800);
			try {
				const out = JSON.parse(
					String(await route("slowRefund", { key: "rf_slow_2", lingerMs: 1_500 })),
				) as { result: unknown; ms: number };
				expect(out.result).toEqual({ ok: false, reason: "UNVERIFIED" });
				expect(out.ms).toBeLessThan(800);
				// The host did answer, while the route was still running.
				expect(stub.requests.find((r) => r.url === "/v1/refunds")?.answeredAt).toBeDefined();
			} finally {
				delays.clear();
			}
		});

		test("a PaymentIntent create answered late is a retryable failure at the bound", async () => {
			stub.requests.length = 0;
			delays.set(`POST ${STRIPE_HOST}/v1/payment_intents`, 1_500);
			try {
				const out = JSON.parse(String(await route("slowIntent"))) as {
					result: unknown;
					ms: number;
				};
				expect(out.result).toEqual({ name: "PaymentIntentError", retryable: true });
				expect(out.ms).toBeLessThan(1_000);
				expect(
					stub.requests.find((r) => r.url === "/v1/payment_intents")?.headers["idempotency-key"],
				).toBe("pi_slow_1");
			} finally {
				delays.clear();
				await sleep(1_300);
			}
		});

		test("a Resend send answered late is an EmailSendTimeoutError at the bound; its key travelled", async () => {
			stub.requests.length = 0;
			delays.set(`POST ${EMAIL_HOST}/emails`, 1_500);
			try {
				const started = Date.now();
				expect(
					await route("email", { provider: "resend", timeoutMs: 300, key: "outbox_row_slow" }),
				).toBe("threw EmailSendTimeoutError: email send abandoned after 300 ms");
				expect(Date.now() - started).toBeLessThan(1_000);
				expect(stub.requests.find((r) => r.url === "/emails")?.headers["idempotency-key"]).toBe(
					"outbox_row_slow",
				);
			} finally {
				delays.clear();
				await sleep(1_300);
			}
		});
	});
});
