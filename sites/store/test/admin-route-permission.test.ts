/**
 * #478 (from #474): `admin-route-dispatch.sandbox.test.ts` pins that Otta's admin
 * route declares no `permission`. That is safe only because of what EmDash does
 * with such a route, which this suite proves on the INSTALLED emdash: its real
 * route-meta builder and its real dispatch policy, fed Otta's real admin route.
 * A private route with no `permission` requires `plugins:manage`, the role level
 * the site's download-upload guard copies as `UPLOAD_MIN_ROLE`. If an EmDash
 * upgrade changes that default, this fails, rather than the guard's threshold
 * silently drifting from what the route requires.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plugin } from "@urumi.ai/otta-plugin";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { UPLOAD_MIN_ROLE } from "../src/lib/download-upload.js";

/**
 * One function from the INSTALLED emdash's dist, by its source name. EmDash's
 * public entry for these (`emdash/internal/plugin-test-runtime`) also loads its
 * whole runtime, which imports an Astro-generated virtual module, so the chunk
 * that defines the function is loaded on its own: found by file prefix, and the
 * export read by the alias its `export { name as x }` line gives it.
 */
async function emdashFunction<F>(chunkPrefix: string, name: string): Promise<F> {
	const dist = new URL(
		"dist/",
		pathToFileURL(
			realpathSync(fileURLToPath(new URL("../node_modules/emdash/package.json", import.meta.url))),
		),
	);
	const files = readdirSync(dist).filter(
		(file) => file.startsWith(chunkPrefix) && file.endsWith(".mjs"),
	);
	if (files.length !== 1) throw new Error(`emdash dist: ${chunkPrefix}*.mjs is ${String(files)}`);
	const url = new URL(files[0] as string, dist);
	const alias = new RegExp(`\\b${name} as (\\w+)`).exec(readFileSync(url, "utf8"))?.[1];
	if (alias === undefined) throw new Error(`emdash dist: ${name} is not exported`);
	const mod = (await import(url.href)) as Record<string, unknown>;
	return mod[alias] as F;
}

type BuildRouteMeta = (route: object) => Record<string, unknown>;
type Dispatch = (input: Record<string, unknown>) => Promise<Response>;
let buildRouteMeta: BuildRouteMeta;
let dispatchPluginApiRequest: Dispatch;

beforeAll(async () => {
	// The trusted-plugin path of `getPluginRouteMeta` is `buildRouteMeta(route)`.
	buildRouteMeta = await emdashFunction<BuildRouteMeta>("routes-", "buildRouteMeta");
	dispatchPluginApiRequest = await emdashFunction<Dispatch>(
		"http-route-dispatch-",
		"dispatchPluginApiRequest",
	);
}, 60_000);

/** Just enough of a runtime for dispatch: EmDash's own route meta for Otta's
 *  real routes, and a handler that records it ran. */
function runtimeFor(handled: () => void) {
	return {
		getPluginRouteMeta: (_pluginId: string, path: string) => {
			const route = (plugin.routes as Record<string, object> | undefined)?.[path];
			return route === undefined ? null : buildRouteMeta(route);
		},
		handlePluginApiRoute: async () => {
			handled();
			return { success: true, data: {}, status: 200 };
		},
	};
}

async function dispatchAs(role: number) {
	const handled = vi.fn();
	const response = await dispatchPluginApiRequest({
		runtime: runtimeFor(handled),
		pluginId: "otta",
		path: "admin",
		request: new Request("https://shop.example/_emdash/api/plugins/otta/admin", {
			method: "POST",
			headers: { "X-EmDash-Request": "1", "Content-Type": "application/json" },
			body: "{}",
		}),
		user: { id: "u", email: "u@example.com", name: null, role, createdAt: new Date(0) },
	});
	const body = (await response.json()) as { error?: { code?: string } };
	return {
		status: response.status,
		code: body.error?.code,
		handled: handled.mock.calls.length > 0,
	};
}

describe("EmDash's default permission for Otta's admin route (#478)", () => {
	test("the route EmDash builds from Otta's admin entry is private and carries no permission", () => {
		const meta = runtimeFor(() => undefined).getPluginRouteMeta("otta", "admin");
		expect(meta).toMatchObject({ public: false });
		expect(meta).not.toHaveProperty("permission");
	});

	test("so EmDash requires plugins:manage: one role below UPLOAD_MIN_ROLE is refused, at it the handler runs", async () => {
		// FORBIDDEN is the permission check's refusal; the request carries the CSRF
		// header, so it is not that check's CSRF_REJECTED.
		expect(await dispatchAs(UPLOAD_MIN_ROLE - 10)).toEqual({
			status: 403,
			code: "FORBIDDEN",
			handled: false,
		});
		expect(await dispatchAs(UPLOAD_MIN_ROLE)).toEqual({
			status: 200,
			code: undefined,
			handled: true,
		});
	});
});
