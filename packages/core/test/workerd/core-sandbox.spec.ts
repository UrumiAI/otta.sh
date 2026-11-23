/**
 * Otta Core under EmDash's REAL sandbox, on workerd, over real D1.
 *
 *   pnpm -C packages/core test:sandbox
 *
 * Every other Core suite runs src/*.ts in Node against EmDash's storage
 * repository (test/harness.ts), a trusted in-process stand-in for the bridge.
 * This one proves the thing a registry install actually runs:
 *
 *  1. The BUILT plugin: `emdash-plugin bundle` (the registry tool, the same one
 *     `pnpm size` runs) writes the release tarball, and this suite loads the
 *     `backend.js` and `manifest.json` out of it, as EmDash's marketplace loader does.
 *  2. EmDash's own sandbox: `createSandboxRunner` and `PluginBridge` from
 *     `@emdash-cms/cloudflare/sandbox`, unmodified, in a host Worker on workerd
 *     (miniflare) with a Worker Loader binding. The plugin runs in a Worker Loader
 *     isolate with no outbound network of its own (`globalOutbound: null`), so
 *     every `ctx.*` is an RPC to the bridge.
 *  3. Real D1: the bridge stores documents, kv and encrypted settings in the
 *     miniflare D1 simulator, migrated by EmDash's `runMigrations`.
 *  4. The allowlist: `ctx.http.fetch` goes through the bridge's own host check
 *     (`allowedHosts: ["api.stripe.com"]` from the built manifest); only then does
 *     the host's fetch reach the fake Stripe, which miniflare's `outboundService`
 *     serves from this process (test/fixtures.ts `installFakeStripe`).
 *  5. The 30-call budget, counted on the host side of the bridge, per invocation
 *     (host.worker.js). Local workerd does not ENFORCE Worker Loader limits
 *     (ADR-0047, "What is not proven"), so this is a count, not an enforcement.
 *
 * Not part of `pnpm test` (its include is `test/**\/*.test.ts`): it builds the
 * bundle and boots workerd, so it is its own vitest project
 * (vitest.sandbox.config.ts) and its own CI step.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET, WHSEC, installFakeStripe, orderKey, type Harness } from "../fixtures.js";
import {
	CORE_ROOT,
	HOST_NODE_PATHS,
	loadEsbuild,
	loadMiniflare,
	type MiniflareInstance,
} from "./toolchain.js";

/** A registry install's plugin id: `r_` + 16 characters, never the slug (ADR-0047). */
const PLUGIN_ID = "r_0c0ffee0c0ffee00";
const SHOP = "https://shop.test";
const ROUTES = `${SHOP}/_emdash/api/plugins/${PLUGIN_ID}`;
/** A throwaway key, the same one CI's e2e job uses; never a real site's. */
const ENCRYPTION_KEY = "emdash_enc_v1_cugE5mpPbewXCXUpUxvpscThKOCTYMxr1Ro8lVSc_Ps";
const BUDGET = 30;

interface Calls {
	total: number;
	byMethod: Record<string, number>;
}
interface Outcome {
	result?: any;
	error?: string;
	calls: Calls;
}

// ── the built bundle ──────────────────────────────────────────────────────────

/** Minimal ustar reader (as scripts/size-gate.mjs): file name -> UTF-8 text. */
function untar(gz: Buffer): Map<string, string> {
	const tar = gunzipSync(gz);
	const files = new Map<string, string>();
	for (let off = 0; off + 512 <= tar.length;) {
		const header = tar.subarray(off, off + 512);
		if (header.every((b) => b === 0)) break;
		const name = header.subarray(0, 100).toString("utf8").split("\0")[0]!;
		const size = parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8);
		off += 512;
		files.set(name.replace(/^\.\//, ""), tar.subarray(off, off + size).toString("utf8"));
		off += Math.ceil(size / 512) * 512;
	}
	return files;
}

async function buildBundle(outDir: string): Promise<{ manifest: any; code: string }> {
	const cli = path.join(CORE_ROOT, "node_modules", ".bin", "emdash-plugin");
	const run = spawnSync(cli, ["bundle", "--dir", CORE_ROOT, "--out-dir", outDir], {
		encoding: "utf8",
	});
	if (run.status !== 0) throw new Error(`emdash-plugin bundle failed:\n${run.stdout}${run.stderr}`);
	const tarballs = (await readdir(outDir)).filter((f) => f.endsWith(".tar.gz"));
	if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(", ")}`);
	const files = untar(await readFile(path.join(outDir, tarballs[0]!)));
	const manifest = JSON.parse(files.get("manifest.json") ?? "null");
	const code = files.get("backend.js");
	if (!manifest || !code) throw new Error("the tarball has no manifest.json or backend.js");
	return { manifest: { ...manifest, id: PLUGIN_ID }, code };
}

// ── the host ──────────────────────────────────────────────────────────────────

/**
 * `emdash`'s Astro-only modules (`astro:*`, `virtual:emdash/*`) exist only inside an
 * Astro build. The bridge reaches them only on paths this host never takes (email
 * through the request middleware), so each becomes a stub that throws if it is used.
 */
const astroVirtualStubs = {
	name: "astro-virtual-stubs",
	setup(build: any) {
		build.onResolve({ filter: /^(astro:|virtual:)/ }, (args: { path: string }) => ({
			path: args.path,
			namespace: "astro-stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "astro-stub" }, (args: { path: string }) => ({
			loader: "js",
			contents: `module.exports = new Proxy({}, { get(_, k) { if (k === "__esModule") return false; throw new Error(${JSON.stringify("not available in the sandbox test host: ")} + ${JSON.stringify(args.path)} + "." + String(k)); } });`,
		}));
	},
};

async function bundleHost(outfile: string): Promise<void> {
	const esbuild = await loadEsbuild();
	const r = await esbuild.build({
		entryPoints: [path.join(CORE_ROOT, "test", "workerd", "host.worker.js")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "neutral",
		target: "es2023",
		mainFields: ["module", "main"],
		conditions: ["workerd", "worker", "import", "default"],
		external: ["cloudflare:*", "node:*"],
		nodePaths: HOST_NODE_PATHS,
		logLevel: "error",
		plugins: [astroVirtualStubs],
	});
	if (r.errors.length > 0) throw new Error("host worker bundle failed");
}

/** The fake Stripe from test/fixtures.ts, served over miniflare's outbound hook. */
function fakeStripeServer() {
	const routes: Array<{ method: string; prefix: string; handler: (req: any) => any }> = [];
	const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
	const harness = {
		http: {
			on: (method: string, prefix: string, handler: any) =>
				routes.push({ method, prefix, handler }),
		},
	} as unknown as Harness;
	const stripe = installFakeStripe(harness);
	async function outbound(request: Request): Promise<Response> {
		const url = request.url;
		requests.push({
			method: request.method,
			url,
			authorization: request.headers.get("authorization"),
		});
		const route = routes
			.filter((r) => (r.method === "*" || r.method === request.method) && url.startsWith(r.prefix))
			.toSorted((a, b) => b.prefix.length - a.prefix.length)[0];
		if (!route) return new Response(`no fake for ${request.method} ${url}`, { status: 599 });
		const headers: Record<string, string> = {};
		request.headers.forEach((v, k) => (headers[k] = v));
		const reply = await route.handler({
			url,
			method: request.method,
			headers,
			body: await request.text(),
		});
		return new Response(
			reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? ""),
			{
				status: reply.status ?? 200,
				headers: { "content-type": "application/json", ...reply.headers },
			},
		);
	}
	return { stripe, requests, outbound };
}

// ── the suite ─────────────────────────────────────────────────────────────────

let mf: MiniflareInstance;
let workDir: string;
const fake = fakeStripeServer();
const log: Array<{ what: string; calls: Calls }> = [];

async function post(url: string, body: unknown): Promise<any> {
	const res = await mf.dispatchFetch(url, { method: "POST", body: JSON.stringify(body) });
	const out = (await res.json()) as any;
	if (!res.ok) throw new Error(`${url}: ${out?.error ?? res.status}`);
	return out;
}
/** One invocation through the sandbox; records its bridge calls under `what`. */
async function invoke(what: string, res: Promise<Response>): Promise<Outcome> {
	const out = (await (await res).json()) as Outcome;
	log.push({ what, calls: out.calls });
	if (out.error) throw new Error(`${what}: ${out.error}`);
	return out;
}
const hook = (name: string, event: unknown) =>
	invoke(
		`hook ${name}`,
		mf.dispatchFetch(`${SHOP}/__hook/${encodeURIComponent(name)}`, {
			method: "POST",
			body: JSON.stringify(event),
		}),
	);
const doc = async (collection: string, id: string) =>
	(await post(`${SHOP}/__doc`, { collection, id })).doc;

beforeAll(async () => {
	workDir = await mkdtemp(path.join(tmpdir(), "otta-core-sandbox-"));
	const { manifest, code } = await buildBundle(path.join(workDir, "bundle"));
	const hostPath = path.join(workDir, "host.mjs");
	await bundleHost(hostPath);
	const Miniflare = await loadMiniflare();
	mf = new Miniflare({
		// One explicit module: the bundle keeps EmDash's lazy `import()`s, which
		// miniflare's module scanner refuses to follow.
		modulesRoot: workDir,
		modules: [{ type: "ESModule", path: hostPath }],
		// The reference site's own date and flags (sites/staging/wrangler.jsonc), as the
		// store's D1 tier does; the plugin isolate gets the runner's own date.
		compatibilityDate: "2026-02-24",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: ["DB"],
		workerLoaders: { LOADER: {} },
		bindings: { EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY },
		outboundService: fake.outbound,
	});
	await mf.ready;
	const loaded = await post(`${SHOP}/__load`, { manifest, code });
	expect(loaded).toEqual({ ok: true, available: true });
}, 120_000);

afterAll(async () => {
	await mf?.dispose();
	if (workDir) await rm(workDir, { recursive: true, force: true });
	if (log.length > 0)
		process.stderr.write(
			`[core-sandbox] bridge calls per invocation (budget ${BUDGET}):\n${log
				.map(
					(l) =>
						`  ${String(l.calls.total).padStart(2)}  ${l.what}  ${JSON.stringify(l.calls.byMethod)}`,
				)
				.join("\n")}\n`,
		);
});

describe("Otta Core, built, in EmDash's Worker Loader sandbox over D1", () => {
	const key = orderKey(1);

	it("install schedules the sweep through the bridge", async () => {
		await hook("plugin:install", {});
		const { tasks } = await post(`${SHOP}/__cron`, {});
		expect(tasks).toEqual([
			expect.objectContaining({
				task_name: "sweep",
				schedule: "*/5 * * * *",
				plugin_id: PLUGIN_ID,
			}),
		]);
	});

	it("settings saved by the host are what the plugin reads", async () => {
		await post(`${SHOP}/__settings`, {
			stripeSecretKey: SECRET,
			stripeWebhookSecret: WHSEC,
			currency: "USD",
			flatShipping: 500,
		});
		// Stored by EmDash's settings access in its options table, the secrets
		// encrypted at rest (EMDASH_ENCRYPTION_KEY): no plaintext key in D1.
		const { rows } = await post(`${SHOP}/__options`, {});
		const stored = JSON.stringify(rows);
		expect(stored).toContain("stripeSecretKey");
		expect(stored).not.toContain(SECRET);
		expect(stored).not.toContain(WHSEC);
	});

	it("a published product is synced by the content hook", async () => {
		await hook("content:afterPublish", {
			collection: "products",
			content: {
				id: "p1",
				status: "published",
				updatedAt: "2026-11-22T00:00:00.000Z",
				data: { title: "Sandbox mug", price: 10, stock: 5 },
			},
		});
		expect(await doc("stock", "p1")).toMatchObject({ onHand: 5, holds: {} });
		expect(await doc("products", "p1")).toMatchObject({ active: true });
	});

	it("checkout holds stock and opens a Checkout Session on (fake) api.stripe.com", async () => {
		const out = await invoke(
			"route checkout",
			mf.dispatchFetch(`${ROUTES}/checkout`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-otta-checkout": "1",
					"cf-connecting-ip": "203.0.113.7",
				},
				body: JSON.stringify({ key, lines: [{ productId: "p1", qty: 2 }] }),
			}),
		);
		expect(out.result).toMatchObject({ ok: true, orderId: key });
		expect(out.result.url).toBe(fake.stripe.only().url);
		// The only egress is the allowlisted host, with the key the plugin decrypted.
		expect(fake.requests.length).toBeGreaterThan(0);
		for (const r of fake.requests) {
			expect(r.url.startsWith("https://api.stripe.com/")).toBe(true);
			expect(r.authorization).toBe(`Bearer ${SECRET}`);
		}
		expect(await doc("orders", key)).toMatchObject({
			status: "pending",
			stock: "held",
			total: 2500,
		});
		expect(await doc("stock", "p1")).toMatchObject({ onHand: 5, holds: { [key]: 2 } });
	});

	it("a signed webhook settles the payment, verified inside the isolate", async () => {
		const session = fake.stripe.complete(fake.stripe.only().id);
		const event = await fake.stripe.event("checkout.session.completed", session.id);
		const deliver = () =>
			invoke(
				"route stripe/webhook",
				mf.dispatchFetch(`${ROUTES}/stripe/webhook`, {
					method: "POST",
					headers: { "stripe-signature": event.sig },
					body: new Uint8Array(event.body),
				}),
			);
		const first = await deliver();
		expect(first.result.status).toBe(200);
		expect(JSON.parse(first.result.body.value)).toEqual({ received: true, outcome: "paid" });
		// Stripe redelivers: the replay is a no-op, the stock does not move twice.
		const replay = await deliver();
		expect(replay.result.status).toBe(200);
		expect(await doc("stock", "p1")).toMatchObject({ onHand: 3, holds: {} });
	});

	it("the order lookup shows the buyer a paid order", async () => {
		const orderDoc = await doc("orders", key);
		const out = await invoke(
			"route order",
			mf.dispatchFetch(`${ROUTES}/order?id=${key}&key=${orderDoc.orderKey}`),
		);
		expect(out.result).toMatchObject({
			ok: true,
			order: { id: key, status: "paid", amountPaid: 2500 },
		});
	});

	it("one cron sweep leaves the paid order and its stock alone", async () => {
		await hook("cron", { name: "sweep", scheduledAt: new Date().toISOString() });
		expect(await doc("orders", key)).toMatchObject({
			status: "paid",
			stock: "committed",
			stockPending: 0,
			amountPaid: 2500,
		});
		expect(await doc("stock", "p1")).toMatchObject({ onHand: 3, holds: {} });
	});

	it(`no invocation passed ${BUDGET} bridge calls`, () => {
		expect(log.length).toBeGreaterThanOrEqual(7);
		for (const l of log) expect(l.calls.total, l.what).toBeLessThanOrEqual(BUDGET);
		// The counter really counts: checkout alone makes several storage calls.
		expect(log.find((l) => l.what === "route checkout")!.calls.total).toBeGreaterThan(5);
	});
});
