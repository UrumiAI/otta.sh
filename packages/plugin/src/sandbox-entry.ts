/**
 * The workerd-loaded worker module (plan §6 step 1). This is the actual
 * artifact `test/sandbox/harness.ts` bundles and boots inside a real
 * `workerd` process — it is Otta's own minimal mirror of em-dash's
 * `packages/workerd` bridge (`WorkerdSandboxRunner`/`createBridgeHandler`),
 * scoped to exactly what this plugin needs:
 *
 *  - dispatch `POST /hook/<name>` / `POST /route/<name>` to `plugin.ts`'s
 *    hooks/routes (mirrors `WorkerdSandboxedPlugin.invokeHook`/
 *    `invokeRoute`'s wire shape from `~/em-dash`'s `runner.ts`);
 *  - construct `ctx.http` exactly like em-dash's `createHttpAccess`
 *    (`context.ts:619-671`): reject any host not in `ALLOWED_HOSTS`
 *    (`isHostAllowed`, `context.ts:601-611` — exact-match or `*`/`*.sub`
 *    wildcard) BEFORE ever calling the real `fetch`.
 *  - no `content`/`media`/`users`/`email`/`storage` on `ctx` at all — this
 *    plugin never declares those capabilities (sandbox-clean guard).
 *
 * Otta does not depend on `~/em-dash`'s internal `packages/workerd`
 * package (DEVELOPMENT.md preamble — standalone repo); this file plus
 * `test/sandbox/harness.ts` are Otta's own from-scratch equivalent, proven
 * against a REAL `workerd` binary (the public `workerd` npm package), not a
 * simulation.
 */
import { ALLOWED_HOSTS } from "./manifest.js";
import plugin from "./plugin.js";
import type { HttpAccess, KvAccess, PluginContext, RouteEntry, SandboxedPlugin } from "./types.js";

function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
	for (const pattern of allowedHosts) {
		if (pattern === "*") return true;
		if (pattern.startsWith("*.")) {
			const bareDomain = pattern.slice(2);
			const suffix = pattern.slice(1); // ".example.com"
			if (hostname === bareDomain || hostname.endsWith(suffix)) return true;
		} else if (hostname === pattern) {
			return true;
		}
	}
	return false;
}

function createHttpAccess(allowedHosts: readonly string[]): HttpAccess {
	return {
		async fetch(url, init) {
			if (allowedHosts.length === 0) {
				throw new Error(
					'Plugin "otta" has no allowed hosts configured. Add hosts to allowedHosts to enable HTTP requests.',
				);
			}
			const hostname = new URL(url).hostname;
			if (!isHostAllowed(hostname, allowedHosts)) {
				throw new Error(
					`Plugin "otta" is not allowed to fetch from host "${hostname}". Allowed hosts: ${allowedHosts.join(", ")}`,
				);
			}
			return globalThis.fetch(url, init);
		},
	};
}

/**
 * The host's `ctx.kv` bridge, mirrored for the standalone sandbox the exact way
 * `createHttpAccess` mirrors `ctx.http`. In a real EmDash deploy `kv/*` bridges
 * to the host's `_plugin_storage` store (em-dash `emdash-runtime.ts:151-159`);
 * here it is an in-memory Map scoped to this worker boot. Module-scoped (not
 * per-request) so a value written by one route invocation is readable by the
 * next within the same worker — matching the host's persistence contract.
 * NON-SECRET display prefs only (§5); no secret is ever written here.
 */
function createKvAccess(store: Map<string, unknown>): KvAccess {
	return {
		async get<T>(key: string): Promise<T | null> {
			return store.has(key) ? (store.get(key) as T) : null;
		},
		async set(key: string, value: unknown): Promise<void> {
			store.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return store.delete(key);
		},
		async list(prefix?: string): Promise<Array<{ key: string; value: unknown }>> {
			const out: Array<{ key: string; value: unknown }> = [];
			for (const [key, value] of store) {
				if (prefix === undefined || key.startsWith(prefix)) out.push({ key, value });
			}
			return out;
		},
	};
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface RouteInvocationBody {
	input?: unknown;
	request?: { method?: string; url?: string; headers?: Record<string, string> };
}

/**
 * Build the workerd worker for a `SandboxedPlugin` descriptor. Extracted (review
 * round 2) so the sandbox test harness can boot a TEST-FIXTURE plugin (e.g. the
 * scaffold's synthetic 3-level screen, `admin/scaffold/testing/geo-entry.ts`)
 * under the exact same bridge — same `ctx.http` allowedHosts gate, same
 * module-scoped kv persistence contract — that production uses. The default
 * export below (the production entry) is `createSandboxWorker(plugin)`,
 * byte-identical in behavior to the pre-refactor inline version.
 */
export function createSandboxWorker(pluginDef: SandboxedPlugin) {
	// Module-boot-scoped (not per-request) so a value written by one route
	// invocation is readable by the next within the same worker — matching the
	// host's persistence contract.
	const kvStore = new Map<string, unknown>();

	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const ctx: PluginContext = {
				http: createHttpAccess(ALLOWED_HOSTS),
				kv: createKvAccess(kvStore),
			};

			try {
				if (request.method === "POST" && url.pathname.startsWith("/hook/")) {
					const name = url.pathname.slice("/hook/".length);
					const entry = pluginDef.hooks?.[name as keyof typeof pluginDef.hooks];
					if (entry === undefined) return jsonResponse({ error: `unknown hook: ${name}` }, 404);
					const event = await request.json();
					// The event's exact shape is per-hook (ContentHookEvent vs
					// ContentDeleteEvent); the dispatcher is intentionally untyped here,
					// each handler in sync/hooks.ts validates its own event shape.
					const result = await entry.handler(event as never, ctx);
					return jsonResponse({ result: result ?? null }, 200);
				}

				if (request.method === "POST" && url.pathname.startsWith("/route/")) {
					const name = url.pathname.slice("/route/".length);
					const entry: RouteEntry | undefined = pluginDef.routes?.[name];
					if (entry === undefined) return jsonResponse({ error: `unknown route: ${name}` }, 404);
					const handler = typeof entry === "function" ? entry : entry.handler;
					const body = (await request.json().catch(() => ({}))) as RouteInvocationBody;
					const result = await handler(
						{
							input: body.input ?? {},
							request: {
								method: body.request?.method ?? "POST",
								url: body.request?.url ?? url.pathname,
								headers: body.request?.headers ?? {},
							},
						},
						ctx,
					);
					return jsonResponse({ result }, 200);
				}

				return jsonResponse({ error: "not found" }, 404);
			} catch (err) {
				return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		},
	};
}

export default createSandboxWorker(plugin);
