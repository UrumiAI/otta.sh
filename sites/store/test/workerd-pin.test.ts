import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

/**
 * `sites/store` and `sites/staging` pin `workerd` (the catalog's `workerd`
 * entry in `pnpm-workspace.yaml`) so pnpm resolves the Cloudflare adapter chain
 * the way a merchant's npm install does: with the workerd that the template's
 * wrangler depends on. Without the pin, pnpm gave the two sites different
 * `@astrojs/cloudflare` / `@emdash-cms/cloudflare` variants, so staging was not
 * the tree a merchant gets. Bumping wrangler means bumping the pin with it.
 *
 * `packages/store-emdash` (the D1 test tier) intentionally resolves its own
 * variant and is not compared here.
 */
const repoFile = (name: string) => new URL(`../../../${name}`, import.meta.url);
const read = (name: string) => readFileSync(repoFile(name), "utf8");

/** The `version:` strings of `names` in one `importers:` entry of pnpm-lock.yaml. */
function importerVersions(lock: string, importer: string, names: string[]) {
	const start = lock.indexOf("\nimporters:\n");
	const section = lock.slice(start + 1);
	const lines = section.split("\n");
	const out: Record<string, string | undefined> = {};
	let inImporter = false;
	let current: string | undefined;
	for (const line of lines.slice(1)) {
		if (/^\S/.test(line)) break; // next top-level key
		const head = /^ {2}(\S.*):$/.exec(line);
		if (head) {
			inImporter = head[1]!.replace(/^'|'$/g, "") === importer;
			current = undefined;
			continue;
		}
		if (!inImporter) continue;
		const dep = /^ {6}(\S.*):$/.exec(line);
		if (dep) {
			current = dep[1]!.replace(/^'|'$/g, "");
			continue;
		}
		const version = /^ {8}version: (.*)$/.exec(line);
		if (version && current && names.includes(current)) out[current] = version[1];
	}
	return out;
}

describe("the workerd pin", () => {
	test("equals the workerd that the installed wrangler depends on", () => {
		const catalog = /^catalog:\n(?:[ \t].*\n|\n)*/m.exec(read("pnpm-workspace.yaml"))?.[0] ?? "";
		const pinned = /^ {2}workerd: ["']?([^"'\s#]+)/m.exec(catalog)?.[1];
		const require = createRequire(import.meta.url);
		const wrangler = require("wrangler/package.json") as {
			version: string;
			dependencies: Record<string, string>;
		};
		expect(
			pinned,
			`pnpm-workspace.yaml catalog \`workerd\` must equal wrangler ${wrangler.version}'s dependency ` +
				`(${wrangler.dependencies.workerd}): set \`workerd: ${wrangler.dependencies.workerd}\` in the catalog, run pnpm install`,
		).toBe(wrangler.dependencies.workerd);
	});

	test("both sites declare it from the catalog", () => {
		for (const site of ["sites/staging", "sites/store"]) {
			const manifest = JSON.parse(read(`${site}/package.json`)) as {
				devDependencies: Record<string, string>;
			};
			expect(
				manifest.devDependencies.workerd,
				`${site}/package.json needs "workerd": "catalog:" in devDependencies, or pnpm resolves a different adapter variant there`,
			).toBe("catalog:");
		}
	});

	test("sites/staging and sites/store resolve the same Cloudflare adapter variants", () => {
		const lock = read("pnpm-lock.yaml");
		const names = ["@astrojs/cloudflare", "@emdash-cms/cloudflare"];
		const staging = importerVersions(lock, "sites/staging", names);
		const store = importerVersions(lock, "sites/store", names);
		for (const name of names) {
			expect(staging[name], `sites/staging has no ${name} in pnpm-lock.yaml`).toBeTruthy();
			expect(
				store[name],
				`sites/store resolves ${name} as ${store[name]} but sites/staging as ${staging[name]}: ` +
					"the workerd pins differ or drifted; align `workerd` in the pnpm-workspace.yaml catalog " +
					"with wrangler's workerd and run pnpm install",
			).toBe(staging[name]);
		}
	});
});
