import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

/**
 * `sites/store` pins `workerd` as a devDependency only so pnpm resolves the
 * Cloudflare adapter chain the way a merchant's npm install does: with the
 * workerd that the template's wrangler depends on. Without the pin, pnpm gave
 * `sites/store` and `sites/staging` different `@astrojs/cloudflare` variants, so
 * staging was not exactly the tree a merchant gets. Bumping wrangler means
 * bumping this pin with it.
 */
describe("the store's workerd pin", () => {
	test("matches the workerd that the installed wrangler depends on", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { devDependencies: Record<string, string> };
		const require = createRequire(new URL("../package.json", import.meta.url));
		const wrangler = require("wrangler/package.json") as {
			version: string;
			dependencies: Record<string, string>;
		};
		expect(
			manifest.devDependencies.workerd,
			`wrangler ${wrangler.version} depends on workerd ${wrangler.dependencies.workerd}`,
		).toBe(wrangler.dependencies.workerd);
	});
});
