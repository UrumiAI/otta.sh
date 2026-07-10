/**
 * The workerd-loaded worker module (plan §6 step 1). This is the actual
 * artifact `test/sandbox/harness.ts` bundles and boots inside a real
 * `workerd` process — it is Urumi's own minimal mirror of em-dash's
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
 * Urumi does not depend on `~/em-dash`'s internal `packages/workerd`
 * package (DEVELOPMENT.md preamble — standalone repo); this file plus
 * `test/sandbox/harness.ts` are Urumi's own from-scratch equivalent, proven
 * against a REAL `workerd` binary (the public `workerd` npm package), not a
 * simulation.
 */
import { ALLOWED_HOSTS } from "./manifest.js";
import plugin from "./plugin.js";
import type { HttpAccess, PluginContext, RouteEntry } from "./types.js";

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
					'Plugin "urumi" has no allowed hosts configured. Add hosts to allowedHosts to enable HTTP requests.',
				);
			}
			const hostname = new URL(url).hostname;
			if (!isHostAllowed(hostname, allowedHosts)) {
				throw new Error(
					`Plugin "urumi" is not allowed to fetch from host "${hostname}". Allowed hosts: ${allowedHosts.join(", ")}`,
				);
			}
			return globalThis.fetch(url, init);
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

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const ctx: PluginContext = { http: createHttpAccess(ALLOWED_HOSTS) };

		try {
			if (request.method === "POST" && url.pathname.startsWith("/hook/")) {
				const name = url.pathname.slice("/hook/".length);
				const entry = plugin.hooks?.[name as keyof typeof plugin.hooks];
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
				const entry: RouteEntry | undefined = plugin.routes?.[name];
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
