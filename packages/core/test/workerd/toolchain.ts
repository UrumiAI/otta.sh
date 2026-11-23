/**
 * The workerd toolchain for Otta Core's real-sandbox tier, BORROWED from the
 * reference site rather than declared here.
 *
 * `sites/staging` is the EmDash site Otta deploys on Cloudflare; its `wrangler`
 * (and the `miniflare`, `workerd` and `esbuild` that wrangler pins) and its
 * `@emdash-cms/cloudflare` are exactly what a real site runs plugins with. Resolving
 * them from there keeps packages/core's manifest and the lockfile untouched (Core's
 * only runtime peer stays `emdash`), and makes this tier move whenever the site's
 * toolchain moves. If the site ever drops one of them, `resolveFromSite` fails
 * loudly with the package it could not find.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORE_ROOT = path.resolve(HERE, "../..");
export const SITE_ROOT = path.resolve(CORE_ROOT, "../../sites/staging");

const fromSite = createRequire(path.join(SITE_ROOT, "package.json"));
/** wrangler's own dependencies (miniflare, esbuild) sit beside its real path. */
const fromWrangler = createRequire(fromSite.resolve("wrangler"));

function resolveFrom(req: NodeRequire, id: string, where: string): string {
	try {
		return req.resolve(id);
	} catch (cause) {
		throw new Error(`core sandbox tier: cannot resolve ${id} from ${where}`, { cause });
	}
}

/** Directories esbuild may resolve the host worker's bare imports from. */
export const HOST_NODE_PATHS = [
	path.join(SITE_ROOT, "node_modules"),
	path.join(CORE_ROOT, "node_modules"),
];

// The subset of each API this tier uses, typed here because the packages are not
// dependencies of packages/core (so their own types do not resolve from it).
export interface EsbuildApi {
	build(options: Record<string, unknown>): Promise<{ errors: unknown[] }>;
}
export interface MiniflareInstance {
	ready: Promise<URL>;
	dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
	dispose(): Promise<void>;
}
export type MiniflareCtor = new (options: Record<string, unknown>) => MiniflareInstance;

export async function loadEsbuild(): Promise<EsbuildApi> {
	return (await import(resolveFrom(fromWrangler, "esbuild", "wrangler"))) as EsbuildApi;
}
export async function loadMiniflare(): Promise<MiniflareCtor> {
	const mod = (await import(resolveFrom(fromWrangler, "miniflare", "wrangler"))) as {
		Miniflare: MiniflareCtor;
	};
	return mod.Miniflare;
}
