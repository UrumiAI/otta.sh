/**
 * The HOST side of Otta Core's real-sandbox tier: a minimal EmDash 1.5 host
 * Worker, run by miniflare on workerd (see `core-sandbox.spec.ts`).
 *
 * Everything that touches the plugin is EmDash's own code, unmodified:
 *  - `createSandboxRunner` from `@emdash-cms/cloudflare/sandbox`: the Worker
 *    Loader runner a registry install uses. It loads the BUILT `backend.js` into
 *    a Worker Loader isolate (`env.LOADER`) with `globalOutbound: null`, the
 *    30-subrequest / 50 ms limits, and its generated wrapper as the main module.
 *  - `PluginBridge` from the same package: the loopback entrypoint every
 *    `ctx.*` call from the isolate lands on. It is re-exported here under the
 *    name the runner looks up (`exports.PluginBridge`), as a site's worker does.
 *    Storage, kv and settings go through EmDash's real repositories on `env.DB`
 *    (D1), `ctx.http.fetch` through its real allowlist check (`allowedHosts`).
 *  - `runMigrations` from `emdash/db`: the host schema on that D1 database.
 *
 * What this file adds is only what an EmDash site would otherwise do around the
 * runner (route input parsing as `route-wire.ts` does it, header filtering), and
 * a COUNTER: the subclass below counts every bridge method the isolate calls,
 * per invocation, so the test can assert the 30-call budget from the host side
 * (local workerd does not enforce Worker Loader limits, ADR-0047).
 *
 * Plain JS on purpose: `cloudflare:workers` has no types in packages/core, and
 * this file is bundled by esbuild, never type-checked or run by Node.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { exports as workerExports } from "cloudflare:workers";
import {
	createSandboxRunner,
	PluginBridge as EmDashPluginBridge,
} from "@emdash-cms/cloudflare/sandbox";
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { runMigrations } from "emdash/db";
import { Kysely } from "kysely";

// ── the bridge-call counter ──────────────────────────────────────────────────

/**
 * The runner's own default (`DEFAULT_LIMITS.subrequests` in
 * `@emdash-cms/cloudflare/sandbox`). Worker Loader enforces it on Cloudflare; local
 * workerd does not (measured: 60 bridge calls in one invocation pass), so this host
 * enforces it the way production does: call 31 throws inside the plugin.
 */
const SUBREQUEST_LIMIT = 30;

/** Bridge methods the generated wrapper calls (one RPC each, `ctx.log` included). */
const counted = { total: 0, byMethod: {} };
const inside = new AsyncLocalStorage();

/**
 * EmDash's PluginBridge with every public method counted ONCE per RPC: a bridge
 * method that calls another one internally (`settingsGet` -> `kvGet`) is still one
 * call, because the inner call runs inside the outer one's async context.
 */
export class PluginBridge extends EmDashPluginBridge {}
const INTERNAL = new Set([
	"constructor",
	"db",
	"requireCapability",
	"validateCollection",
	"contentAccess",
	"getOptionsRepo",
	"getKVAccess",
	"getSettingsAccess",
	"deleteLegacyKV",
	"readSiteWriteFence",
	"assertSiteWriteAllowed",
	"getStorageRepo",
	"observeSecretSetting",
	"mediaStorage",
]);
for (const name of Object.getOwnPropertyNames(EmDashPluginBridge.prototype)) {
	const original = EmDashPluginBridge.prototype[name];
	if (INTERNAL.has(name) || typeof original !== "function") continue;
	PluginBridge.prototype[name] = function (...args) {
		if (inside.getStore() === true) return original.apply(this, args);
		counted.total++;
		if (counted.total > SUBREQUEST_LIMIT)
			throw new Error(
				`Too many subrequests: bridge call ${counted.total} (${name}) is over ${SUBREQUEST_LIMIT}`,
			);
		counted.byMethod[name] = (counted.byMethod[name] ?? 0) + 1;
		return inside.run(true, () => original.apply(this, args));
	};
}

function takeCalls() {
	const out = { total: counted.total, byMethod: { ...counted.byMethod } };
	counted.total = 0;
	counted.byMethod = {};
	return out;
}

// ── the host ─────────────────────────────────────────────────────────────────

const SITE = { name: "Sandbox Shop", url: "https://shop.test", locale: "en" };
/** Headers EmDash strips before a sandboxed route sees them (request-meta.ts). */
const STRIPPED = new Set(["cookie", "authorization", "proxy-authorization", "x-emdash-request"]);

let runner;
let loaded;
let manifest;

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The bridge props the runner hands its own binding (runner.ts createWorker). */
function bridgeProps(m) {
	return {
		pluginId: m.id,
		pluginVersion: m.version || "0.0.0",
		capabilities: m.capabilities ?? [],
		allowedHosts: m.allowedHosts ?? [],
		storageCollections: Object.keys(m.storage ?? {}),
		siteInfo: SITE,
		storageConfig: m.storage,
		settingsSchema: m.admin?.settingsSchema,
	};
}

/** Route input exactly as EmDash's route-wire parses it for a declared route. */
async function routeInput(request, decl) {
	if (decl.body === "none") {
		const input = {};
		const params = new URL(request.url).searchParams;
		for (const key of new Set(params.keys())) {
			const values = params.getAll(key);
			input[key] = values.length > 1 ? values : values[0];
		}
		return input;
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (decl.body === "bytes") return bytes;
	if (decl.body === "json") return JSON.parse(new TextDecoder().decode(bytes));
	throw new Error(`unsupported body kind in this host: ${decl.body}`);
}

function sandboxHeaders(request, declared) {
	const allowed = new Set((declared ?? []).map((h) => h.toLowerCase()));
	const out = {};
	request.headers.forEach((value, key) => {
		if (!STRIPPED.has(key) && !key.startsWith("cf-access-") && allowed.has(key)) out[key] = value;
	});
	return out;
}

/**
 * The failure the spec reports: the error's own text, never its stack. The stack
 * goes to the worker's console, which miniflare prints in the test output.
 */
function failure(error) {
	console.error(error?.stack ?? error);
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Run one plugin invocation and report its result with its own bridge-call count. */
async function invocation(run) {
	takeCalls();
	try {
		const result = await run();
		return json({ result: result ?? null, calls: takeCalls() });
	} catch (error) {
		return json({ error: failure(error), calls: takeCalls() });
	}
}

export default {
	async fetch(request, env) {
		try {
			return await handle(request, env);
		} catch (error) {
			return json({ error: failure(error) }, 500);
		}
	},
};

async function handle(request, env) {
	const url = new URL(request.url);
	const db = new Kysely({ dialect: createDialect({ binding: "DB" }) });

	// Test control plane (uncounted: nothing here goes through the isolate).
	if (url.pathname === "/__load") {
		const body = await request.json();
		await runMigrations(db);
		manifest = body.manifest;
		runner ??= createSandboxRunner({ db, siteInfo: SITE });
		loaded = await runner.load(manifest, body.code);
		return json({ ok: true, available: runner.isAvailable() });
	}
	if (url.pathname === "/__settings") {
		// What the admin's settings form does: the host's settings access (secrets
		// encrypted with EMDASH_ENCRYPTION_KEY), reached through the same bridge.
		takeCalls();
		const bridge = workerExports.PluginBridge({ props: bridgeProps(manifest) });
		for (const [key, value] of Object.entries(await request.json()))
			await bridge.settingsSet(key, value);
		takeCalls();
		return json({ ok: true });
	}
	if (url.pathname === "/__doc") {
		const { collection, id } = await request.json();
		const row = await env.DB.prepare(
			"SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
		)
			.bind(manifest.id, collection, id)
			.first();
		return json({ doc: row ? JSON.parse(row.data) : null });
	}
	if (url.pathname === "/__options") {
		// The rows the settings access wrote for this plugin, raw (secrets as stored).
		const rows = await env.DB.prepare("SELECT name, value FROM options WHERE name LIKE ?")
			.bind(`%${manifest.id}%`)
			.all();
		return json({ rows: rows.results ?? [] });
	}
	if (url.pathname === "/__cron") {
		const rows = await env.DB.prepare(
			"SELECT task_name, schedule, plugin_id FROM _emdash_cron_tasks WHERE plugin_id = ?",
		)
			.bind(manifest.id)
			.all();
		return json({ tasks: rows.results ?? [] });
	}
	if (url.pathname.startsWith("/__hook/")) {
		const name = decodeURIComponent(url.pathname.slice("/__hook/".length));
		const event = await request.json();
		return invocation(() => loaded.invokeHook(name, event));
	}

	// A plugin route, at the path EmDash mounts it on.
	const prefix = `/_emdash/api/plugins/${manifest?.id}/`;
	if (manifest && url.pathname.startsWith(prefix)) {
		const name = url.pathname.slice(prefix.length);
		const decl = manifest.routes?.find((r) => r.name === name);
		if (!decl) return json({ error: `no route ${name}` }, 404);
		if (decl.methods && !decl.methods.includes(request.method)) return json({}, 405);
		const input = await routeInput(request, decl.request ?? { body: "json" });
		return invocation(() =>
			loaded.invokeRoute(name, input, {
				url: request.url,
				method: request.method,
				headers: sandboxHeaders(request, decl.request?.headers),
				meta: {
					ip: request.headers.get("cf-connecting-ip"),
					userAgent: null,
					referer: null,
					geo: null,
				},
			}),
		);
	}
	return json({ error: "not found" }, 404);
}
